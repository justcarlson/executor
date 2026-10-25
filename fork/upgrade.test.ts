import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { command, git, parseRequest, runtimeIds } from "./upgrade";
import {
  registry,
  fixture,
  tag,
  run,
  write,
  commit,
  decodeSelection,
  receiptPath,
  learnResolution,
  root,
  type Fixture,
} from "./testing";

const expectUpstreamedOnNextUpgrade = (f: Fixture, first: Effect.Success<ReturnType<typeof run>>) =>
  Effect.gen(function* () {
    const series = first.report.nextSeries?.ref ?? "missing-series";
    const candidate = first.report.candidate?.commit ?? "missing-candidate";
    yield* git(
      f.repo,
      "fetch",
      first.candidateRepo,
      `refs/tags/${series}:refs/tags/${series}`,
      candidate,
    );
    const source = yield* git(f.repo, "rev-parse", "main");
    const bridge = yield* git(
      f.repo,
      "commit-tree",
      `${candidate}^{tree}`,
      "-p",
      source,
      "-p",
      candidate,
      "-m",
      "Land candidate",
    );
    yield* git(f.repo, "merge", "--no-ff", bridge, "-m", "Merge landing");
    yield* git(
      f.repo,
      "tag",
      "-a",
      "fork-release/landed",
      "-m",
      `Land release\n\nFork-Series: ${series}`,
    );
    const second = yield* run(f, "next-upgrade", [], { defaultSeries: true });
    const feature = second.report.features.find((feature) => feature.id === "tool-usage");
    process.stdout.write(
      `TO6 ${first.report.features.find((entry) => entry.id === "tool-usage")?.commits[0]?.rerere ? "rerere" : "plain"} second status=${second.report.status} available=${feature?.available} production=${feature?.production}\n`,
    );
    expect(feature?.replay).toBe("upstream-marker");
    expect(feature?.commits.map((pick) => pick.result)).toEqual(["upstream-marker"]);
    expect(second.stdout).toContain("(upstream-marker)");
    expect(feature?.available).toBe(true);
    expect(feature?.production).toBe(true);
    expect(second.report.status).toBe("READY_FOR_REVIEW");
    const selection = decodeSelection(
      fs.readFileSync(join(second.candidateRepo, receiptPath), "utf8"),
    );
    expect(selection.available).toContain("tool-usage");
    expect(selection.production).toContain("tool-usage");
    const nextSeries = second.report.nextSeries?.ref ?? "missing-series";
    const markers = yield* git(
      second.candidateRepo,
      "log",
      "--format=%s",
      "--grep=^Record upstreamed fork feature tool-usage$",
      `${f.base}..${nextSeries}`,
    );
    expect(markers.split("\n").filter(Boolean)).toEqual([
      "Record upstreamed fork feature tool-usage",
    ]);
  });

