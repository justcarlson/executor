import { Effect } from "effect";
import {
  check,
  command,
  git,
  infrastructure,
  lines,
  quote,
  registryPath,
  runtimeIds,
  type Commit,
  type Freshness,
  type Report,
} from "./shared";

const checkFreshness = (repo: string, sourceRef: string, source: string, report: Report) =>
  Effect.gen(function* () {
    const symbolic = yield* command(repo, ["git", "rev-parse", "--symbolic-full-name", sourceRef]);
    const ref = symbolic.stdout.trim();
    const remotes = lines(yield* git(repo, "remote")).sort((a, b) => b.length - a.length);
    const trackingRef = ref.startsWith("refs/remotes/")
      ? ref.slice("refs/remotes/".length)
      : symbolic.code !== 0 && remotes.some((name) => sourceRef.startsWith(`${name}/`))
        ? sourceRef
        : undefined;
    if (trackingRef === undefined) {
      report.freshness = { status: "not-checked", reason: "Local branch or commit used as given" };
      return;
    }
    const remote = remotes.find((name) => trackingRef.startsWith(`${name}/`));
    yield* check(remote !== undefined, `No remote configured for ${sourceRef}`);
    const name = remote ?? "";
    const branch = trackingRef.slice(name.length + 1);
    const fetch = `git fetch --tags ${quote(name)}`;
    const remoteRefs = yield* command(repo, [
      "git",
      "ls-remote",
      "--",
      name,
      `refs/heads/${branch}`,
      "refs/tags/fork-release/*",
      "refs/tags/fork-series/*",
    ]);
    if (remoteRefs.code !== 0) {
      report.freshness = { status: "unreadable", remote: name, branch, fetch, differences: [] };
      return yield* check(false, `Cannot read remote ${name}. Run ${fetch} before retrying.`);
    }
    const differences: string[] = [];
    let needsFetch = false;
    let moved = false;
    const refs = new Map(
      lines(remoteRefs.stdout).map((line) => {
        const [sha = "", ref = ""] = line.split("\t");
        return [ref, sha];
      }),
    );
    if (refs.get(`refs/heads/${branch}`) !== source) {
      differences.push(`Source ${sourceRef} differs from remote branch ${branch}`);
      needsFetch = true;
    }
    for (const [ref, sha] of refs) {
      if (!ref.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
      const local = yield* command(repo, ["git", "rev-parse", "--verify", ref]);
      const tag = ref.slice("refs/tags/".length);
      if (local.code !== 0) {
        differences.push(`Tag ${tag} is missing locally`);
        needsFetch = true;
      } else if (local.stdout.trim() !== sha) {
        differences.push(
          `Tag ${tag} moved. Local ${local.stdout.trim()}. Remote ${sha}. A person must review the change and replace the local tag before retrying.`,
        );
        moved = true;
      }
    }
    const freshness: Freshness = {
      status: differences.length > 0 ? "stale" : "fresh",
      remote: name,
      branch,
      fetch: needsFetch && !moved ? fetch : null,
      differences,
    };
    report.freshness = freshness;
    yield* check(
      freshness.status === "fresh",
      `${differences.join("\n")}${needsFetch && !moved ? `\nRun ${fetch} before retrying.` : ""}`,
    );
  });
const readCommits = (repo: string, shas: string[], known: Set<string>, origin: Commit["origin"]) =>
  Effect.gen(function* () {
    const commits: Commit[] = [];
    const blocked: string[] = [];
    for (const sha of shas) {
      const message = yield* git(repo, "show", "-s", "--format=%B", sha);
      const ids = [...message.matchAll(/^Fork-Feature:[ \t]*(.*)$/gm)].map(
        (match) => match[1]?.trim() ?? "",
      );
      const parents = (yield* git(repo, "rev-list", "--parents", "-n", "1", sha)).split(" ");
      if (ids.length !== 1 || !known.has(ids[0] ?? "") || parents.length !== 2) {
        blocked.push(
          `${sha} ${message.split("\n")[0]} (requires one parent and exactly one known Fork-Feature line)`,
        );
      } else commits.push({ sha, id: ids[0] ?? "", subject: message.split("\n")[0] ?? "", origin });
    }
    return { commits, blocked };
  });
export const planReplay = (
  repo: string,
  seriesRef: string | undefined,
  sourceRef: string,
  report: Report,
) =>
  Effect.gen(function* () {
    const resolved = yield* command(repo, [
      "git",
      "rev-parse",
      "--verify",
      `${sourceRef}^{commit}`,
    ]);
    const source = resolved.code === 0 ? resolved.stdout.trim() : "";
    report.drift.source = resolved.code === 0 ? { ref: sourceRef, commit: source } : null;
    yield* checkFreshness(repo, sourceRef, source, report);
    yield* check(resolved.code === 0, `Cannot resolve source ${sourceRef}`);
    const described = yield* command(repo, [
      "git",
      "describe",
      "--tags",
      "--first-parent",
      "--abbrev=0",
      "--match",
      "fork-release/*",
      source,
    ]);
    const release = described.code === 0 ? described.stdout.trim() : undefined;
    if (release === undefined) report.drift.skipped = true;
    else
      report.drift.release = {
        ref: release,
        commit: yield* git(repo, "rev-parse", "--verify", `refs/tags/${release}^{commit}`),
      };
    let series = seriesRef;
    if (series === undefined) {
      yield* check(
        release !== undefined,
        "No fork-release tag on source first-parent history. Pass --series explicitly.",
      );
      yield* check(
        (yield* git(repo, "cat-file", "-t", `refs/tags/${release}`)) === "tag",
        "Release tag must be annotated. Pass --series explicitly.",
      );
      const annotation = yield* git(
        repo,
        "for-each-ref",
        "--format=%(contents)",
        `refs/tags/${release}`,
      );
      const matches = [...annotation.matchAll(/^Fork-Series: ([^\s]+)$/gm)];
      yield* check(
        matches.length === 1,
        "Release annotation requires exactly one Fork-Series line. Pass --series explicitly.",
      );
      series = matches[0]?.[1] ?? "";
      const exists = yield* command(repo, [
        "git",
        "rev-parse",
        "--verify",
        `refs/tags/${series}^{commit}`,
      ]);
      yield* check(
        exists.code === 0,
        `Release series ${series} does not exist. Pass --series explicitly.`,
      );
    }
    const ref = `refs/tags/${series?.replace(/^refs\/tags\//, "") ?? ""}`;
    yield* check(
      (yield* git(repo, "cat-file", "-t", ref)) === "tag",
      "The series tag must be annotated",
    );
    const message = yield* git(repo, "for-each-ref", "--format=%(contents)", ref);
    const boundaries = [...message.matchAll(/^Fork-Upstream: ([0-9a-f]{40})$/gm)];
    yield* check(
      boundaries.length === 1,
      "Series annotation requires exactly one Fork-Upstream SHA",
    );
    const base = boundaries[0]?.[1] ?? "";
    const tip = yield* git(repo, "rev-parse", "--verify", `${ref}^{commit}`);
    report.series = { ref: series ?? "", commit: tip };
    yield* git(repo, "merge-base", "--is-ancestor", base, tip);
    const ids = yield* runtimeIds(yield* git(repo, "show", `${tip}:${registryPath}`));
    const known = new Set([...ids, ...infrastructure]);
    const seriesCommits = yield* readCommits(
      repo,
      lines(yield* git(repo, "rev-list", "--reverse", `${base}..${tip}`)),
      known,
      "series",
    );
    yield* check(
      seriesCommits.blocked.length === 0,
      `Invalid series commits:\n${seriesCommits.blocked.join("\n")}`,
    );
    if (report.drift.release !== null) {
      const releaseCommit = report.drift.release.commit;
      const drift = yield* readCommits(
        repo,
        lines(
          yield* git(
            repo,
            "rev-list",
            "--first-parent",
            "--reverse",
            `${releaseCommit}..${source}`,
          ),
        ),
        known,
        "drift",
      );
      report.drift.commits = drift.commits;
      report.drift.blocked = drift.blocked;
      yield* check(
        drift.blocked.length === 0,
        `Unlabelled, unknown, or merge drift commits:\n${drift.blocked.join("\n")}`,
      );
    }
    return { ids, commits: [...seriesCommits.commits, ...report.drift.commits] };
  });

export const resolveUpstream = (repo: string, tag: string, url: string) =>
  Effect.gen(function* () {
    const refs = yield* git(
      repo,
      "ls-remote",
      "--",
      url,
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    );
    const remote = new Map(
      lines(refs).map((line) => {
        const [refSha = "", ref = ""] = line.split("\t");
        return [ref, refSha];
      }),
    );
    const expected = remote.get(`refs/tags/${tag}^{}`) ?? remote.get(`refs/tags/${tag}`);
    yield* check(expected !== undefined, `Upstream tag ${tag} does not exist`);
    const local = yield* command(repo, [
      "git",
      "rev-parse",
      "--verify",
      `refs/tags/${tag}^{commit}`,
    ]);
    if (local.code !== 0)
      yield* git(repo, "fetch", "--no-tags", url, `refs/tags/${tag}:refs/tags/${tag}`);
    const commit = yield* git(repo, "rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
    yield* check(
      commit === expected,
      `Upstream tag ${tag} differs. Local ${commit}. Upstream ${expected}. Review and replace the local tag before retrying.`,
    );
    return commit;
  });
