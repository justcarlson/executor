import {
  resolveIntegrationAlias,
  type IntegrationResolution,
  type IntegrationCatalogEntry,
  type Skill,
} from "@executor-js/execution";
export const selectedIntegrations = (
  resolution: IntegrationResolution | undefined,
  input: string | undefined,
): { readonly slugs: ReadonlySet<string> | null; readonly envelope: Record<string, unknown> } => {
  if (resolution === undefined || input === undefined) return { slugs: null, envelope: {} };
  if (resolution.kind === "exact") return { slugs: new Set([resolution.slug]), envelope: {} };
  if (resolution.kind === "alias")
    return { slugs: new Set([resolution.slug]), envelope: { integration: resolution.slug } };
  if (resolution.kind === "ambiguous")
    return { slugs: new Set(resolution.slugs), envelope: { integrations: resolution.slugs } };
  return {
    slugs: new Set([input]),
    envelope: {
      hint: `No integration matches "${input}". Call integrations to list the connected slugs.`,
    },
  };
};

export const selectIntegration = (
  input: string | undefined,
  catalog: readonly IntegrationCatalogEntry[],
) => {
  const selected = selectedIntegrations(
    input === undefined ? undefined : resolveIntegrationAlias(input, catalog),
    input,
  );
  return {
    ...selected,
    exactSlug: selected.slugs?.size === 1 ? [...selected.slugs][0] : undefined,
  };
};
export const ALIAS_INSTRUCTIONS =
  "Integration filters accept slugs or unambiguous aliases such as gmail. Ambiguous aliases list their candidate integrations.";
export const ALIAS_SEARCH_CALL_ANCHOR = "2. Call";

export const aliasSearchInvokeSkill = (skill: Skill): Skill => ({
  ...skill,
  body: skill.body
    .split("\n")
    .map((line) =>
      line.startsWith(ALIAS_SEARCH_CALL_ANCHOR)
        ? '2. Call `search({ query: "create issue", integration: "github", owner: "org", connection: "main" })`. Use the integration, owner, and connection returned by integrations to select an account. `integration` also accepts an unambiguous alias (`gmail` resolves to `google_gmail`); the result reports the resolved slug as `integration`, lists candidates as `integrations` when the alias is ambiguous, or adds a `hint` when nothing matches. Omit filters to search across accounts visible to you.'
        : line,
    )
    .join("\n"),
});
