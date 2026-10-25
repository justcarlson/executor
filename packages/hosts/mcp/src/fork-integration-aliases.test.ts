import { text as aliasText } from "./fork-alias-guidance-slot";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolAddress,
  ToolName,
  IntegrationSlug,
  ConnectionName,
  type Tool,
} from "@executor-js/sdk";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { createExecutorMcpServer } from "./tool-server";
import { ALIAS_SEARCH_CALL_ANCHOR } from "./fork-alias-selection";
import { SEARCH_INVOKE_SKILL } from "./passthrough-tools";
import { GUIDANCE_KEYS } from "./fork-guidance-types";
import {
  liveGuidanceKeys,
  liveGuidanceDescriptions,
  guidanceTestEngine as engine,
} from "./fork-guidance-testing";

const catalog = [
  { slug: IntegrationSlug.make("google_gmail"), name: "Gmail", description: "Messages" },
  { slug: IntegrationSlug.make("google_calendar"), name: "Google Calendar", description: "Events" },
  { slug: IntegrationSlug.make("scrape_api"), name: "ScrapeCreators", description: "Profiles" },
];
const tools: readonly Tool[] = catalog.map((item) => ({
  address: ToolAddress.make(`tools.${item.slug}.org.main.profile`),
  name: ToolName.make("profile"),
  integration: item.slug,
  pluginId: "test",
  owner: "org",
  connection: ConnectionName.make("main"),
  description: "Read a profile.",
}));

describe("MCP alias selection", () => {
  for (const enabled of [false, true])
    it.effect(`resolves filters, envelopes, and display-name ranking with aliases ${enabled}`, () =>
      Effect.gen(function* () {
        const forkFeatures = enabled
          ? yield* parseForkFeatures({ explicitFeatures: "integration-aliases" })
          : forkFeaturesOff;
        let reads = 0;
        const server = yield* createExecutorMcpServer({
          engine,
          forkFeatures,
          mode: "passthrough",
          artifactsEnabled: false,
          integrations: {
            list: () =>
              Effect.sync(() => {
                reads++;
                return catalog;
              }),
          },
          connections: {
            list: () =>
              Effect.succeed(
                catalog.map((item) => ({
                  integration: item.slug,
                  name: "main",
                  owner: "org" as const,
                })),
              ),
          },
          tools: {
            list: (filter) =>
              Effect.succeed(
                tools.filter(
                  (tool) =>
                    filter?.integration === undefined || tool.integration === filter.integration,
                ),
              ),
            schema: (address) =>
              Effect.succeed(tools.find((tool) => tool.address === address) ?? null),
          },
        });
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "alias-test", version: "1.0.0" });
        yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
        yield* Effect.promise(async () => {
          await server.connect(b);
          await client.connect(a);
          const result = await client.callTool({
            name: "search",
            arguments: { query: "profile", integration: "gmail" },
          });
          expect(result.structuredContent).toMatchObject({ total: enabled ? 1 : 0 });
          expect(reads).toBe(enabled ? 1 : 0);
          const ranked = await client.callTool({
            name: "search",
            arguments: { query: "creators profile" },
          });
          expect(ranked.structuredContent).toMatchObject({ total: enabled ? 1 : 0 });
          for (const method of ["search", "integrations"]) {
            const call = (integration: string) =>
              client.callTool({ name: method, arguments: { integration, query: "profile" } });
            expect((await call("google_gmail")).structuredContent).toMatchObject({ total: 1 });
            const alias = await call("gmail");
            expect(alias.structuredContent).toMatchObject(
              enabled ? { integration: "google_gmail", total: 1 } : { total: 0 },
            );
            const ambiguous = await call("google");
            expect(ambiguous.structuredContent).toMatchObject(
              enabled
                ? { integrations: ["google_calendar", "google_gmail"], total: 2 }
                : { total: 0 },
            );
            const unknown = await call("missing");
            expect(JSON.stringify(unknown.structuredContent).includes("hint")).toBe(enabled);
          }
          const accounts = await client.callTool({
            name: "integrations",
            arguments: { integration: "google_gmail" },
          });
          expect(accounts.structuredContent).toMatchObject({
            items: [{ integrationDescription: "Messages" }],
          });
        });
      }).pipe(Effect.scoped),
    );
});

it(`finds alias anchor ${ALIAS_SEARCH_CALL_ANCHOR} exactly once in the live upstream guide`, () => {
  expect(
    SEARCH_INVOKE_SKILL.body
      .split("\n")
      .filter((line) => line.startsWith(ALIAS_SEARCH_CALL_ANCHOR)),
    ALIAS_SEARCH_CALL_ANCHOR,
  ).toHaveLength(1);
});
it.effect("finds each alias tool text key exactly once in live upstream registration", () =>
  Effect.gen(function* () {
    const keys = yield* liveGuidanceKeys;
    for (const anchor of [GUIDANCE_KEYS.integrationsIntegration, GUIDANCE_KEYS.searchIntegration]) {
      expect(
        keys.filter((key) => key === anchor),
        anchor,
      ).toHaveLength(1);
    }
  }),
);

it.effect("registers integration-aliases text on the live tool list", () =>
  Effect.gen(function* () {
    const features = yield* parseForkFeatures({ explicitFeatures: "integration-aliases" });
    const descriptions = new Map(yield* liveGuidanceDescriptions(features));
    for (const key of [GUIDANCE_KEYS.integrationsIntegration, GUIDANCE_KEYS.searchIntegration]) {
      expect(descriptions.get(key), key).toBe(aliasText(features, key, ""));
    }
  }),
);
