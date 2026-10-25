import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { createExecutor, definePlugin, tool } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { createExecutionEngine } from "./engine";
import { searchTools } from "./tool-invoker";
import { integrationAliasText, resolveIntegrationAlias } from "./integration-aliases";
import { EXECUTE_SKILL } from "./skills";
import { ALIAS_EXECUTE_KNOWN_ANCHOR } from "./integration-aliases";
import { SKILLS } from "./skills";
import { ALIAS_EXECUTE_SKILL_NAME } from "./integration-aliases";

const catalog = [
  { slug: "google_gmail", name: "Gmail", description: "Mail and messages" },
  { slug: "google_calendar", name: "Google Calendar", description: "Events" },
  { slug: "scrape_api", name: "ScrapeCreators", description: "Profiles" },
];

it("resolves exact slugs, names, ambiguous words, descriptions, and unknown aliases", () => {
  expect(resolveIntegrationAlias("google_gmail", catalog)).toEqual({
    kind: "exact",
    slug: "google_gmail",
  });
  expect(resolveIntegrationAlias("GMAIL", catalog)).toEqual({
    kind: "alias",
    slug: "google_gmail",
  });
  expect(resolveIntegrationAlias("Google Calendar", catalog)).toEqual({
    kind: "alias",
    slug: "google_calendar",
  });
  expect(resolveIntegrationAlias("google", catalog)).toEqual({
    kind: "ambiguous",
    slugs: ["google_calendar", "google_gmail"],
  });
  expect(resolveIntegrationAlias("messages", catalog)).toEqual({
    kind: "alias",
    slug: "google_gmail",
  });
  expect(resolveIntegrationAlias("missing", catalog)).toEqual({ kind: "none" });
  expect(integrationAliasText(catalog).get("scrape_api")).toBe("creators scrapecreators");
});

const plugin = definePlugin(() => ({
  id: "alias-test" as const,
  storage: () => ({}),
  staticIntegrations: () =>
    catalog.map((entry) => ({
      id: entry.slug,
      kind: "in-memory" as const,
      name: entry.name,
      description: entry.description,
      tools: [
        tool({
          name: "profile",
          description: "Read a profile.",
          inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
          execute: () => Effect.succeed({}),
        }),
      ],
    })),
}));

describe("sandbox alias discovery", () => {
  for (const enabled of [false, true]) {
    it.effect(`uses the selected catalog resolution with aliases ${enabled}`, () =>
      Effect.gen(function* () {
        const forkFeatures = enabled
          ? yield* parseForkFeatures({ explicitFeatures: "integration-aliases" })
          : forkFeaturesOff;
        const executor = yield* createExecutor({
          ...makeTestConfig({ plugins: [plugin()] as const }),
          forkFeatures,
        });
        const engine = createExecutionEngine({
          executor,
          codeExecutor: makeQuickJsExecutor(),
          forkFeatures,
        });
        yield* Effect.addFinalizer(() =>
          engine.shutdown.pipe(Effect.andThen(executor.close()), Effect.orDie),
        );
        const enumerated = yield* searchTools(executor, "", 10, {
          namespace: "gmail",
          forkFeatures,
        });
        expect(enumerated.items.map((item) => item.integration)).toEqual(
          enabled ? ["google_gmail"] : [],
        );
        const exact = yield* searchTools(executor, "", 10, {
          namespace: "google_gmail",
          forkFeatures,
        });
        expect(exact.total).toBe(1);
        const ambiguous = yield* searchTools(executor, "", 10, {
          namespace: "google",
          forkFeatures,
        });
        expect(ambiguous.total).toBe(0);
        const ranked = yield* searchTools(executor, "creators profile", 10, { forkFeatures });
        expect(ranked.items.map((item) => item.integration)).toEqual(enabled ? ["scrape_api"] : []);
        const result = yield* engine.execute('return await tools.search({ namespace: "gmail" });', {
          onElicitation: () => Effect.succeed({ action: "accept" }),
        });
        expect(result.error).toBeUndefined();
        expect(result.result).toMatchObject({ total: enabled ? 1 : 0 });
      }).pipe(Effect.scoped),
    );
  }
});

it(`finds alias anchor ${ALIAS_EXECUTE_KNOWN_ANCHOR} exactly once in the live upstream guide`, () => {
  expect(
    EXECUTE_SKILL.body.split("\n").filter((line) => line.startsWith(ALIAS_EXECUTE_KNOWN_ANCHOR)),
    ALIAS_EXECUTE_KNOWN_ANCHOR,
  ).toHaveLength(1);
});

it("finds the alias execute skill key exactly once in the live upstream catalog", () => {
  expect(
    SKILLS.filter((skill) => skill.name === ALIAS_EXECUTE_SKILL_NAME),
    ALIAS_EXECUTE_SKILL_NAME,
  ).toHaveLength(1);
});
