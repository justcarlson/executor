import { Effect } from "effect";
import type { Executor } from "@executor-js/sdk";
import type { Skill } from "./skills";
import { ExecutionToolError } from "./errors";

export type IntegrationCatalogEntry = {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
};

export type IntegrationResolution =
  | { readonly kind: "exact" | "alias"; readonly slug: string }
  | { readonly kind: "ambiguous"; readonly slugs: readonly string[] }
  | { readonly kind: "none" };

const aliasTokens = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const squash = (value: string): string => aliasTokens(value).join("");

export const resolveIntegrationAlias = (
  input: string,
  catalog: readonly IntegrationCatalogEntry[],
): IntegrationResolution => {
  const trimmed = input.trim();
  if (catalog.some((entry) => entry.slug === trimmed)) return { kind: "exact", slug: trimmed };
  const words = aliasTokens(trimmed);
  const squashed = squash(trimmed);
  if (words.length === 0) return { kind: "none" };
  const covers = (haystack: readonly string[]) => words.every((word) => haystack.includes(word));
  const tiers: ReadonlyArray<(entry: IntegrationCatalogEntry) => boolean> = [
    (entry) => squash(entry.slug) === squashed || squash(entry.name) === squashed,
    (entry) => covers([...aliasTokens(entry.slug), ...aliasTokens(entry.name)]),
    (entry) => covers(aliasTokens(entry.description ?? "")),
  ];
  for (const matches of tiers) {
    const slugs = [...new Set(catalog.filter(matches).map((entry) => entry.slug))].sort();
    if (slugs.length === 1) return { kind: "alias", slug: slugs[0]! };
    if (slugs.length > 1) return { kind: "ambiguous", slugs };
  }
  return { kind: "none" };
};

export const integrationAliasText = (
  catalog: readonly IntegrationCatalogEntry[],
): ReadonlyMap<string, string> => {
  const aliases = new Map<string, string>();
  for (const entry of catalog) {
    const slugTokens = new Set(aliasTokens(entry.slug));
    const nameTokens = aliasTokens(entry.name);
    const candidates = nameTokens.length > 1 ? [...nameTokens, nameTokens.join("")] : nameTokens;
    const extra = [...new Set(candidates)].filter((token) => !slugTokens.has(token));
    if (extra.length > 0) aliases.set(entry.slug, extra.join(" "));
  }
  return aliases;
};

export const searchAliasContext = (
  integrations: Pick<Executor["integrations"], "list">,
  namespace: string | undefined,
) =>
  Effect.gen(function* () {
    const catalog = yield* integrations
      .list()
      .pipe(
        Effect.mapError(
          (cause) =>
            new ExecutionToolError({ message: "Failed to list integrations for search", cause }),
        ),
      );
    const resolved =
      namespace === undefined ? undefined : resolveIntegrationAlias(namespace, catalog);
    return {
      namespace: resolved?.kind === "alias" ? resolved.slug : namespace,
      integrationAliases: integrationAliasText(catalog),
    };
  });

export const ALIAS_EXECUTE_KNOWN_ANCHOR = "- When you already know";

export const ALIAS_EXECUTE_SKILL_NAME = "execute";

export const withAliasInstructions = (skill: Skill): Skill =>
  skill.name !== ALIAS_EXECUTE_SKILL_NAME
    ? skill
    : {
        ...skill,
        body: skill.body
          .split("\n")
          .map((line) =>
            line.startsWith(ALIAS_EXECUTE_KNOWN_ANCHOR)
              ? '- When you already know the integration, narrow with `tools.search({ namespace: "github", query: "issues", limit: 3 })`. `namespace` accepts the slug or an unambiguous alias (`gmail` resolves to `google_gmail`); an alias that fits several integrations is used as a prefix instead.'
              : line,
          )
          .join("\n"),
      };
