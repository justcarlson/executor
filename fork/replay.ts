import * as fs from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import {
  budgets,
  check,
  command,
  git,
  infrastructure,
  io,
  lines,
  protectedPath,
  receiptPath,
  registryPath,
  required,
  runtimeIds,
  UpgradeError,
  type Commit,
  type Feature,
  type ReplayPass,
  type Report,
} from "./shared";

export const replayPriority = [
  "omitted",
  "conflict-omitted",
  "resolved-by-rerere",
  "applied",
  "already-upstream",
  "upstream-marker",
] as const satisfies readonly Exclude<Feature["replay"], "absent">[];

const measure = (repo: string, sha: string, paths: Set<string>, ignoreWhitespace: boolean) =>
  Effect.gen(function* () {
    const stats = yield* git(
      repo,
      "show",
      "--format=",
      "--numstat",
      "--no-renames",
      ...(ignoreWhitespace ? ["-w"] : []),
      sha,
    );
    return lines(stats).reduce((sum, line) => {
      const [add, remove, path = ""] = line.split("\t");
      return paths.has(path) &&
        !protectedPath(path) &&
        /\.(?:[cm]?[jt]sx?|astro|vue|svelte)$/.test(path)
        ? sum + (Number(add) || 0) + (Number(remove) || 0)
        : sum;
    }, 0);
  });
export const writeSelection = (repo: string, upstream: string, report: Report) =>
  Effect.gen(function* () {
    const selection = {
      upstreamCommit: upstream,
      available: report.features
        .filter((feature) => feature.available)
        .map((feature) => feature.id),
      production: report.features
        .filter((feature) => feature.production)
        .map((feature) => feature.id),
    };
    yield* io(() =>
      fs.writeFileSync(join(repo, receiptPath), `${JSON.stringify(selection, null, 2)}\n`),
    );
    yield* git(repo, "add", "--", receiptPath);
    yield* git(repo, "commit", "--allow-empty", "-m", "Record fork feature selection");
    return yield* git(repo, "rev-parse", "HEAD");
  });

type PickResult =
  | {
      result: "applied" | "resolved-by-rerere" | "already-upstream" | "upstream-marker";
      rerere: boolean;
      conflicts: string[];
    }
  | { result: "conflict-omitted"; rerere: false; conflicts: string[] };
const pickCommit = (repo: string, commit: Commit, log: string, logRef: string) =>
  Effect.gen(function* () {
    const result = yield* command(
      repo,
      [
        "git",
        "-c",
        "rerere.enabled=true",
        "-c",
        "rerere.autoupdate=false",
        "cherry-pick",
        "-x",
        commit.sha,
      ],
      log,
    );
    if (result.code === 0)
      return { result: "applied", rerere: false, conflicts: [] } satisfies PickResult;
    const conflicts = lines(yield* git(repo, "diff", "--name-only", "--diff-filter=U"));
    if (conflicts.length > 0) {
      const diff = yield* git(repo, "diff");
      yield* io(() => fs.writeFileSync(`${log}.diff`, `${diff}\n`));
      yield* git(repo, "-c", "rerere.enabled=true", "-c", "rerere.autoupdate=false", "rerere");
      const remaining = yield* git(repo, "-c", "rerere.enabled=true", "rerere", "remaining");
      if (remaining !== "") {
        yield* git(repo, "cherry-pick", "--abort");
        return { result: "conflict-omitted", rerere: false, conflicts } satisfies PickResult;
      }
      yield* git(repo, "add", "--", ...conflicts);
    }
    const rerere = conflicts.length > 0;
    const staged = yield* command(repo, ["git", "diff", "--cached", "--quiet"]);
    if (staged.code === 0) {
      yield* git(repo, "cherry-pick", "--skip");
      return {
        result:
          commit.subject === `Record upstreamed fork feature ${commit.id}`
            ? "upstream-marker"
            : "already-upstream",
        rerere,
        conflicts,
      } satisfies PickResult;
    }
    yield* check(rerere, `Cherry-pick failed without a source conflict. See ${logRef}`);
    yield* git(
      repo,
      "-c",
      "core.editor=true",
      "-c",
      "rerere.enabled=true",
      "-c",
      "rerere.autoupdate=false",
      "cherry-pick",
      "--continue",
    );
    return { result: "resolved-by-rerere", rerere, conflicts } satisfies PickResult;
  });

