# Upgrade and land the fork

Run from a clean source checkout. The output directory must be new and outside that checkout.

1. Fetch the fork remote and its tags, then run the upgrade.

   ```sh
   git fetch --tags origin
   bun run fork/upgrade.ts v1.6.12 --out /tmp/executor-v1.6.12
   ```

   The default source is `origin/main`. The command reads that remote's branch and `fork-release/*` and `fork-series/*` tags with `git ls-remote`. A newer branch, a missing or changed remote tag, or an unreadable remote stops the run before cloning. Local-only tags are allowed. For missing tags, the command prints a fetch command. For moved tags, it prints both SHAs. Review the change and replace the local tag before retrying.

   A local branch or full commit SHA passed through `--source <ref>` is used as given. The report records that no freshness check ran. The command writes no source refs, index, worktrees, or configuration.

   Without `--series`, the newest `fork-release/*` tag on the source's first-parent history selects the series. Its annotation must contain one `Fork-Series: <series tag>` line. The named tag must exist. Otherwise, pass `--series <tag ref>` explicitly. Creation dates and unlanded series tags do not select the default. Drift starts at that same release tag. With an explicit series and no release tag, the report records that drift validation was skipped.

   The annotated series tag must contain `Fork-Upstream: <full SHA>`. Each series or drift commit must have one parent and exactly one known `Fork-Feature:` line. Runtime IDs come from the SDK schema. The command checks the budget table against that schema. It also checks the requested upstream tag against the upstream remote, even when that tag exists locally. A mismatch blocks replay and prints both commit SHAs.

2. Review `<out>/report.md`, `<out>/report.json`, and the gate logs. Run this required fork e2e check in the candidate checkout.

   ```sh
   env -u EXECUTOR_FORK_FEATURES EXECUTOR_FORK_PROFILE=production-v1 bun run --cwd e2e test:selfhost scenarios/fork-
   ```

   The final argument is a Vitest file filter for every `e2e/scenarios/fork-*.test.ts` file. Review its recording or trace before landing.

   Gates inherit your environment. After bootstrap, the candidate runs the root formatting, lint, typecheck, and test gates, plus `bunx tsgo -p fork/tsconfig.json` and `bunx vitest run --config fork/vitest.config.ts`. Fixture tests supply their own gate list through the function API to avoid recursion. The CLI always uses all gates.

   Repeat `--test-arg=<arg>` to append arguments to the root test command in order. The command restores bootstrap changes to `bun.lock` and records them. It rejects configured remote Turbo caching and reports inherited `TURBO_CACHE*` values. No cache is copied into the clone.

   Results are `READY_FOR_REVIEW`, `REDUCED_FEATURE_SET`, `FAILED_GATES`, and `BLOCKED_REPLAY`. Their exit codes are 0, 0, 1, and 2. CLI syntax errors exit with code 64. A reduced selection requires review. Passing gates does not prove production parity.

3. Run the printed `git fetch` command in the source repository. It imports the candidate branch and the new series tag from the disposable clone. Keep the clone until import succeeds.

   Reports include the source ref and commit, the release tag, freshness results, replay passes and conflicts, selections, budgets, and logs. The series tag points before the receipt commit. The next replay therefore excludes that generated receipt. The receipt has only `upstreamCommit`, `available`, and `production`.

4. Create a bridge commit for a landing PR. Its tree must equal the candidate tip's tree. Its first parent must be the source commit from the report. Its second parent must be the candidate tip.

   Run these commands after importing the candidate refs. Set `report` to the run's JSON report.

   ```sh
   report=/tmp/executor-v1.6.12/report.json
   source_commit=$(jq -r '.drift.source.commit' "$report")
   candidate=$(jq -r '.candidate.commit' "$report")
   git fetch --tags origin
   test "$(git rev-parse origin/main)" = "$source_commit"
   bridge=$(git commit-tree "${candidate}^{tree}" -p "$source_commit" -p "$candidate" -m 'Land the reviewed upstream upgrade')
   git branch land-upstream-upgrade "$bridge"
   ```

   Stop if the `test` command fails. Push the bridge branch and open a PR to main for review. Do not use the merge button. After review, land the bridge with a fast-forward push. This push block can run in a new shell.

   ```sh
   bridge=$(git rev-parse land-upstream-upgrade) &&
     git push origin "${bridge}:refs/heads/main"
   ```

   Git rejects the push if main moved after the bridge was built. Nothing lands in that case. Do not force the push. Run the upgrade again from the new main.

