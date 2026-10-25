import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Schema } from "effect";
import {
  budgets,
  check,
  command,
  createReport,
  defaultGates,
  git,
  infrastructure,
  io,
  lines,
  protectedPath,
  quote,
  required,
  upstreamUrl,
  UpgradeError,
  type Gate,
  type GateCommand,
  type Report,
} from "./shared";
import { planReplay, resolveUpstream } from "./plan";
import { replay, writeSelection } from "./replay";
export {
  command,
  createReport,
  defaultGates,
  forkE2eCommand,
  git,
  runtimeIds,
  UpgradeError,
  type GateCommand,
  type Report,
} from "./shared";
export { planReplay, resolveUpstream } from "./plan";
export { replay, writeSelection } from "./replay";

export const parseRequest = (
  argv: readonly string[],
  cwd: string,
  allowed: readonly string[] = [
    "out",
    "series",
    "source",
    "omit",
    "off",
    "run-id",
    "rerere-cache",
    "test-arg",
  ],
) =>
  Effect.gen(function* () {
    const tag = argv[0] ?? "";
    yield* check(/^v\d+\.\d+\.\d+$/.test(tag), "Expected a stable tag v<major>.<minor>.<patch>");
    const values = new Map<string, string[]>();
    const repeatable = new Set(["omit", "off", "test-arg"]);
    const options = new Set(allowed);
    for (let i = 1; i < argv.length; i++) {
      const argument = argv[i] ?? "";
      const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
      const key = match?.[1] ?? "";
      yield* check(options.has(key), `Unknown option ${argument}`);
      const value = match?.[2] ?? argv[++i];
      yield* check(
        value !== undefined &&
          value.length > 0 &&
          (key === "test-arg" || match?.[2] !== undefined || !value.startsWith("--")),
        `Missing value for --${key}`,
      );
      yield* check(repeatable.has(key) || !values.has(key), `Repeated --${key}`);
      values.set(key, [...(values.get(key) ?? []), value ?? ""]);
    }
    const output = values.get("out")?.[0];
    yield* check(output !== undefined, "--out is required");
    const runId =
      values.get("run-id")?.[0] ?? `${new Date().toISOString().replace(/\D/g, "")}-${process.pid}`;
    yield* check(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId), "Invalid run id");
    return {
      tag,
      output: resolve(cwd, output ?? ""),
      cwd,
      runId,
      series: values.get("series")?.[0],
      source: values.get("source")?.[0] ?? "origin/main",
      omit: values.get("omit") ?? [],
      off: values.get("off") ?? [],
      rerereCache: values.has("rerere-cache")
        ? resolve(cwd, values.get("rerere-cache")?.[0] ?? "")
        : undefined,
      testArgs: values.get("test-arg") ?? [],
    };
  });
export const parseMatrixRequest = (argv: readonly string[], cwd: string) =>
  parseRequest(argv, cwd, ["out", "series", "source"]);
export type UpgradeRequest = Effect.Success<ReturnType<typeof parseRequest>>;

const gate = (repo: string, output: string, name: string, args: string[], report: Report) =>
  Effect.gen(function* () {
    const log = join(output, "logs", `${name}.log`);
    const start = performance.now();
    const result = yield* command(repo, args, log);
    const entry: Gate = {
      name,
      command: args,
      result: result.code === 0 ? "pass" : "fail",
      seconds: (performance.now() - start) / 1000,
      log: relative(output, log),
    };
    report.gates.push(entry);
    process.stdout.write(`${name}: ${entry.result} (${entry.seconds.toFixed(2)}s) ${log}\n`);
    return result.code === 0;
  });
const jsonUnknown = Schema.fromJsonString(Schema.Unknown);
const remoteCacheConfigured = (repo: string) =>
  Effect.gen(function* () {
    const envKeys = [
      "TURBO_TOKEN",
      "TURBO_TEAM",
      "TURBO_TEAMID",
      "TURBO_API",
      "TURBO_REMOTE_CACHE_SIGNATURE_KEY",
      "VERCEL_ARTIFACTS_TOKEN",
      "VERCEL_ARTIFACTS_OWNER",
    ];
    const configs = [
      join(repo, ".turbo/config.json"),
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "turborepo/config.json"),
    ];
    const turbo = yield* Schema.decodeUnknownEffect(jsonUnknown)(
      yield* io(() => fs.readFileSync(join(repo, "turbo.json"), "utf8")),
    ).pipe(Effect.mapError(() => new UpgradeError({ reason: "Cannot decode turbo.json" })));
    const custom =
      typeof turbo === "object" &&
      turbo !== null &&
      "remoteCache" in turbo &&
      typeof turbo.remoteCache === "object" &&
      turbo.remoteCache !== null &&
      ("apiUrl" in turbo.remoteCache ||
        "teamId" in turbo.remoteCache ||
        "teamSlug" in turbo.remoteCache);
    return (
      envKeys.some((key) => Boolean(process.env[key])) ||
      configs.some((path) => fs.existsSync(path)) ||
      custom
    );
  });
