import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  command,
  createReport,
  git,
  markdownReport,
  parseMatrixRequest,
  parseRequest,
  planReplay,
} from "./upgrade";
import { budgets, upstreamUrl, type Feature } from "./shared";
import { replayPriority } from "./replay";
import { commit, decodeReport, fixture, fixtureGates, root, run, tag, write } from "./testing";

describe("fork tooling contracts", () => {
  it.effect("names every completed replay result exactly once in priority order", () =>
    Effect.sync(() => {
      expectTypeOf<(typeof replayPriority)[number]>().toEqualTypeOf<
        Exclude<Feature["replay"], "absent">
      >();
      expect(new Set(replayPriority).size).toBe(replayPriority.length);
    }),
  );

  it.effect("prints the real CLI candidate summary and required review command", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const output = join(f.dir, "cli-summary");
      const result = yield* command(f.repo, [
        "env",
        "GIT_CONFIG_COUNT=1",
        `GIT_CONFIG_KEY_0=url.${pathToFileURL(f.repo).href}.insteadOf`,
        `GIT_CONFIG_VALUE_0=${upstreamUrl}`,
        "bun",
        join(root, "fork/upgrade.ts"),
        "v9.1.0",
        "--out",
        output,
        "--series=fork-series/fixture",
        "--source=main",
        "--run-id=cli-summary",
      ]);
      expect(
        decodeReport(fs.readFileSync(join(output, "report.json"), "utf8"))
          .gates.filter((gate) => gate.result === "fail")
          .map((gate) => gate.name),
      ).toEqual(["fork-typecheck", "fork-test"]);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toContain("FAILED_GATES\ncandidate/v9.1.0-cli-summary\n");
      expect(result.stdout).toContain(
        `Required review step in the candidate checkout:\n${createReport("v9.1.0").requiredReview.join("\n")}\n`,
      );
    }),
  );

  it.effect("reports moved tags with both SHAs and a manual replacement instruction", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const remote = join(f.dir, "remote.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      yield* git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
      const local = yield* git(f.repo, "rev-parse", "fork-series/fixture");
      yield* git(remote, "update-ref", "refs/tags/fork-series/fixture", f.base);
      yield* git(remote, "update-ref", "refs/tags/fork-series/missing", f.base);
      const result = yield* run(f, "moved", ["--source", "origin/main"]);
      expect(result.report.reason).toContain(
        `Tag fork-series/fixture moved. Local ${local}. Remote ${f.base}.`,
      );
      expect(result.report.reason).toContain(
        "A person must review the change and replace the local tag",
      );
      expect(result.report.reason).not.toContain("git fetch");
      expect(result.stdout).not.toContain("Required review step");
      expect(result.stdout).toContain("Source freshness is stale. Remote origin, branch main.");
      expect(result.report.candidate).toBe(null);
    }),
  );

  it.effect("omits fetch guidance when the remote source and tags are fresh", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const remote = join(f.dir, "remote.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      yield* git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
      const result = yield* run(f, "fresh-source", ["--source", "origin/main"]);
      expect(result.report.status).toBe("READY_FOR_REVIEW");
      expect(result.report.freshness).toMatchObject({ status: "fresh", fetch: null });
      expect(result.stdout).toContain("Source freshness is fresh.");
      expect(result.stdout).not.toContain("Fetch command:");
    }),
  );

  it.effect("parses only the explicitly allowed options", () =>
    Effect.gen(function* () {
      const cwd = "/tmp";
      const args = ["v9.1.0", "--out", "proof", "--series=fixture", "--source=main"];
      const request = yield* parseMatrixRequest(args, cwd);
      expect(request.series).toBe("fixture");
      expect(request.source).toBe("main");
      for (const flag of ["--off=tool-usage", "--future-option=value"]) {
        const result = yield* Effect.exit(parseMatrixRequest([...args, flag], cwd));
        expect(Exit.isFailure(result)).toBe(true);
      }
      const restricted = yield* Effect.exit(parseRequest(args, cwd, ["out"]));
      expect(Exit.isFailure(restricted)).toBe(true);
      const upgrade = yield* parseRequest([...args, "--off=tool-usage"], cwd);
      expect(upgrade.off).toEqual(["tool-usage"]);
    }),
  );

  it.effect("appends test arguments by gate metadata after a gate is renamed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const gates = fixtureGates.map((entry) =>
        entry.appendTestArgs
          ? {
              ...entry,
              name: "workspace-tests",
              command: ["bun", "-e", "console.log(process.argv.slice(1).join(' '))", "--"],
            }
          : entry,
      );
      const result = yield* run(
        f,
        "renamed-gate",
        ["--test-arg=--env-mode=loose", "--test-arg=--another"],
        { gates },
      );
      const gate = result.report.gates.find((entry) => entry.name === "workspace-tests");
      expect(gate?.command).toEqual([
        "bun",
        "-e",
        "console.log(process.argv.slice(1).join(' '))",
        "--",
        "--env-mode=loose",
        "--another",
      ]);
      expect(fs.readFileSync(join(result.output, gate?.log ?? "missing"), "utf8")).toContain(
        "--env-mode=loose --another",
      );
    }),
  );

  it.effect("resolves a rerere cache against the caller directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const caller = join(f.repo, "nested");
      const request = yield* parseRequest(
        ["v9.1.0", "--out", "output", "--rerere-cache", "../saved-cache"],
        caller,
      );
      expect(request.rerereCache).toBe(join(f.repo, "saved-cache"));
      expect(request.output).toBe(join(caller, "output"));
    }),
  );

  it.effect("shows failed gates and derives the total budget", () =>
    Effect.sync(() => {
      const report = createReport("v9.1.0");
      report.status = "FAILED_GATES";
      report.candidate = { ref: "candidate/test", commit: "test" };
      const text = markdownReport(report);
      expect(text).toContain("Replay completed. One or more gates failed.");
      expect(text).not.toContain("Replay and gates completed.");
      expect(text).toContain(
        `The total design budget is ${Object.values(budgets).reduce((sum, budget) => sum + budget, 0)} lines.`,
      );
      expect(text).toContain("Required review step");
      expect(text).not.toContain('"status":"not-checked"');
    }),
  );

  it.effect("reports inherited Turbo cache settings without an initial-cache field", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const prior = process.env.TURBO_CACHE;
      process.env.TURBO_CACHE = "local:rw";
      const result = yield* run(f, "cache-settings").pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prior === undefined) delete process.env.TURBO_CACHE;
            else process.env.TURBO_CACHE = prior;
          }),
        ),
      );
      expect(result.report.cache.inherited.TURBO_CACHE).toBe("local:rw");
      expect(result.stdout).toContain("TURBO_CACHE=local:rw");
      expect(result.report.cache).not.toHaveProperty("initialLocalCache");
      expect(fs.readFileSync(join(result.output, "logs/cache.log"), "utf8")).toContain(
        '"TURBO_CACHE":"local:rw"',
      );
    }),
  );

  it.effect("gives upgrade and matrix usage errors exit code 64 before creating output", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const output = join(f.dir, "unused");
      const upgrade = yield* command(f.repo, [
        "bun",
        join(root, "fork/upgrade.ts"),
        "v1.2.3-rc.1",
        "--out",
        output,
      ]);
      expect(upgrade.code).toBe(64);
      expect(upgrade.stderr).toContain("Expected a stable tag");
      const matrix = yield* command(f.repo, [
        "bun",
        join(root, "fork/omit-matrix.ts"),
        "v1.2.3",
        "--out",
        output,
        "--off=tool-usage",
      ]);
      expect(matrix.code).toBe(64);
      expect(matrix.stderr).toContain("Unknown option --off=tool-usage");
      expect(fs.existsSync(output)).toBe(false);
      for (const flag of [
        "--omit=tool-usage",
        "--off=tool-usage",
        "--run-id=ignored",
        "--rerere-cache=ignored",
        "--test-arg=ignored",
      ]) {
        const parsed = yield* Effect.exit(
          parseMatrixRequest(["v1.2.3", "--out", output, flag], f.repo),
        );
        expect(Exit.isFailure(parsed)).toBe(true);
      }
    }),
  );

  it.effect("rejects a local upstream tag that differs from the upstream commit", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const remote = join(f.dir, "upstream.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      const upstream = yield* git(remote, "rev-parse", "series");
      yield* git(remote, "update-ref", "refs/tags/v9.1.0", upstream);
      const refs = yield* git(f.repo, "for-each-ref");
      const result = yield* run(f, "mismatched-tag", [], {
        upstreamUrl: pathToFileURL(remote).href,
      });
      expect(result.code).toBe(2);
      expect(result.report.reason).toContain(
        `Upstream tag v9.1.0 differs. Local ${f.base}. Upstream ${upstream}.`,
      );
      expect(result.report.candidate).toBe(null);
      expect(yield* git(f.repo, "for-each-ref")).toBe(refs);
    }),
  );

  it.effect("rejects a mismatched upstream tag in the omission matrix before bootstrap", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const remote = join(f.dir, "upstream.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      const upstream = yield* git(remote, "rev-parse", "series");
      yield* git(remote, "update-ref", "refs/tags/v9.1.0", upstream);
      const output = join(f.dir, "matrix");
      const result = yield* command(f.repo, [
        "env",
        "GIT_CONFIG_COUNT=1",
        `GIT_CONFIG_KEY_0=url.${pathToFileURL(remote).href}.insteadOf`,
        `GIT_CONFIG_VALUE_0=${upstreamUrl}`,
        "bun",
        join(root, "fork/omit-matrix.ts"),
        "v9.1.0",
        "--out",
        output,
        "--series=fork-series/fixture",
        "--source=main",
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        `Upstream tag v9.1.0 differs. Local ${f.base}. Upstream ${upstream}.`,
      );
      expect(fs.existsSync(join(output, "bootstrap.log"))).toBe(false);
    }),
  );

  it.effect("accepts an annotated upstream tag by its peeled commit", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* tag(f);
      const remote = join(f.dir, "upstream.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      yield* git(remote, "config", "user.name", "Fixture maintainer");
      yield* git(remote, "config", "user.email", "fixture@example.invalid");
      yield* git(remote, "tag", "-d", "v9.1.0");
      yield* git(remote, "tag", "-a", "v9.1.0", f.base, "-m", "Upstream release");
      const result = yield* run(f, "annotated-tag", [], {
        upstreamUrl: pathToFileURL(remote).href,
      });
      expect(result.report.status).toBe("READY_FOR_REVIEW");
      expect(result.report.upstream.commit).toBe(f.base);
    }),
  );

  it.effect("lands the README bridge push only when origin main has not moved", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const candidate = yield* git(f.repo, "rev-parse", "series");
      const bridge = yield* git(
        f.repo,
        "commit-tree",
        `${candidate}^{tree}`,
        "-p",
        f.base,
        "-p",
        candidate,
        "-m",
        "Bridge landing",
      );
      yield* git(f.repo, "branch", "land-upstream-upgrade", bridge);
      const remote = join(f.dir, "remote.git");
      yield* git(f.repo, "clone", "--bare", f.repo, remote);
      yield* git(remote, "config", "receive.denyDeleteCurrent", "ignore");
      yield* git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
      yield* write(f.repo, "intervening.ts", "export const fix = true;\n");
      const moved = yield* commit(f.repo, "tool-usage", "Intervening fix X");
      yield* git(f.repo, "push", "origin", "main");
      const readme = fs.readFileSync(join(root, "fork/README.md"), "utf8");
      const step =
        [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].find((match) =>
          match[1]?.includes("${bridge}:refs/heads/main"),
        )?.[1] ?? "exit 99";
      const script = step.replace(/^ {3}/gm, "");
      const rejected = yield* command(f.repo, ["env", "-u", "bridge", "sh", "-c", script]);
      expect(rejected.code).not.toBe(0);
      expect(yield* git(remote, "rev-parse", "main")).toBe(moved);
      yield* git(remote, "update-ref", "refs/heads/main", f.base);
      const landed = yield* command(f.repo, ["env", "-u", "bridge", "sh", "-c", script]);
      expect(landed.code, landed.stderr).toBe(0);
      expect(yield* git(remote, "rev-parse", "main")).toBe(bridge);
      yield* git(f.repo, "update-ref", "-d", "refs/heads/land-upstream-upgrade");
      const missing = yield* command(f.repo, ["env", "-u", "bridge", "sh", "-c", script]);
      expect(missing.code).not.toBe(0);
      expect(yield* git(remote, "rev-parse", "main")).toBe(bridge);
    }),
  );

  for (const mode of ["fast-forward", "merge-button", "main-moved", "tree-mismatch"] as const) {
    it.effect(`checks README release invariants for ${mode} landings`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* tag(f);
        const candidate = yield* git(f.repo, "rev-parse", "series");
        const bridge = yield* git(
          f.repo,
          "commit-tree",
          `${candidate}^{tree}`,
          "-p",
          f.base,
          "-p",
          candidate,
          "-m",
          "Bridge landing",
        );
        yield* git(f.repo, "branch", "land-upstream-upgrade", bridge);
        if (mode === "main-moved") {
          yield* write(f.repo, "foundation.ts", "export const foundation = 'fork';\n");
          yield* commit(f.repo, "tool-usage", "Intervening fix X");
        }
        if (mode === "tree-mismatch") {
          const wrongTree = yield* git(
            f.repo,
            "commit-tree",
            `${f.base}^{tree}`,
            "-p",
            f.base,
            "-p",
            bridge,
            "-m",
            "Landing with a different tree",
          );
          yield* git(f.repo, "update-ref", "refs/heads/main", wrongTree);
        } else {
          yield* git(
            f.repo,
            "merge",
            mode === "fast-forward" ? "--ff-only" : "--no-ff",
            bridge,
            "-m",
            "Merge landing",
          );
        }
        const landing = yield* git(f.repo, "rev-parse", "HEAD");
        expect((yield* git(f.repo, "rev-parse", `${landing}^1`)) === f.base).toBe(
          mode !== "main-moved",
        );
        expect(yield* git(f.repo, "rev-parse", `${landing}^2`)).toBe(
          mode === "fast-forward" ? candidate : bridge,
        );
        const accepted = mode === "fast-forward" || mode === "merge-button";
        expect(
          (yield* git(f.repo, "rev-parse", `${landing}^{tree}`)) ===
            (yield* git(f.repo, "rev-parse", `${candidate}^{tree}`)),
        ).toBe(mode !== "tree-mismatch");
        yield* write(f.repo, "later.ts", "export const fix = true;\n");
        const later = yield* commit(f.repo, "tool-usage", "Keep later fix");
        const remote = join(f.dir, "remote.git");
        yield* git(f.repo, "clone", "--bare", f.repo, remote);
        yield* git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
        const reportPath = join(f.dir, "landing.json");
        const landingReport = {
          drift: { source: { commit: f.base } },
          candidate: { commit: candidate },
          nextSeries: { ref: "fork-series/fixture" },
          upstream: { commit: f.base, tag: "v9.1.0" },
        };
        fs.writeFileSync(reportPath, JSON.stringify(landingReport));
        const readme = fs.readFileSync(join(root, "fork/README.md"), "utf8");
        const step =
          [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].find((match) =>
            match[1]?.includes("landing_commit="),
          )?.[1] ?? "exit 99";
        const script = `report=$1\n${step.replace(/^ {3}/gm, "")}`;
        const mismatchPath = join(f.dir, "mismatched.json");
        const mismatchCandidate = yield* git(
          f.repo,
          "commit-tree",
          `${candidate}^{tree}`,
          "-p",
          f.base,
          "-m",
          "Candidate from another run with the same tree",
        );
        fs.writeFileSync(
          mismatchPath,
          JSON.stringify({ ...landingReport, candidate: { commit: mismatchCandidate } }),
        );
        const mismatched = yield* command(f.repo, ["sh", "-c", script, "landing", mismatchPath]);
        expect(mismatched.code, "rejects a report from a different upgrade run").not.toBe(0);
        expect(yield* git(f.repo, "tag", "--list", "fork-release/*")).toBe("");
        const unset = yield* command(f.repo, ["env", "-u", "report", "sh", "-c", step]);
        expect(unset.code).not.toBe(0);
        expect(unset.stderr).toContain(
          "Set report to the JSON report of the upgrade run whose bridge landed",
        );
        expect(yield* git(f.repo, "tag", "--list", "fork-release/*")).toBe("");
        const missingPath = join(f.dir, "missing-candidate.json");
        fs.writeFileSync(missingPath, JSON.stringify({ ...landingReport, candidate: null }));
        const missing = yield* command(f.repo, ["sh", "-c", script, "landing", missingPath]);
        expect(missing.code).not.toBe(0);
        expect(yield* git(f.repo, "tag", "--list", "fork-release/*")).toBe("");
        const tagged = yield* command(f.repo, ["sh", "-c", script, "landing", reportPath]);
        expect(tagged.code, tagged.stderr).toBe(accepted ? 0 : 1);
        expect(yield* git(f.repo, "tag", "--list", "fork-release/*")).toBe(
          accepted ? "fork-release/v9.1.0-1" : "",
        );
        expect(yield* git(remote, "tag", "--list", "fork-release/*")).toBe(
          accepted ? "fork-release/v9.1.0-1" : "",
        );
        if (!accepted) return;
        expect(yield* git(f.repo, "rev-parse", "fork-release/v9.1.0-1^{commit}")).toBe(landing);
        expect(yield* git(remote, "rev-parse", "fork-release/v9.1.0-1^{commit}")).toBe(landing);
        const duplicate = yield* command(f.repo, ["sh", "-c", script, "landing", reportPath]);
        expect(duplicate.code).not.toBe(0);
        expect(duplicate.stderr).toContain("already exists");
        yield* git(f.repo, "update-ref", "refs/heads/land-upstream-upgrade", candidate);
        const stopped = yield* command(f.repo, ["sh", "-c", script, "landing", reportPath]);
        expect(stopped.code).toBe(1);
        expect(stopped.stderr).toContain("No checked landing commit found");
        expect(stopped.stderr).not.toContain("already exists");
        expect(yield* git(f.repo, "rev-parse", "fork-release/v9.1.0-1^{commit}")).toBe(landing);
        const report = createReport("v9.1.0");
        yield* planReplay(f.repo, undefined, "main", report);
        expect(report.drift.commits.map((entry) => entry.sha)).toEqual([later]);
      }),
    );
  }
});