type PassResult = { features: Feature[] } | { conflict: NonNullable<ReplayPass["conflict"]> };
const replayPass = (
  repo: string,
  output: string,
  commits: Commit[],
  known: string[],
  paths: Set<string>,
  omissions: ReadonlyMap<string, "omitted" | "conflict-omitted">,
  report: Report,
) =>
  Effect.gen(function* () {
    const pass: ReplayPass = { number: report.passes.length + 1, picks: [], conflict: null };
    report.passes.push(pass);
    const features = known.map(
      (id): Feature => ({
        id,
        commits: commits
          .filter((commit) => commit.id === id)
          .map((commit) => ({
            ...commit,
            result: "pending",
            rerere: false,
            candidateCommit: null,
            conflicts: [],
            log: null,
          })),
        replay: "absent",
        available: false,
        production: false,
        upstreamLines: {
          plain: 0,
          ignoreWhitespace: 0,
          budget: budgets[id] ?? 0,
          overBudget: false,
        },
      }),
    );
    report.features = features;
    pass.picks = features.flatMap((feature) => feature.commits);
    for (const commit of commits) {
      const feature = features.find((feature) => feature.id === commit.id);
      const pick = feature?.commits.find(
        (pick) =>
          pick.sha === commit.sha && pick.origin === commit.origin && pick.result === "pending",
      );
      if (feature === undefined || pick === undefined)
        return yield* new UpgradeError({ reason: "Replay plan has no feature entry" });
      const omission = omissions.get(commit.id);
      if (omission !== undefined) {
        pick.result = omission;
        continue;
      }
      const log = join(
        output,
        "logs",
        `replay-pass-${pass.number}-${commit.sha}-${commit.origin}.log`,
      );
      pick.log = relative(output, log);
      const result = yield* pickCommit(repo, commit, log, pick.log);
      Object.assign(pick, result);
      if (result.result === "conflict-omitted") {
        pass.conflict = { feature: commit.id, commit: commit.sha, paths: result.conflicts };
        break;
      }
      if (result.result !== "already-upstream" && result.result !== "upstream-marker") {
        pick.candidateCommit = yield* git(repo, "rev-parse", "HEAD");
        feature.upstreamLines.plain += yield* measure(repo, pick.candidateCommit, paths, false);
        feature.upstreamLines.ignoreWhitespace += yield* measure(
          repo,
          pick.candidateCommit,
          paths,
          true,
        );
        feature.upstreamLines.overBudget =
          feature.upstreamLines.plain > feature.upstreamLines.budget;
      }
    }
    for (const feature of features) {
      const picks = feature.commits;
      feature.replay =
        replayPriority.find((result) => picks.some((pick) => pick.result === result)) ?? "absent";
    }
    return pass.conflict === null
      ? ({ features } satisfies PassResult)
      : ({ conflict: pass.conflict } satisfies PassResult);
  });

export const replay = (
  repo: string,
  output: string,
  commits: Commit[],
  ids: string[],
  omit: string[],
  off: string[],
  upstream: string,
  report: Report,
) =>
  Effect.gen(function* () {
    const known = [...ids, ...infrastructure];
    yield* check(
      [...omit, ...off].every((id) => known.includes(id)),
      "Unknown --omit or --off feature",
    );
    yield* check(
      omit.every((id) => !required.has(id)),
      "foundation and fork-tooling cannot be omitted",
    );
    yield* check(
      off.every((id) => ids.includes(id)),
      "--off requires a runtime feature",
    );
    const paths = new Set(lines(yield* git(repo, "ls-tree", "-r", "--name-only", upstream)));
    const omissions = new Map<string, "omitted" | "conflict-omitted">(
      omit.map((id) => [id, "omitted"]),
    );
    while (true) {
      const pass = yield* replayPass(repo, output, commits, known, paths, omissions, report);
      if ("conflict" in pass) {
        omissions.set(pass.conflict.feature, "conflict-omitted");
        yield* check(
          !required.has(pass.conflict.feature),
          `Required feature ${pass.conflict.feature} conflicted at ${pass.conflict.commit}`,
        );
        yield* git(repo, "reset", "--hard", upstream);
        continue;
      }
      for (const feature of pass.features) {
        feature.available =
          ids.includes(feature.id) && feature.commits.length > 0 && !omissions.has(feature.id);
        feature.production = feature.available && !off.includes(feature.id);
      }
      for (const feature of pass.features) {
        if (
          feature.commits.length === 0 ||
          !feature.commits.every(
            (pick) => pick.result === "already-upstream" || pick.result === "upstream-marker",
          )
        )
          continue;
        yield* git(
          repo,
          "commit",
          "--allow-empty",
          "-m",
          `Record upstreamed fork feature ${feature.id}\n\nFork-Feature: ${feature.id}\nFork-Class: ${infrastructure.includes(feature.id) ? "infrastructure" : "feature"}`,
        );
      }
      const replayIds = yield* runtimeIds(yield* git(repo, "show", `HEAD:${registryPath}`));
      yield* check(
        ids.join() === replayIds.join(),
        "Replayed SDK schema disagrees with the input series",
      );
      return pass.features;
    }
  });