5. Fetch main after landing. Find the first commit on main's first-parent history that is the bridge or has the bridge as its second parent. Check its source parent and candidate tree before tagging. This also accepts a merge-button landing when main did not move. This step can run in a new shell. Set `report` to the run's JSON report and keep the `land-upstream-upgrade` branch until tagging succeeds. Choose an unused release number.

   ```sh
   : "${report:?Set report to the JSON report of the upgrade run whose bridge landed}"
   git fetch --tags origin
   if bridge=$(git rev-parse land-upstream-upgrade) &&
      landing_commit=$(git rev-list --first-parent --parents origin/main | awk -v b="$bridge" '$1 == b || $3 == b { print $1; exit }') &&
      test -n "$landing_commit" &&
      test "$(git rev-parse "${landing_commit}^1")" = "$(jq -r '.drift.source.commit' "$report")" &&
      test "$(git rev-parse "${landing_commit}^{tree}")" = "$(git rev-parse "$(jq -r '.candidate.commit' "$report")^{tree}")" &&
      test "$(jq -r '.candidate.commit' "$report")" = "$(git rev-parse "${bridge}^2")"
   then
     series_tag=$(jq -r '.nextSeries.ref' "$report")
     upstream_commit=$(jq -r '.upstream.commit' "$report")
     upstream_tag=$(jq -r '.upstream.tag' "$report")
     release_number=1
     release_tag="fork-release/${upstream_tag}-${release_number}"
     git tag -a "$release_tag" "$landing_commit" -m "Fork release ${upstream_tag}

   Fork-Series: ${series_tag}
   Fork-Upstream: ${upstream_commit}" &&
     git push origin "refs/tags/${release_tag}" "refs/tags/${series_tag}"
   else
     printf '%s\n' 'No checked landing commit found. Check the bridge on main, its source parent, its candidate tree, and the report candidate against the bridge second parent.' >&2
     false
   fi
   ```

   If a check fails, no tag is created. Verify that the landing is on main's first-parent history, its first parent equals the report's source commit, its tree equals the report's candidate tree, and the report's candidate equals the bridge's second parent. A merge after main moved fails these checks. The upgrade command rejects merge commits in drift, so rerunning the upgrade from that merge is not a recovery path. Push both tags after all checks pass. The release tag belongs at the landing commit, which is the bridge for a fast-forward push.

6. Land later fixes on main with squash or rebase merges. Each first-parent commit must be a non-merge commit with exactly one `Fork-Feature:` ID. These commits replay as drift on the next upgrade.

7. Before landing a reduced selection, prefer to resolve the conflict, record it with rerere, and rerun with `--rerere-cache <dir>`. A `conflict-omitted` feature leaves the new series entirely. To restore it after a reduced landing, port it to main as a drift commit with its feature ID.

Use `--omit <id>` to remove every commit of a feature, including drift fixes. An unresolved runtime feature conflict restarts replay from upstream with that whole feature omitted. Each pass and the conflict that ended it appear in the report. Conflicts in `foundation` or `fork-tooling` block the run. Neither ID can be omitted. Use `--off <id>` to keep runtime code while excluding it from production.

An empty pick is recorded as `already-upstream` and keeps its feature available. A pick record also says when rerere produced the empty result. The command skips that pick and continues. When all picks for a feature are already upstream, the series keeps one empty marker commit with its `Fork-Feature:` and `Fork-Class:` trailers. A replayed marker is reported as `upstream-marker` and keeps the feature available and in production unless disabled. It records a previous upstream adoption, so review whether the new upstream still supplies that behavior. The next replay replaces that marker with one marker, so the record does not accumulate. The imported series tag preserves it through the bridge and release protocol.

Use `--run-id <id>` for predictable candidate and series names. Use `--rerere-cache <dir>` to seed saved resolutions. Relative cache paths resolve against the directory where you invoke the command. Each run saves its cache under `<out>/rr-cache`. Review a resolution before reusing it. The command never chooses a conflict side automatically.

To record a resolution, recreate the failed pass up to its conflicting pick in a disposable checkout. Use the pass entries and input SHAs in the report. Enable rerere before repeating that pick.

```sh
git -c rerere.enabled=true -c rerere.autoupdate=false cherry-pick -x "$conflicting_commit"
```

Resolve each conflicting file and review the diff. Record the resolution before staging the resolved paths.

```sh
git -c rerere.enabled=true -c rerere.autoupdate=false rerere
git add -- path/to/resolved-file
```

If `git diff --cached --quiet` succeeds, run `git cherry-pick --skip`. Otherwise, run `git -c rerere.enabled=true cherry-pick --continue`. Get the absolute cache path in that disposable checkout.

```sh
git rev-parse --path-format=absolute --git-path rr-cache
```

Rerun the upgrade from the clean source checkout with `--rerere-cache <absolute cache path>` and a new output directory. Review each reused resolution in the report. A run also exports its learned cache to `<out>/rr-cache` for later reuse.

Run the Git fixture proofs and the tooling typecheck directly.

```sh
bunx vitest run --config fork/vitest.config.ts
bunx tsgo -p fork/tsconfig.json
```

The root workspace typecheck and tests do not include `fork/`.

Run the omission typecheck matrix once per curated series. It reuses one disposable clone and its dependencies when the lockfile stays equal. Its output directory must be new. The matrix accepts only `--out`, `--series`, and `--source`. It rejects upgrade flags that it cannot apply.

```sh
bun run fork/omit-matrix.ts v1.6.11 --out .turbo/fork-omit-matrix --series fork-series/initial
```