const runGates = (
  repo: string,
  output: string,
  upstream: string,
  testArgs: string[],
  report: Report,
  gates: readonly GateCommand[],
) =>
  Effect.gen(function* () {
    report.cache.inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0].startsWith("TURBO_CACHE") && entry[1] !== undefined,
      ),
    );
    report.cache.remoteConfigured = yield* remoteCacheConfigured(repo);
    const cacheLog = "logs/cache.log";
    yield* io(() =>
      fs.writeFileSync(
        join(output, cacheLog),
        `Fresh clone. Remote cache configured: ${report.cache.remoteConfigured}. Inherited cache settings: ${JSON.stringify(report.cache.inherited)}.\n`,
      ),
    );
    report.gates.push({
      name: "cache",
      command: [],
      result: report.cache.remoteConfigured ? "fail" : "pass",
      seconds: 0,
      log: cacheLog,
    });
    if (report.cache.remoteConfigured) return;
    yield* gate(repo, output, "bootstrap", ["bun", "run", "bootstrap"], report);
    report.lockfileDrift =
      (yield* git(repo, "diff", "--name-only", "HEAD", "--", "bun.lock")) !== "";
    yield* git(repo, "restore", "--source=HEAD", "--staged", "--worktree", "--", "bun.lock");
    const start = performance.now();
    const changed = lines(
      yield* git(
        repo,
        "diff",
        "--no-renames",
        "--name-only",
        "--diff-filter=MDR",
        upstream,
        "HEAD",
      ),
    ).filter(protectedPath);
    const log = "logs/upstream-tests.log";
    yield* io(() =>
      fs.writeFileSync(
        join(output, log),
        changed.length === 0 ? "ok\n" : `${changed.join("\n")}\nFAIL\n`,
      ),
    );
    report.gates.push({
      name: "upstream-tests",
      command: [
        "git",
        "diff",
        "--no-renames",
        "--name-only",
        "--diff-filter=MDR",
        upstream,
        "HEAD",
      ],
      result: changed.length === 0 ? "pass" : "fail",
      seconds: (performance.now() - start) / 1000,
      log,
    });
    for (const entry of gates)
      yield* gate(
        repo,
        output,
        entry.name,
        [...entry.command, ...(entry.appendTestArgs ? testArgs : [])],
        report,
      );
    const drift = yield* git(repo, "status", "--porcelain", "--untracked-files=all");
    yield* io(() => fs.writeFileSync(join(output, "logs/tracked-drift.log"), `${drift || "ok"}\n`));
    report.gates.push({
      name: "tracked-drift",
      command: ["git", "status", "--porcelain", "--untracked-files=all"],
      result: drift === "" ? "pass" : "fail",
      seconds: 0,
      log: "logs/tracked-drift.log",
    });
  });
