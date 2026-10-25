import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { inspect } from "node:util";
import { Effect, Schema } from "effect";
import ts from "typescript";

export const upstreamUrl = "https://github.com/UsefulSoftwareCo/executor.git";
export const registryPath = "packages/core/sdk/src/fork-features/index.ts";
export const receiptPath = "packages/core/sdk/src/fork-features/replay.json";
export const budgets: Readonly<Record<string, number>> = {
  foundation: 80,
  "inventory-descriptions": 60,
  "automatic-attachments": 24,
  "catalog-read-fastpath": 165,
  "compact-search": 85,
  "integration-aliases": 150,
  "lean-guidance": 40,
  "secret-key-cache": 12,
  "tool-usage": 155,
  "lazy-execute-description": 50,
  "current-membership": 300,
  "standalone-sse-keepalive": 40,
  "detached-catalog-refresh": 480,
  "fork-e2e": 0,
  "fork-tooling": 0,
};
export const infrastructure = ["foundation", "fork-e2e", "fork-tooling"];
export const required = new Set(["foundation", "fork-tooling"]);
export const protectedPath = (path: string) =>
  /(?:\.test\.|\.spec\.|vitest\.config|^e2e\/|^\.github\/)/.test(path);

export class UpgradeError extends Schema.TaggedErrorClass<UpgradeError>()("UpgradeError", {
  reason: Schema.String,
}) {}
export const io = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (cause) => new UpgradeError({ reason: inspect(cause) }) });
export const check = (ok: boolean, reason: string) =>
  ok ? Effect.void : Effect.fail(new UpgradeError({ reason }));
export const lines = (text: string) => text.trim().split("\n").filter(Boolean);

export const command = (cwd: string, args: readonly string[], log?: string) =>
  io(() => {
    const fd = log === undefined ? undefined : fs.openSync(log, "w");
    const result = spawnSync(args[0] ?? "", args.slice(1), {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    });
    if (fd !== undefined) fs.closeSync(fd);
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error === undefined ? "" : inspect(result.error),
    };
  });
export const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const result = yield* command(cwd, ["git", "--no-optional-locks", ...args]);
    yield* check(
      result.code === 0,
      `git ${args.join(" ")}: ${result.stderr}${result.stdout}${result.error}`,
    );
    return result.stdout.trim();
  });

export const runtimeIds = (source: string) =>
  Effect.gen(function* () {
    const file = ts.createSourceFile(registryPath, source, ts.ScriptTarget.Latest, true);
    let ids: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "ForkFeatureId"
      ) {
        const call = node.initializer;
        const array =
          call !== undefined && ts.isCallExpression(call) ? call.arguments[0] : undefined;
        if (array !== undefined && ts.isArrayLiteralExpression(array)) {
          ids = array.elements.flatMap((entry) => (ts.isStringLiteral(entry) ? [entry.text] : []));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    yield* check(
      ids.length > 0 && ids.length === new Set(ids).size,
      "Invalid SDK ForkFeatureId schema",
    );
    yield* check(
      [...ids, ...infrastructure].sort().join() === Object.keys(budgets).sort().join(),
      "Feature budgets disagree with the SDK schema",
    );
    return ids;
  });

export type Commit = { sha: string; id: string; subject: string; origin: "series" | "drift" };
export type Pick = Commit & {
  result:
    | "pending"
    | "applied"
    | "resolved-by-rerere"
    | "omitted"
    | "conflict-omitted"
    | "already-upstream"
    | "upstream-marker";
  rerere: boolean;
  candidateCommit: string | null;
  conflicts: string[];
  log: string | null;
};
export type Feature = {
  id: string;
  commits: Pick[];
  replay: Exclude<Pick["result"], "pending"> | "absent";
  available: boolean;
  production: boolean;
  upstreamLines: { plain: number; ignoreWhitespace: number; budget: number; overBudget: boolean };
};
export type Gate = {
  name: string;
  command: string[];
  result: "pass" | "fail";
  seconds: number;
  log: string;
};
export type Ref = { ref: string; commit: string };
export type Freshness =
  | { status: "not-checked"; reason: string }
  | {
      status: "fresh" | "stale" | "unreadable";
      remote: string;
      branch: string;
      fetch: string | null;
      differences: string[];
    };
export type ReplayPass = {
  number: number;
  picks: Pick[];
  conflict: { feature: string; commit: string; paths: string[] } | null;
};
export const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export const forkE2eCommand =
  "env -u EXECUTOR_FORK_FEATURES EXECUTOR_FORK_PROFILE=production-v1 bun run --cwd e2e test:selfhost scenarios/fork-";
export type GateCommand = { name: string; command: string[]; appendTestArgs?: boolean };
export const defaultGates: readonly GateCommand[] = [
  { name: "format", command: ["bun", "run", "format:check"] },
  { name: "lint", command: ["bun", "run", "lint"] },
  { name: "typecheck", command: ["bun", "run", "typecheck"] },
  { name: "fork-typecheck", command: ["bunx", "tsgo", "-p", "fork/tsconfig.json"] },
  { name: "fork-test", command: ["bunx", "vitest", "run", "--config", "fork/vitest.config.ts"] },
  { name: "test", command: ["bun", "run", "test"], appendTestArgs: true },
];
export type Report = {
  status: "READY_FOR_REVIEW" | "REDUCED_FEATURE_SET" | "FAILED_GATES" | "BLOCKED_REPLAY";
  reason: string | null;
  upstream: { tag: string; commit: string | null };
  series: Ref | null;
  drift: {
    source: Ref | null;
    release: Ref | null;
    skipped: boolean;
    commits: Commit[];
    blocked: string[];
  };
  freshness: Freshness;
  passes: ReplayPass[];
  requiredReview: string[];
  nextSeries: Ref | null;
  candidate: Ref | null;
  features: Feature[];
  gates: Gate[];
  lockfileDrift: boolean;
  cache: { freshClone: true; remoteConfigured: boolean; inherited: Record<string, string> };
  fetch: string | null;
};
export const createReport = (tag: string): Report => ({
  status: "BLOCKED_REPLAY",
  reason: null,
  upstream: { tag, commit: null },
  series: null,
  drift: { source: null, release: null, skipped: false, commits: [], blocked: [] },
  freshness: { status: "not-checked", reason: "Source has not been resolved" },
  passes: [],
  requiredReview: [forkE2eCommand],
  nextSeries: null,
  candidate: null,
  features: [],
  gates: [],
  lockfileDrift: false,
  cache: { freshClone: true, remoteConfigured: false, inherited: {} },
  fetch: null,
});
