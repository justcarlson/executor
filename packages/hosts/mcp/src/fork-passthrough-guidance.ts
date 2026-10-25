import { GUIDANCE_KEYS } from "./fork-guidance-types";
import type { ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "@executor-js/execution";
export const PASSTHROUGH_BASE_INSTRUCTIONS = [
  "Executor runs tools of connected integrations. Fastest path, three calls:",
  "1. integrations({}) once, to learn the integration slugs and accounts (skip when you already know the slug).",
  '2. search({ query: "<action words>", integration: "<slug or alias>", limit: 3 }). Hits are compact: id, one-line description, and an argument summary.',
  "3. invoke({ tool: <hit id>, arguments: { ... } }).",
  'Example: search({ query: "create issue", integration: "github", limit: 3 }) then invoke({ tool: "tools.github.org.main.issues.create", arguments: { title: "Bug" } }).',
  'Use detail: "full" on search only when the argument summary is not enough; an invoke rejected for invalid arguments also returns the schema.',
  'Invoke can change external state; your client handles approval and workspace blocks stay enforced. skills({ name: "search-invoke" }) has the long guide.',
].join("\n");

export const forkPassthroughInstructions = (features: ForkFeatures): string =>
  PASSTHROUGH_BASE_INSTRUCTIONS.replace(
    "slug or alias",
    features.has("integration-aliases") ? "slug or alias" : "slug",
  )
    .replace(
      "Hits are compact: id, one-line description, and an argument summary.",
      features.has("compact-search")
        ? "Hits are compact: id, one-line description, and an argument summary."
        : "Hits include id, description, and the complete inputSchema.",
    )
    .replace(
      'Use detail: "full" on search only when the argument summary is not enough; an invoke rejected for invalid arguments also returns the schema.\n',
      features.has("compact-search")
        ? 'Use detail: "full" on search only when the argument summary is not enough; an invoke rejected for invalid arguments also returns the schema.\n'
        : "",
    );

export const SEARCH_GUIDE_PAGE_ANCHOR =
  "Search returns at most 20 tools per page, with schemas only for those matches.";

export const forkSearchInvokeSkill = (skill: Skill): Skill => ({
  ...skill,
  body: skill.body.replace(
    SEARCH_GUIDE_PAGE_ANCHOR,
    "Search returns at most 20 tools per page; prefer `limit: 3` with an `integration` filter.",
  ),
});

const forkPassthroughTexts = (features: ForkFeatures) => {
  const aliases = features.has("integration-aliases");
  const compact = features.has("compact-search");
  const text = {
    [GUIDANCE_KEYS.integrationsDescription]:
      "List connected integrations and accounts: slug, name, owner, connection, last health. Call once to learn the exact slug for search; skip it when you already know the slug.",
    [GUIDANCE_KEYS.integrationsIntegration]: aliases
      ? "Slug or alias (gmail resolves to google_gmail)."
      : "Exact integration slug.",
    [GUIDANCE_KEYS.searchDescription]: compact
      ? "Find tools by action words. Fastest: pass integration (slug or alias) and limit 3. Each hit has id, one-line description, and arguments (name (type, required)); pass id and arguments to invoke. detail: full adds the complete inputSchema (large) when the summary is not enough. Page with offset: nextOffset.".replace(
          "slug or alias",
          aliases ? "slug or alias" : "slug",
        )
      : "Find tools by action words. Pass integration and limit 3. Each hit has id, description, and the complete inputSchema; pass id and arguments to invoke. Page with offset: nextOffset.",
    [GUIDANCE_KEYS.searchQuery]: "Action words, such as create issue or list dns records.",
    [GUIDANCE_KEYS.searchIntegration]: aliases
      ? "Slug or alias (gmail resolves to google_gmail); the result reports the slug."
      : "Exact integration slug from integrations.",
    [GUIDANCE_KEYS.searchConnection]:
      "Account name from integrations; pair with integration and owner.",
    [GUIDANCE_KEYS.searchDetail]: "full adds the complete inputSchema per hit; use with limit 1-3.",
    [GUIDANCE_KEYS.invokeDescription]: compact
      ? "Call one tool by the exact id from search with a JSON arguments object. Returns the tool's result; an invalid-arguments error includes the expected inputSchema, so correct and retry. May change external state; your client handles approval and workspace blocks stay enforced."
      : "Call one tool by the exact id from search with a JSON arguments object. Returns the tool's result. May change external state; your client handles approval and workspace blocks stay enforced.",
    [GUIDANCE_KEYS.invokeTool]: "Exact id from a search hit.",
    [GUIDANCE_KEYS.invokeArguments]: compact
      ? "JSON object matching the hit's arguments summary or inputSchema."
      : "JSON object matching the hit's inputSchema.",
    [GUIDANCE_KEYS.skillsDescription]: aliases
      ? 'Guides for this server only, not harness or project skills. skills({ name: "search-invoke" }) explains discovery, aliases, pagination, and approval; no name lists the guides.'
      : 'Guides for this server only, not harness or project skills. skills({ name: "search-invoke" }) explains discovery, pagination, and approval; no name lists the guides.',
    [GUIDANCE_KEYS.skillsName]: 'Guide name, e.g. "search-invoke". Omit to list guides.',
  };
  return text;
};

export const forkPassthroughText = (
  features: ForkFeatures,
  key: keyof ReturnType<typeof forkPassthroughTexts>,
): string => forkPassthroughTexts(features)[key];