export const markdownReport = (report: Report) => {
  const rows = report.features.map(
    (feature) =>
      `| ${feature.id} | ${feature.commits.map((commit) => `${commit.sha} (${commit.result}${commit.rerere ? ", rerere" : ""})`).join("<br>") || "none"} | ${feature.replay} | ${feature.available} | ${feature.production} | ${feature.upstreamLines.plain} | ${feature.upstreamLines.ignoreWhitespace} | ${feature.upstreamLines.budget}${feature.upstreamLines.overBudget ? " (exceeded)" : ""} |`,
  );
  return [
    report.status,
    "",
    report.reason ??
      (report.status === "FAILED_GATES"
        ? "Replay completed. One or more gates failed."
        : "Replay and gates completed."),
    "",
    `Upstream ${report.upstream.tag} ${report.upstream.commit ?? "unresolved"}.`,
    "",
    `Input series ${report.series?.ref ?? "unresolved"} ${report.series?.commit ?? ""}.`,
    "",
    report.drift.skipped
      ? "No fork-release tag exists. Drift validation was skipped."
      : `Drift source ${report.drift.source?.ref ?? "unresolved"}. Release ${report.drift.release?.ref ?? "unresolved"}.`,
    "",
    `Source ${report.drift.source?.ref ?? "unresolved"} ${report.drift.source?.commit ?? "unresolved"}.`,
    "",
    report.freshness.status === "not-checked"
      ? `Source freshness was not checked. ${report.freshness.reason}.`
      : `Source freshness is ${report.freshness.status}. Remote ${report.freshness.remote}, branch ${report.freshness.branch}.${report.freshness.differences.length === 0 ? "" : `\n${report.freshness.differences.join("\n")}`}${report.freshness.fetch === null ? "" : `\nFetch command: ${report.freshness.fetch}`}`,
    "",
    ...report.passes.map(
      (pass) =>
        `Replay pass ${pass.number}. ${pass.conflict === null ? "Completed without unresolved conflicts." : `Omitted ${pass.conflict.feature} at ${pass.conflict.commit}. Conflicting paths ${pass.conflict.paths.join(", ")}.`}`,
    ),
    "",
    `Drift commits ${report.drift.commits.map((commit) => commit.sha).join(", ") || "none"}.`,
    "",
    `Blocked drift commits ${report.drift.blocked.join("; ") || "none"}.`,
    "",
    `New series ${report.nextSeries?.ref ?? "none"} ${report.nextSeries?.commit ?? ""}.`,
    "",
    `Candidate ${report.candidate?.ref ?? "none"} ${report.candidate?.commit ?? ""}.`,
    "",
    `Fresh clone. Remote Turbo cache configured ${report.cache.remoteConfigured}. Inherited cache settings ${
      Object.entries(report.cache.inherited)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ") || "none"
    }.`,
    "",
    `Lockfile drift ${report.lockfileDrift}. Bootstrap lockfile changes were restored.`,
    "",
    "| Feature | Commits and results | Replay | Available | Production | Upstream lines | Ignoring whitespace | Budget |",
    "|---|---|---|---|---|---:|---:|---:|",
    ...rows,
    "",
    `Budget overruns require review. Counts are additions plus deletions in upstream-owned source paths, per replayed commit. The total design budget is ${Object.values(budgets).reduce((total, budget) => total + budget, 0)} lines. These gates do not prove runtime parity.`,
    "",
    "| Gate | Result | Seconds | Log | Command |",
    "|---|---|---:|---|---|",
    ...report.gates.map(
      (gate) =>
        `| ${gate.name} | ${gate.result} | ${gate.seconds.toFixed(2)} | [log](${gate.log}) | ${gate.command.join(" ")} |`,
    ),
    "",
    ...(report.candidate === null
      ? []
      : [
          "Required review step. Run the fork e2e check in the candidate checkout.",
          "",
          ...report.requiredReview.map((command) => `\`\`\`sh\n${command}\n\`\`\``),
        ]),
    "",
    report.fetch === null ? "No candidate refs to import." : `\`\`\`sh\n${report.fetch}\n\`\`\``,
    "",
  ].join("\n");
};
export const upgrade = (
  request: UpgradeRequest,
  options: { gates?: readonly GateCommand[]; upstreamUrl?: string } = {},
) =>
  Effect.gen(function* () {
    yield* check(!fs.existsSync(request.output), "--out must not exist");
    const source = yield* git(request.cwd, "rev-parse", "--show-toplevel");
    const inside = relative(source, request.output);
    yield* check(
      inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside),
      "--out must be outside the source checkout",
    );
    yield* check(
      (yield* git(source, "status", "--porcelain", "--untracked-files=all")) === "",
      "The source checkout must be clean",
    );
    yield* io(() => {
      fs.mkdirSync(dirname(request.output), { recursive: true });
      fs.mkdirSync(request.output);
    });
    const output = request.output;
    const repo = join(output, "repo");
    yield* io(() => fs.mkdirSync(join(output, "logs")));
    const report = createReport(request.tag);
    const run = Effect.gen(function* () {
      const plan = yield* planReplay(source, request.series, request.source, report);
      yield* check(
        [...request.omit, ...request.off].every((id) =>
          [...plan.ids, ...infrastructure].includes(id),
        ),
        "Unknown --omit or --off feature",
      );
      yield* check(
        request.omit.every((id) => !required.has(id)),
        "foundation and fork-tooling cannot be omitted",
      );
      yield* git(source, "clone", "--local", "--no-hardlinks", "--no-checkout", source, repo);
      const upstream = yield* resolveUpstream(
        repo,
        request.tag,
        options.upstreamUrl ?? upstreamUrl,
      );
      report.upstream.commit = upstream;
      process.stdout.write(`Upstream ${request.tag} ${upstream}\n`);
      const candidateRef = `candidate/${request.tag}-${request.runId}`;
      yield* git(repo, "switch", "-c", candidateRef, upstream);
      const identity = yield* git(source, "var", "GIT_AUTHOR_IDENT");
      const match = /^(.*) <([^>]+)> /.exec(identity);
      yield* git(repo, "config", "user.name", match?.[1] ?? "Fork maintainer");
      yield* git(repo, "config", "user.email", match?.[2] ?? "fork@example.invalid");
      yield* git(repo, "config", "commit.gpgsign", "false");
      yield* git(repo, "config", "tag.gpgsign", "false");
      if (request.rerereCache !== undefined)
        yield* io(() =>
          fs.cpSync(request.rerereCache ?? "", join(repo, ".git/rr-cache"), {
            recursive: true,
          }),
        );
      yield* replay(
        repo,
        output,
        plan.commits,
        plan.ids,
        request.omit,
        request.off,
        upstream,
        report,
      );
      const seriesCommit = yield* git(repo, "rev-parse", "HEAD");
      const seriesRef = `fork-series/${request.tag}-${request.runId}`;
      yield* git(
        repo,
        "tag",
        "-a",
        seriesRef,
        seriesCommit,
        "-m",
        `Fork feature series for ${request.tag}\n\nFork-Upstream: ${upstream}\nFork-Series-Commit: ${seriesCommit}`,
      );
      report.nextSeries = { ref: seriesRef, commit: seriesCommit };
      report.candidate = {
        ref: candidateRef,
        commit: yield* writeSelection(repo, upstream, report),
      };
      report.fetch = `git fetch ${quote(repo)} ${quote(`refs/heads/${candidateRef}:refs/heads/${candidateRef}`)} ${quote(`refs/tags/${seriesRef}:refs/tags/${seriesRef}`)}`;
      yield* runGates(
        repo,
        output,
        upstream,
        request.testArgs,
        report,
        options.gates ?? defaultGates,
      );
      report.status = report.gates.some((gate) => gate.result === "fail")
        ? "FAILED_GATES"
        : report.features.some(
              (feature) =>
                (plan.ids.includes(feature.id) && !feature.production) ||
                feature.replay === "omitted" ||
                feature.replay === "conflict-omitted",
            )
          ? "REDUCED_FEATURE_SET"
          : "READY_FOR_REVIEW";
    });
    yield* run.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          report.reason = error.reason;
          report.status = report.candidate === null ? "BLOCKED_REPLAY" : "FAILED_GATES";
        }),
      ),
    );
    yield* io(() => {
      const cache = join(repo, ".git/rr-cache");
      if (fs.existsSync(cache)) fs.cpSync(cache, join(output, "rr-cache"), { recursive: true });
      else fs.mkdirSync(join(output, "rr-cache"));
      fs.writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      fs.writeFileSync(join(output, "report.md"), markdownReport(report));
    });
    process.stdout.write(
      `${report.status}\n${report.reason === null ? "" : `${report.reason}\n`}${report.candidate === null ? "" : `${report.candidate.ref}\n${report.candidate.commit}\n${report.fetch}\nRequired review step in the candidate checkout:\n${report.requiredReview.join("\n")}\n`}`,
    );
    return report;
  });

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = await Effect.runPromiseExit(
    parseRequest(process.argv.slice(2), process.cwd()).pipe(
      Effect.mapError((error) => ({ reason: error.reason, code: 64 })),
      Effect.flatMap((request) =>
        upgrade(request).pipe(Effect.mapError((error) => ({ reason: error.reason, code: 2 }))),
      ),
      Effect.map((report) =>
        report.status === "BLOCKED_REPLAY" ? 2 : report.status === "FAILED_GATES" ? 1 : 0,
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.reason}\n`);
          return error.code;
        }),
      ),
    ),
  );
  process.exitCode = Exit.isSuccess(result) ? result.value : 2;
}