describe("fork upgrade", () => {
  it.effect("requires an annotated release for the default series", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* write(f.repo, "release.ts", "export const release = true;\n");
      yield* git(f.repo, "add", ".");
      yield* git(f.repo, "commit", "-m", "Release commit\n\nFork-Series: fork-series/fixture");
      yield* git(f.repo, "tag", "fork-release/lightweight");
      const result = yield* run(f, "lightweight-release", [], { defaultSeries: true });
      expect(result.code).toBe(2);
      expect(result.report.reason).toContain(
        "Release tag must be annotated. Pass --series explicitly",
      );
      expect(fs.existsSync(result.candidateRepo)).toBe(false);
    }),
  );

  it.effect("stops with a fetch command when the local remote-tracking branch is missing", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const remote = join(f.dir, "remote.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      yield* git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
      yield* git(f.repo, "update-ref", "-d", "refs/remotes/origin/main");
      const result = yield* run(f, "missing-tracking-branch", ["--source", "origin/main"]);
      expect(result.code).toBe(2);
      expect(result.report.freshness.status).toBe("stale");
      expect(result.report.reason).toContain("git fetch --tags 'origin'");
      expect(fs.existsSync(result.candidateRepo)).toBe(false);
    }),
  );
  it.effect("restarts once for each conflicting feature and removes both whole features", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* write(f.repo, "features/tool-usage.ts", "export const value = 'upstream';\n");
      yield* write(f.repo, "features/secret-key-cache.ts", "export const value = 'upstream';\n");
      yield* git(f.repo, "add", ".");
      yield* git(f.repo, "commit", "-m", "Upstream changes two features");
      yield* tag(f);
      const result = yield* run(f, "two-conflicts");
      expect(result.code, result.stdout).toBe(0);
      expect(result.report.passes).toHaveLength(3);
      expect(result.report.passes.map((pass) => pass.conflict?.feature ?? null)).toEqual([
        "secret-key-cache",
        "tool-usage",
        null,
      ]);
      const selection = decodeSelection(
        fs.readFileSync(join(result.candidateRepo, receiptPath), "utf8"),
      );
      expect(selection.available).not.toContain("tool-usage");
      expect(selection.available).not.toContain("secret-key-cache");
      expect(
        yield* git(
          result.candidateRepo,
          "log",
          "--format=%B",
          "--grep=^Fork-Feature: tool-usage$",
          `${f.base}..${result.report.nextSeries?.ref}`,
        ),
      ).toBe("");
      expect(
        yield* git(
          result.candidateRepo,
          "log",
          "--format=%B",
          "--grep=^Fork-Feature: secret-key-cache$",
          `${f.base}..${result.report.nextSeries?.ref}`,
        ),
      ).toBe("");
    }),
  );

  it.effect("selects the default series from the source release annotation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(
        f.repo,
        "tag",
        "-a",
        "fork-release/fixture",
        "-m",
        "Release\n\nFork-Series: fork-series/fixture",
      );
      yield* git(f.repo, "tag", "-a", "fork-series/unreleased", "-m", "Unreleased proof");
      const refs = yield* git(f.repo, "for-each-ref");
      const status = yield* git(f.repo, "status", "--porcelain");
      const config = fs.readFileSync(join(f.repo, ".git/config"));
      const index = fs.readFileSync(join(f.repo, ".git/index"));
      const result = yield* run(f, "default-series", [], { defaultSeries: true });
      expect(result.code, result.stdout).toBe(0);
      expect(result.report.series?.ref).toBe("fork-series/fixture");
      expect(result.report.drift.release?.ref).toBe("fork-release/fixture");
      expect(result.report.drift.source).toEqual({ ref: "main", commit: f.base });
      expect(result.report.freshness.status).toBe("not-checked");
      expect(yield* git(f.repo, "for-each-ref")).toBe(refs);
      expect(yield* git(f.repo, "status", "--porcelain")).toBe(status);
      expect(fs.readFileSync(join(f.repo, ".git/config"))).toEqual(config);
      expect(fs.readFileSync(join(f.repo, ".git/index"))).toEqual(index);
      expect(result.report.requiredReview).toEqual([
        "env -u EXECUTOR_FORK_FEATURES EXECUTOR_FORK_PROFILE=production-v1 bun run --cwd e2e test:selfhost scenarios/fork-",
      ]);
      expect(fs.readFileSync(join(result.output, "report.md"), "utf8")).toContain(
        result.report.requiredReview[0],
      );
    }),
  );
  it.effect("requires an explicit series without a release tag", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const result = yield* run(f, "no-release", [], { defaultSeries: true });
      expect(result.code).toBe(2);
      expect(result.report.reason).toContain("Pass --series explicitly");
      expect(fs.existsSync(result.candidateRepo)).toBe(false);
    }),
  );
  it.effect("requires an explicit series when the release annotation has no series", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(f.repo, "tag", "-a", "fork-release/fixture", "-m", "Release without a series");
      const result = yield* run(f, "missing-series-line", [], { defaultSeries: true });
      expect(result.code).toBe(2);
      expect(result.report.reason).toContain("Fork-Series line");
      expect(fs.existsSync(result.candidateRepo)).toBe(false);
    }),
  );
  it.effect("requires an explicit series when the release names a missing tag", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(
        f.repo,
        "tag",
        "-a",
        "fork-release/fixture",
        "-m",
        "Release\n\nFork-Series: fork-series/missing",
      );
      const result = yield* run(f, "missing-series-tag", [], { defaultSeries: true });
      expect(result.code).toBe(2);
      expect(result.report.reason).toContain("does not exist. Pass --series explicitly");
    }),
  );
  it.effect("ignores release tags outside the source first-parent history", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(
        f.repo,
        "tag",
        "-a",
        "fork-release/landed",
        "-m",
        "Release\n\nFork-Series: fork-series/fixture",
      );
      yield* git(
        f.repo,
        "tag",
        "-a",
        "fork-release/unlanded",
        "series",
        "-m",
        "Unlanded release\n\nFork-Series: fork-series/missing",
      );
      const result = yield* run(f, "first-parent", [], { defaultSeries: true });
      expect(result.code, result.stdout).toBe(0);
      expect(result.report.drift.release?.ref).toBe("fork-release/landed");
    }),
  );
  it.effect("stops before cloning when the remote branch is newer", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const remote = join(f.dir, "remote.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      yield* git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
      yield* git(remote, "update-ref", "refs/heads/main", "refs/heads/series");
      const refs = yield* git(f.repo, "for-each-ref");
      const result = yield* run(f, "stale-source", ["--source", "origin/main"]);
      expect(result.code).toBe(2);
      expect(result.report.freshness.status).toBe("stale");
      expect(result.report.reason).toContain("git fetch --tags 'origin'");
      expect(fs.existsSync(result.candidateRepo)).toBe(false);
      expect(yield* git(f.repo, "for-each-ref")).toBe(refs);
    }),
  );
  it.effect("checks remote tags and allows local-only proof tags without source writes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const remote = join(f.dir, "remote.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      yield* git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
      yield* git(f.repo, "tag", "-a", "fork-series/local-only", "-m", "Local proof");
      const refs = yield* git(f.repo, "for-each-ref");
      const index = fs.readFileSync(join(f.repo, ".git/index"));
      const config = fs.readFileSync(join(f.repo, ".git/config"));
      const result = yield* run(f, "fresh-source", ["--source", "origin/main"]);
      expect(result.code, result.stdout).toBe(0);
      expect(result.report.freshness.status).toBe("fresh");
      expect(yield* git(f.repo, "for-each-ref")).toBe(refs);
      expect(yield* git(f.repo, "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(join(f.repo, ".git/index"))).toEqual(index);
      expect(fs.readFileSync(join(f.repo, ".git/config"))).toEqual(config);
      yield* git(remote, "update-ref", "refs/tags/fork-series/remote-only", "refs/heads/series");
      const stale = yield* run(f, "missing-remote-tag", ["--source", "origin/main"]);
      expect(stale.code).toBe(2);
      expect(stale.report.reason).toContain("fork-series/remote-only is missing locally");
      expect(fs.existsSync(stale.candidateRepo)).toBe(false);
      yield* git(f.repo, "fetch", "--tags", "origin");
      yield* git(remote, "update-ref", "refs/tags/fork-series/remote-only", f.base);
      const moved = yield* run(f, "moved-remote-tag", ["--source", "origin/main"]);
      expect(moved.code).toBe(2);
      expect(moved.report.freshness.status).toBe("stale");
    }),
  );
  it.effect("stops before cloning when the source remote cannot be read", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(f.repo, "remote", "add", "origin", pathToFileURL(join(f.dir, "missing.git")).href);
      const result = yield* run(f, "unreadable-remote", ["--source", "origin/main"]);
      expect(result.code).toBe(2);
      expect(result.report.freshness.status).toBe("unreadable");
      expect(result.report.reason).toContain("git fetch --tags 'origin'");
      expect(fs.existsSync(result.candidateRepo)).toBe(false);
    }),
  );
  it.effect(
    "fetches a missing upstream tag from a local file upstream only into the candidate",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* tag(f);
        const remote = join(f.dir, "upstream.git");
        yield* git(f.repo, "clone", "--bare", f.repo, remote);
        yield* git(f.repo, "tag", "-d", "v9.1.0");
        const refs = yield* git(f.repo, "for-each-ref");
        const result = yield* run(f, "fetched-tag", [], {
          upstreamUrl: pathToFileURL(remote).href,
        });
        expect(result.code, result.stdout).toBe(0);
        expect(result.report.upstream.commit).toBe(f.base);
        expect(yield* git(result.candidateRepo, "rev-parse", "refs/tags/v9.1.0")).toBe(f.base);
        expect(yield* git(f.repo, "for-each-ref")).toBe(refs);
      }),
  );

  it.effect("keeps a later-conflict feature absent across two upgrades", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* git(f.repo, "switch", "series");
      yield* write(f.repo, "fixup.ts", "export const fixup = 'fixed';\n");
      yield* commit(f.repo, "tool-usage", "Fix tool usage");
      yield* git(
        f.repo,
        "tag",
        "-a",
        "fork-series/later-conflict",
        "-m",
        `Later conflict\n\nFork-Upstream: ${f.base}`,
      );
      yield* git(f.repo, "switch", "main");
      yield* write(f.repo, "fixup.ts", "export const fixup = 'upstream';\n");
      yield* git(f.repo, "add", ".");
      yield* git(f.repo, "commit", "-m", "Upstream changes fixup");
      yield* tag(f);
      const first = yield* run(f, "later-conflict", ["--series", "fork-series/later-conflict"]);
      expect(first.code, first.stdout).toBe(0);
      const nextSeries = first.report.nextSeries?.ref ?? "missing-series";
      yield* git(
        f.repo,
        "fetch",
        first.candidateRepo,
        `refs/tags/${nextSeries}:refs/tags/${nextSeries}`,
      );
      const second = yield* run(f, "second-upgrade", ["--series", nextSeries]);
      expect(second.code, second.stdout).toBe(0);
      expect(second.report.features.find((feature) => feature.id === "tool-usage")?.available).toBe(
        false,
      );
      const selection = decodeSelection(
        fs.readFileSync(join(second.candidateRepo, receiptPath), "utf8"),
      );
      expect(selection.production).not.toContain("tool-usage");
      expect(first.report.features.find((feature) => feature.id === "tool-usage")?.available).toBe(
        false,
      );
      expect(first.report.passes).toHaveLength(2);
      expect(first.report.passes[0]?.conflict?.feature).toBe("tool-usage");
      expect(first.report.passes[0]?.conflict?.paths).toEqual(["fixup.ts"]);
      expect(first.report.passes[1]?.conflict).toBe(null);
      expect(
        fs.readFileSync(join(first.candidateRepo, "features/tool-usage.ts"), "utf8"),
      ).toContain("base-tool-usage");
      expect(
        yield* git(
          first.candidateRepo,
          "log",
          "--format=%B",
          "--grep=^Fork-Feature: tool-usage$",
          `${f.base}..${nextSeries}`,
        ),
      ).toBe("");
      expect(
        fs.readFileSync(join(second.candidateRepo, "features/tool-usage.ts"), "utf8"),
      ).toContain("base-tool-usage");
    }),
  );

  it.effect("keeps an already-upstream empty pick available across two upgrades", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* write(f.repo, "features/tool-usage.ts", "export const value = 'fork-tool-usage';\n");
      yield* git(f.repo, "add", ".");
      yield* git(f.repo, "commit", "-m", "Adopt tool usage upstream");
      yield* tag(f);
      const result = yield* run(f, "already-upstream");
      expect(result.report.reason).toBe(null);
      expect(result.code, result.stdout).toBe(0);
      const feature = result.report.features.find((feature) => feature.id === "tool-usage");
      expect(feature?.commits.map((pick) => pick.result)).toEqual(["already-upstream"]);
      expect(feature?.available).toBe(true);
      yield* expectUpstreamedOnNextUpgrade(f, result);
    }),
  );

  it.effect("keeps an empty rerere resolution available across two upgrades", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f, "tool-usage");
      const seed = join(f.dir, "seed");
      yield* git(f.repo, "clone", "--local", f.repo, seed);
      const sha = yield* git(
        f.repo,
        "log",
        "--format=%H",
        "--grep=^Fork-Feature: tool-usage$",
        "fork-series/fixture",
        "-1",
      );
      const conflicted = yield* command(seed, [
        "git",
        "-c",
        "rerere.enabled=true",
        "cherry-pick",
        "-x",
        sha,
      ]);
      expect(conflicted.code).toBe(1);
      yield* write(seed, "features/tool-usage.ts", "export const value = 'upstream';\n");
      yield* git(seed, "-c", "rerere.enabled=true", "rerere");
      yield* git(seed, "cherry-pick", "--abort");
      const result = yield* run(f, "empty-rerere", ["--rerere-cache", join(seed, ".git/rr-cache")]);
      expect(result.code, result.stdout).toBe(0);
      const feature = result.report.features.find((feature) => feature.id === "tool-usage");
      expect(feature?.commits.map((pick) => pick.result)).toEqual(["already-upstream"]);
      expect(feature?.commits[0]?.rerere).toBe(true);
      expect(feature?.available).toBe(true);
      yield* expectUpstreamedOnNextUpgrade(f, result);
    }),
  );

  it.effect("rejects unknown and duplicate feature lines in drift", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(f.repo, "tag", "fork-release/fixture");
      yield* write(f.repo, "bad.ts", "export const bad = true;\n");
      yield* git(f.repo, "add", ".");
      yield* git(
        f.repo,
        "commit",
        "-m",
        "Bad labels\n\nFork-Feature: tool-usage\nFork-Feature: unknown extra",
      );
      const result = yield* run(f, "bad-labels", ["--source", "HEAD"]);
      expect(result.code).toBe(2);
      expect(result.report.drift.blocked).toHaveLength(1);
    }),
  );
  it.effect("rejects merge commits in first-parent drift even when labelled", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(f.repo, "tag", "fork-release/fixture");
      yield* git(f.repo, "switch", "-c", "fix");
      yield* write(f.repo, "fix.ts", "export const fix = true;\n");
      yield* commit(f.repo, "tool-usage");
      yield* git(f.repo, "switch", "main");
      yield* write(f.repo, "other.ts", "export const other = true;\n");
      yield* commit(f.repo, "tool-usage");
      yield* git(f.repo, "merge", "--no-ff", "fix", "-m", "Merge fix\n\nFork-Feature: tool-usage");
      const result = yield* run(f, "merge", ["--source", "HEAD"]);
      expect(result.code).toBe(2);
      expect(result.report.drift.blocked).toHaveLength(1);
    }),
  );
  it.effect("rejects a lightweight series tag", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(f.repo, "tag", "fork-series/lightweight", "series");
      const result = yield* run(f, "lightweight", ["--series", "fork-series/lightweight"]);
      expect(result.code).toBe(2);
      expect(result.report.reason).toContain("must be annotated");
    }),
  );
  it.effect("rejects a dirty source without changing its index", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* write(f.repo, "dirty.ts", "export const dirty = true;\n");
      const index = fs.readFileSync(join(f.repo, ".git/index"));
      const output = join(f.dir, "dirty-output");
      const result = yield* command(f.repo, [
        "bun",
        "run",
        join(root, "fork/upgrade.ts"),
        "v9.1.0",
        "--out",
        output,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("must be clean");
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readFileSync(join(f.repo, ".git/index"))).toEqual(index);
    }),
  );
  it.effect("does not overwrite an existing output directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const output = join(f.dir, "existing");
      fs.mkdirSync(output);
      fs.writeFileSync(join(output, "keep"), "keep");
      const result = yield* command(f.repo, [
        "bun",
        "run",
        join(root, "fork/upgrade.ts"),
        "v9.1.0",
        "--out",
        output,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("must not exist");
      expect(fs.readFileSync(join(output, "keep"), "utf8")).toBe("keep");
    }),
  );
  it.effect("rejects another runtime list that disagrees with the SDK schema", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        runtimeIds(registry.replace('"tool-usage",', '"different-id",')),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
  it.effect("rejects configured remote caching before running build gates", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* git(f.repo, "switch", "series");
      yield* write(
        f.repo,
        "turbo.json",
        '{"remoteCache":{"apiUrl":"https://cache.example.invalid"}}\n',
      );
      yield* commit(f.repo, "fork-tooling");
      yield* git(
        f.repo,
        "tag",
        "-a",
        "fork-series/cache",
        "-m",
        `Remote cache series\n\nFork-Upstream: ${f.base}`,
      );
      yield* git(f.repo, "switch", "main");
      yield* tag(f);
      const result = yield* run(f, "cache", ["--series", "fork-series/cache"]);
      expect(result.code).toBe(1);
      expect(result.report.status).toBe("FAILED_GATES");
      expect(result.report.gates.map((gate) => gate.name)).toEqual(["cache"]);
    }),
  );
  it.effect(
    "replays a complete series, writes only three receipt fields, and separates the series tag",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* tag(f);
        const before = yield* git(f.repo, "rev-parse", "HEAD");
        const index = fs.readFileSync(join(f.repo, ".git/index"));
        const result = yield* run(f, "complete", ["--test-arg=first", "--test-arg=second"]);
        expect(result.code, result.stdout).toBe(0);
        expect(result.report.status).toBe("READY_FOR_REVIEW");
        expect(result.report.gates.every((entry) => entry.result === "pass")).toBe(true);
        expect(result.report.lockfileDrift).toBe(true);
        expect(result.report.drift.skipped).toBe(true);
        const selection = decodeSelection(
          fs.readFileSync(join(result.candidateRepo, receiptPath), "utf8"),
        );
        expect(Object.keys(selection).sort()).toEqual([
          "available",
          "production",
          "upstreamCommit",
        ]);
        expect(selection.available).toEqual(f.ids);
        expect(selection.production).toEqual(f.ids);
        expect(yield* git(result.candidateRepo, "rev-parse", "HEAD^")).toBe(
          result.report.nextSeries?.commit,
        );
        expect(
          yield* git(result.candidateRepo, "diff", "--name-only", "fork-series/fixture", "HEAD"),
        ).toBe(receiptPath);
        expect(fs.readFileSync(join(result.output, "logs/test.log"), "utf8")).toContain(
          "first second",
        );
        expect(yield* git(f.repo, "rev-parse", "HEAD")).toBe(before);
        expect(fs.readFileSync(join(f.repo, ".git/index"))).toEqual(index);
      }),
  );

  it.effect("omits a conflicting runtime feature and skips its later fixup", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* git(f.repo, "switch", "series");
      yield* write(f.repo, "later.ts", "export const later = true;\n");
      yield* commit(f.repo, "tool-usage");
      yield* git(
        f.repo,
        "tag",
        "-a",
        "fork-series/fixup",
        "-m",
        `Fixup series\n\nFork-Upstream: ${f.base}`,
      );
      yield* git(f.repo, "switch", "main");
      yield* tag(f, "tool-usage");
      const result = yield* run(f, "conflict", ["--series", "fork-series/fixup"]);
      expect(result.code, result.stdout).toBe(0);
      expect(result.report.status).toBe("REDUCED_FEATURE_SET");
      const feature = result.report.features.find((feature) => feature.id === "tool-usage");
      expect(feature?.replay).toBe("conflict-omitted");
      expect(feature?.commits.map((commit) => commit.result)).toEqual([
        "conflict-omitted",
        "conflict-omitted",
      ]);
      expect(
        result.report.features.find((feature) => feature.id === "secret-key-cache")?.replay,
      ).toBe("applied");
      const selection = decodeSelection(
        fs.readFileSync(join(result.candidateRepo, receiptPath), "utf8"),
      );
      expect(selection.available).not.toContain("tool-usage");
      expect(fs.existsSync(join(result.candidateRepo, "later.ts"))).toBe(false);
    }),
  );

  it.effect("blocks a foundation conflict", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f, "foundation");
      const result = yield* run(f, "foundation-conflict");
      expect(result.code).toBe(2);
      expect(result.report.status).toBe("BLOCKED_REPLAY");
      expect(result.report.reason).toContain("Required feature foundation conflicted");
    }),
  );
  it.effect("blocks a tooling conflict", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f, "fork-tooling");
      const result = yield* run(f, "tooling-conflict");
      expect(result.code).toBe(2);
      expect(result.report.status).toBe("BLOCKED_REPLAY");
    }),
  );
  it.effect("blocks drift without a feature trailer", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(f.repo, "tag", "fork-release/fixture");
      yield* write(f.repo, "drift.ts", "export const drift = true;\n");
      yield* git(f.repo, "add", ".");
      yield* git(f.repo, "commit", "-m", "Unlabelled fix");
      const sha = yield* git(f.repo, "rev-parse", "HEAD");
      const result = yield* run(f, "unlabelled", ["--source", "HEAD"]);
      expect(result.code).toBe(2);
      expect(result.report.status).toBe("BLOCKED_REPLAY");
      expect(result.report.drift.blocked[0]).toContain(sha);
    }),
  );
  it.effect("replays labelled drift after the series and also omits drift fixups", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      yield* git(f.repo, "tag", "fork-release/fixture");
      yield* write(f.repo, "drift.ts", "export const drift = true;\n");
      const sha = yield* commit(f.repo, "tool-usage");
      const result = yield* run(f, "labelled", ["--source", "HEAD"]);
      expect(result.code, result.stdout).toBe(0);
      expect(result.report.drift.commits.map((commit) => commit.sha)).toEqual([sha]);
      expect(fs.existsSync(join(result.candidateRepo, "drift.ts"))).toBe(true);
      const omitted = yield* run(f, "omit-drift", ["--source", "HEAD", "--omit", "tool-usage"]);
      expect(omitted.code).toBe(0);
      expect(fs.existsSync(join(omitted.candidateRepo, "drift.ts"))).toBe(false);
    }),
  );
  it.effect("keeps off-feature source and omits selected-feature source", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const result = yield* run(f, "selection", [
        "--off",
        "tool-usage",
        "--omit",
        "secret-key-cache",
      ]);
      expect(result.code).toBe(0);
      expect(result.report.status).toBe("REDUCED_FEATURE_SET");
      const selection = decodeSelection(
        fs.readFileSync(join(result.candidateRepo, receiptPath), "utf8"),
      );
      expect(selection.available).toContain("tool-usage");
      expect(selection.production).not.toContain("tool-usage");
      expect(selection.available).not.toContain("secret-key-cache");
      expect(
        fs.readFileSync(join(result.candidateRepo, "features/secret-key-cache.ts"), "utf8"),
      ).toContain("base-secret-key-cache");
    }),
  );
  it.effect("rejects omission of required features", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const result = yield* run(f, "required", ["--omit", "foundation"]);
      expect(result.code).toBe(2);
      expect(result.report.reason).toContain("cannot be omitted");
    }),
  );
  it.effect("returns failed gates when a real command fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* git(f.repo, "switch", "series");
      yield* write(
        f.repo,
        "package.json",
        `${JSON.stringify({ scripts: { bootstrap: "git status --short", "format:check": "git status --short", lint: "git status --short", typecheck: "git status --short", test: "bun -e 'process.exit(7)'" } })}\n`,
      );
      yield* commit(f.repo, "fork-tooling");
      yield* git(
        f.repo,
        "tag",
        "-a",
        "fork-series/failing",
        "-m",
        `Failing series\n\nFork-Upstream: ${f.base}`,
      );
      yield* git(f.repo, "switch", "main");
      yield* tag(f);
      const result = yield* run(f, "failed", ["--series", "fork-series/failing"]);
      expect(result.code).toBe(1);
      expect(result.report.status).toBe("FAILED_GATES");
      expect(result.report.gates.find((gate) => gate.name === "test")?.result).toBe("fail");
    }),
  );
  it.effect("uses an explicitly learned rerere resolution without auto-staging other paths", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f, "tool-usage");
      const seed = join(f.dir, "seed");
      yield* git(f.repo, "clone", "--local", f.repo, seed);
      yield* git(seed, "config", "user.name", "Fixture maintainer");
      yield* git(seed, "config", "user.email", "fixture@example.invalid");
      const sha = yield* git(
        f.repo,
        "log",
        "--format=%H",
        "--grep=^Fork-Feature: tool-usage$",
        "fork-series/fixture",
        "-1",
      );
      const conflicted = yield* command(seed, [
        "git",
        "-c",
        "rerere.enabled=true",
        "-c",
        "rerere.autoupdate=false",
        "cherry-pick",
        "-x",
        sha,
      ]);
      expect(conflicted.code).toBe(1);
      yield* learnResolution(seed);
      const result = yield* run(f, "rerere", ["--rerere-cache", join(seed, ".git/rr-cache")]);
      expect(result.code, result.stdout).toBe(0);
      expect(result.report.features.find((feature) => feature.id === "tool-usage")?.replay).toBe(
        "resolved-by-rerere",
      );
      expect(
        fs.readFileSync(join(result.candidateRepo, "features/tool-usage.ts"), "utf8"),
      ).toContain("reviewed-resolution");
    }),
  );
  it.effect("rejects prerelease tags and keeps repeatable test arguments in order", () =>
    Effect.gen(function* () {
      const invalid = yield* Effect.exit(parseRequest(["v1.2.3-rc.1", "--out", "/unused"], root));
      expect(Exit.isFailure(invalid)).toBe(true);
      const valid = yield* parseRequest(
        ["v1.2.3", "--out", "/unused", "--test-arg=--env-mode=loose", "--test-arg", "--another"],
        root,
      );
      expect(valid.testArgs).toEqual(["--env-mode=loose", "--another"]);
    }),
  );
});
