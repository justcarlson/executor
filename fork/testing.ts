import { afterEach, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  git,
  parseRequest,
  runtimeIds,
  upgrade,
  markdownReport,
  defaultGates,
  type GateCommand,
} from "./upgrade";

import { registryPath, receiptPath } from "./shared";

export const root = resolve(import.meta.dirname, "..");
export { registryPath, receiptPath } from "./shared";
export const registry = fs.readFileSync(join(root, registryPath), "utf8");
export const receipt = fs.readFileSync(join(root, receiptPath), "utf8");
const proofRoot = join(root, "node_modules/.cache/fork-upgrade-proofs");
const fixtureDirs = new Set<string>();
afterEach(() => {
  for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true });
  fixtureDirs.clear();
});
fs.mkdirSync(proofRoot, { recursive: true });
export const write = (repo: string, path: string, data: string) =>
  Effect.sync(() => {
    fs.mkdirSync(resolve(repo, path, ".."), { recursive: true });
    fs.writeFileSync(join(repo, path), data);
  });
export const commit = (repo: string, id: string, subject = `Apply ${id}`) =>
  Effect.gen(function* () {
    yield* git(repo, "add", ".");
    yield* git(
      repo,
      "commit",
      "-m",
      `${subject}\n\nFork-Feature: ${id}\nFork-Class: infrastructure`,
    );
    return yield* git(repo, "rev-parse", "HEAD");
  });
export const fixture = () =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(join(proofRoot, "case-"));
    fixtureDirs.add(dir);
    const repo = join(dir, "source");
    fs.mkdirSync(repo);
    yield* git(repo, "init", "-b", "main");
    yield* git(repo, "config", "user.name", "Fixture maintainer");
    yield* git(repo, "config", "user.email", "fixture@example.invalid");
    yield* git(repo, "config", "commit.gpgsign", "false");
    yield* git(repo, "config", "tag.gpgsign", "false");
    const ids = yield* runtimeIds(registry);
    yield* write(
      repo,
      "package.json",
      `${JSON.stringify(
        {
          scripts: {
            bootstrap: 'bun -e \'require("fs").writeFileSync("bun.lock", "bootstrap drift\\n")\'',
            "format:check": "git diff --exit-code",
            lint: "git diff --exit-code",
            typecheck: "git diff --exit-code",
            test: `bun -e 'console.log(process.argv.slice(1).join(" "))'`,
          },
        },
        null,
        2,
      )}\n`,
    );
    yield* write(repo, "turbo.json", "{}\n");
    yield* write(repo, ".gitignore", "node_modules\n.turbo\n");
    yield* write(repo, "bun.lock", "base\n");
    yield* write(repo, "foundation.ts", "export const foundation = 'base';\n");
    yield* write(repo, "tooling.ts", "export const tooling = 'base';\n");
    yield* write(repo, "fixup.ts", "export const fixup = 'base';\n");
    for (const id of ids)
      yield* write(repo, `features/${id}.ts`, `export const value = 'base-${id}';\n`);
    yield* git(repo, "add", ".");
    yield* git(repo, "commit", "-m", "Upstream base");
    const base = yield* git(repo, "rev-parse", "HEAD");
    yield* git(repo, "switch", "-c", "series");
    yield* write(repo, registryPath, registry);
    yield* write(repo, receiptPath, receipt);
    yield* write(repo, "foundation.ts", "export const foundation = 'fork';\n");
    yield* commit(repo, "foundation");
    for (const id of ids) {
      yield* write(repo, `features/${id}.ts`, `export const value = 'fork-${id}';\n`);
      yield* commit(repo, id);
    }
    yield* write(repo, "tooling.ts", "export const tooling = 'fork';\n");
    yield* commit(repo, "fork-tooling");
    yield* git(
      repo,
      "tag",
      "-a",
      "fork-series/fixture",
      "-m",
      `Fixture series\n\nFork-Upstream: ${base}`,
    );
    yield* git(repo, "switch", "main");
    yield* git(repo, "update-ref", "refs/remotes/origin/main", base);
    return { dir, repo, base, ids };
  });
export type Fixture = Effect.Success<ReturnType<typeof fixture>>;
export const tag = (f: Fixture, feature?: string) =>
  Effect.gen(function* () {
    if (feature !== undefined) {
      const path =
        feature === "foundation"
          ? "foundation.ts"
          : feature === "fork-tooling"
            ? "tooling.ts"
            : `features/${feature}.ts`;
      yield* write(f.repo, path, "export const value = 'upstream';\n");
      yield* git(f.repo, "add", ".");
      yield* git(f.repo, "commit", "-m", "Change upstream");
    }
    yield* git(f.repo, "tag", "v9.1.0");
  });
const Proof = Schema.Struct({
  status: Schema.String,
  reason: Schema.NullOr(Schema.String),
  lockfileDrift: Schema.Boolean,
  features: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      replay: Schema.String,
      available: Schema.Boolean,
      production: Schema.Boolean,
      commits: Schema.Array(Schema.Struct({ result: Schema.String })),
    }),
  ),
  drift: Schema.Struct({
    skipped: Schema.Boolean,
    blocked: Schema.Array(Schema.String),
    commits: Schema.Array(Schema.Struct({ sha: Schema.String })),
  }),
  gates: Schema.Array(Schema.Struct({ name: Schema.String, result: Schema.String })),
  nextSeries: Schema.NullOr(Schema.Struct({ ref: Schema.String, commit: Schema.String })),
  candidate: Schema.NullOr(Schema.Struct({ ref: Schema.String, commit: Schema.String })),
});
export const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Proof));
export const decodeSelection = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      upstreamCommit: Schema.String,
      available: Schema.Array(Schema.String),
      production: Schema.Array(Schema.String),
    }),
  ),
);
export const fixtureGates = defaultGates.filter((entry) => !entry.name.startsWith("fork-"));
export const run = (
  f: Fixture,
  name: string,
  args: string[] = [],
  options: { defaultSeries?: boolean; upstreamUrl?: string; gates?: readonly GateCommand[] } = {},
) =>
  Effect.gen(function* () {
    const output = join(f.dir, name);
    const request = yield* parseRequest(
      [
        "v9.1.0",
        "--out",
        output,
        "--run-id",
        name,
        ...(args.includes("--series") || options.defaultSeries
          ? []
          : ["--series", "fork-series/fixture"]),
        ...(args.includes("--source") ? [] : ["--source", "main"]),
        ...args,
      ],
      f.repo,
    );
    const report = yield* upgrade(request, {
      gates: options.gates ?? fixtureGates,
      upstreamUrl: options.upstreamUrl ?? pathToFileURL(f.repo).href,
    });
    const saved = decodeReport(fs.readFileSync(join(output, "report.json"), "utf8"));
    expect(saved.status).toBe(report.status);
    const stdout = markdownReport(report);
    fs.writeFileSync(join(f.dir, `${name}.stdout.log`), stdout);
    const code = report.status === "BLOCKED_REPLAY" ? 2 : report.status === "FAILED_GATES" ? 1 : 0;
    return { code, stdout, output, report, candidateRepo: join(output, "repo") };
  });

export const learnResolution = (repo: string) =>
  Effect.gen(function* () {
    yield* write(repo, "features/tool-usage.ts", "export const value = 'reviewed-resolution';\n");
    yield* git(repo, "-c", "rerere.enabled=true", "rerere");
    yield* git(repo, "cherry-pick", "--abort");
  });
