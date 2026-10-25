import { Match } from "effect";
import type { ToolPolicyAction, ToolPolicyRow } from "./core-schema";
import {
  comparePolicyRow,
  rowToToolPolicy,
  type PolicyMatch,
  type EffectivePolicy,
} from "./policies";

const actionRestrictionRank = (action: ToolPolicyAction): number =>
  Match.value(action).pipe(
    Match.when("block", () => 3),
    Match.when("require_approval", () => 2),
    Match.when("approve", () => 1),
    Match.exhaustive,
  );

const moreRestrictive = <T extends { readonly action: ToolPolicyAction }>(
  current: T | undefined,
  candidate: T,
): T => {
  if (!current) return candidate;
  const currentRank = actionRestrictionRank(current.action);
  const candidateRank = actionRestrictionRank(candidate.action);
  return candidateRank > currentRank ? candidate : current;
};

const liftPlugin = (defaultRequiresApproval: boolean | undefined): EffectivePolicy =>
  defaultRequiresApproval
    ? { action: "require_approval", source: "plugin-default" }
    : { action: "approve", source: "plugin-default" };

const liftUser = (match: PolicyMatch): EffectivePolicy => ({
  action: match.action,
  source: "user",
  pattern: match.pattern,
  policyId: match.policyId,
});

interface PreparedRule {
  /** Index in the global (ownerRank, position, id) sort order. */
  readonly index: number;
  readonly match: PolicyMatch;
  /** Split pattern; only set for wildcard rules. */
  readonly segments: readonly string[];
}

interface PreparedOwnerRules {
  /** Exact patterns → the owner's earliest rule with that pattern. */
  readonly exact: Map<string, PreparedRule>;
  /** Wildcard patterns keyed by their literal first segment, in sort order. */
  readonly wildcardByHead: Map<string, PreparedRule[]>;
  /** Wildcard patterns whose first segment is `*` (includes universal `*`). */
  readonly wildcardAnyHead: PreparedRule[];
}

/** `matchPattern` over pre-split segments. Kept in lockstep with it. */
const matchSegments = (
  patternSegments: readonly string[],
  toolSegments: readonly string[],
): boolean => {
  for (let i = 0; i < patternSegments.length; i++) {
    const seg = patternSegments[i]!;
    if (seg === "*") {
      if (i === patternSegments.length - 1) return toolSegments.length >= i;
      if (i >= toolSegments.length) return false;
      continue;
    }
    if (i >= toolSegments.length || toolSegments[i] !== seg) return false;
  }
  return patternSegments.length === toolSegments.length;
};

/** First rule in `rules` (sort order) that matches and sorts before `best`. */
const firstWildcardMatch = (
  rules: readonly PreparedRule[] | undefined,
  toolSegments: readonly string[],
  best: PreparedRule | undefined,
): PreparedRule | undefined => {
  if (!rules) return best;
  for (const rule of rules) {
    if (best && rule.index > best.index) return best;
    if (matchSegments(rule.segments, toolSegments)) return rule;
  }
  return best;
};

export interface PreparedToolPolicies {
  /** Same result as `resolveToolPolicy(toolId, policies, ownerRank)`. */
  readonly resolve: (toolId: string) => PolicyMatch | undefined;
  /** Same result as `resolveEffectivePolicy(toolId, policies, ownerRank, d)`. */
  readonly resolveEffective: (toolId: string, defaultRequiresApproval?: boolean) => EffectivePolicy;
}

export const prepareToolPolicies = (
  policies: readonly ToolPolicyRow[],
  ownerRank: (row: Pick<ToolPolicyRow, "owner">) => number,
): PreparedToolPolicies => {
  const sorted = [...policies].sort((a, b) => {
    const sa = ownerRank(a);
    const sb = ownerRank(b);
    if (sa !== sb) return sa - sb;
    return comparePolicyRow(a, b);
  });
  const owners = new Map<string, PreparedOwnerRules>();
  sorted.forEach((row, index) => {
    let ownerRules = owners.get(row.owner);
    if (!ownerRules) {
      ownerRules = { exact: new Map(), wildcardByHead: new Map(), wildcardAnyHead: [] };
      owners.set(row.owner, ownerRules);
    }
    const match: PolicyMatch = {
      action: rowToToolPolicy(row).action,
      pattern: row.pattern,
      policyId: row.id,
    };
    const segments = row.pattern.split(".");
    // `matchPattern` treats only a whole `*` segment as a wildcard; any other
    // pattern matches exactly when it equals the tool id.
    if (row.pattern !== "*" && !segments.includes("*")) {
      if (!ownerRules.exact.has(row.pattern)) {
        ownerRules.exact.set(row.pattern, { index, match, segments: [] });
      }
      return;
    }
    const rule: PreparedRule = { index, match, segments: row.pattern === "*" ? ["*"] : segments };
    const head = rule.segments[0]!;
    if (head === "*") {
      ownerRules.wildcardAnyHead.push(rule);
    } else {
      const bucket = ownerRules.wildcardByHead.get(head);
      if (bucket) bucket.push(rule);
      else ownerRules.wildcardByHead.set(head, [rule]);
    }
  });
  const ownerList = [...owners.values()];

  const resolve = (toolId: string): PolicyMatch | undefined => {
    if (ownerList.length === 0) return undefined;
    const toolSegments = toolId.split(".");
    const found: PreparedRule[] = [];
    for (const ownerRules of ownerList) {
      let best = ownerRules.exact.get(toolId);
      best = firstWildcardMatch(
        ownerRules.wildcardByHead.get(toolSegments[0]!),
        toolSegments,
        best,
      );
      best = firstWildcardMatch(ownerRules.wildcardAnyHead, toolSegments, best);
      if (best) found.push(best);
    }
    // `resolveToolPolicy` combines owners in the order their first match
    // appears in the global sort; equal restriction keeps the earlier one.
    found.sort((a, b) => a.index - b.index);
    let selected: PolicyMatch | undefined;
    for (const rule of found) selected = moreRestrictive(selected, rule.match);
    return selected;
  };

  return {
    resolve,
    resolveEffective: (toolId, defaultRequiresApproval) => {
      const match = resolve(toolId);
      return match ? liftUser(match) : liftPlugin(defaultRequiresApproval);
    },
  };
};
