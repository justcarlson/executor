import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Result } from "effect";
import {
  command,
  createReport,
  git,
  planReplay,
  resolveUpstream,
  replay,
  UpgradeError,
  parseMatrixRequest,
  writeSelection,
} from "./upgrade";
import { upstreamUrl } from "./shared";

const matrix = Effect.gen(function* () {
  const request = yield* parseMatrixRequest(process.argv.slice(2), process.cwd()).pipe(
    Effect.mapError((error) => ({ reason: error.reason, code: 64 })),
  );
  if (fs.existsSync(request.output))
    return yield* new UpgradeError({ reason: "--out must not exist" });
  const source = yield* git(request.cwd, "rev-parse", "--show-toplevel");
  if ((yield* git(source, "status", "--porcelain", "--untracked-files=all")) !== "")
    return yield* new UpgradeError({ reason: "Source must be clean" });
  const input = createReport(request.tag);
  const plan = yield* planReplay(source, request.series, request.source, input);
  fs.mkdirSync(dirname(request.output), { recursive: true });
  fs.mkdirSync(request.output);
  const repo = join(request.output, "repo");
  yield* git(source, "clone", "--local", "--no-hardlinks", source, repo);
  yield* git(repo, "config", "user.name", "Fork matrix");
  yield* git(repo, "config", "user.email", "fork-matrix@example.invalid");
  yield* git(repo, "config", "commit.gpgsign", "false");
  const upstream = yield* resolveUpstream(repo, request.tag, upstreamUrl);
  const boot = yield* command(
    repo,
    ["bun", "run", "bootstrap"],
    join(request.output, "bootstrap.log"),
  );
  if (boot.code !== 0) return yield* new UpgradeError({ reason: "Matrix bootstrap failed" });
  const expectedLock = yield* git(repo, "show", "HEAD:bun.lock");
  const rows: {
    omitted: string;
    result: string;
    typecheck: string;
    dependencies: string[];
    seconds: number;
    log: string;
  }[] = [];
  for (const id of plan.ids) {
    yield* git(repo, "reset", "--hard", upstream);
    const output = join(request.output, id);
    fs.mkdirSync(join(output, "logs"), { recursive: true });
    const report = createReport(request.tag);
    const start = performance.now();
    const picked = yield* replay(
      repo,
      output,
      plan.commits,
      plan.ids,
      [id],
      [],
      upstream,
      report,
    ).pipe(Effect.result);
    const conflicts = report.features
      .filter((feature) => feature.replay === "conflict-omitted")
      .map((feature) => feature.id);
    const log = join(output, "typecheck.log");
    let typecheck = "could not run";
    if (Result.isSuccess(picked)) {
      yield* writeSelection(repo, upstream, report);
      const lock = yield* git(repo, "show", "HEAD:bun.lock");
      if (lock !== expectedLock)
        return yield* new UpgradeError({
          reason: `Lockfile changed in omission row ${id}; dependency reuse is unsafe`,
        });
      const checked = yield* command(repo, ["bun", "run", "typecheck"], log);
      typecheck = checked.code === 0 ? "pass" : "fail";
    } else
      fs.writeFileSync(
        log,
        `Replay failed after omitting ${id}. Conflicting features: ${conflicts.join(", ")}.\n`,
      );
    const result = typecheck === "pass" && conflicts.length === 0 ? "pass" : "fail";
    rows.push({
      omitted: id,
      result,
      typecheck,
      dependencies: conflicts,
      seconds: (performance.now() - start) / 1000,
      log,
    });
    process.stdout.write(`${id}: ${result} ${log}\n`);
    fs.writeFileSync(join(request.output, "matrix.json"), `${JSON.stringify(rows, null, 2)}\n`);
  }
  fs.writeFileSync(
    join(request.output, "matrix.md"),
    `| Omitted feature | Replay and typecheck | Typecheck | Seconds | Conflicting features | Log |\n|---|---|---|---:|---|---|\n${rows.map((row) => `| ${row.omitted} | ${row.result} | ${row.typecheck} | ${row.seconds.toFixed(2)} | ${row.dependencies.join(", ")} | ${row.log} |`).join("\n")}\n`,
  );
  return rows.every((row) => row.result === "pass") ? 0 : 1;
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      process.stderr.write(`${error.reason}\n`);
      return "code" in error ? error.code : 2;
    }),
  ),
);

const code = await Effect.runPromise(matrix);
process.exitCode = code;
