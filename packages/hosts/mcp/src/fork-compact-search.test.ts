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
import { describe, expect, it } from "@effect/vitest";
import {
  COMPACT_SEARCH_DESCRIPTION,
  COMPACT_SEARCH_DETAIL,
  compactDescription,
  compactArguments,
  COMPACT_DESCRIPTION_LIMIT,
  COMPACT_ARGUMENT_LIMIT,
} from "./fork-compact-search";
import { COMPACT_SEARCH_READ_ANCHOR } from "./fork-compact-search";
import { SEARCH_INVOKE_SKILL } from "./passthrough-tools";
import { GUIDANCE_KEYS } from "./fork-guidance-types";
import {
  liveGuidanceKeys,
  liveGuidanceDescriptions,
  guidanceTestEngine as engine,
} from "./fork-guidance-testing";

describe("compact search hits", () => {
  it("keeps the first sentence of a description within the limit", () => {
    expect(compactDescription(undefined)).toBe("");
    expect(compactDescription("  \nList DNS records. Supports paging.\nMore.")).toBe(
      "List DNS records.",
    );
    expect(compactDescription("No. Period means something else here, keep going")).toBe(
      "No. Period means something else here, keep going",
    );
    const long = `Create ${"x".repeat(400)} end`;
    const compact = compactDescription(long);
    expect(compact.length).toBe(COMPACT_DESCRIPTION_LIMIT);
    expect(compact.endsWith("…")).toBe(true);
  });

  it("summarizes arguments with types, required first, enums, arrays, refs and a cap", () => {
    expect(compactArguments(undefined)).toBe("none");
    expect(compactArguments({ type: "object" })).toBe("none");
    expect(compactArguments({ oneOf: [{ type: "string" }, { type: "object" }] })).toBe(
      "see full schema",
    );
    expect(
      compactArguments(
        {
          type: "object",
          properties: {
            optional: { type: ["string", "null"] },
            zone: { $ref: "#/$defs/Zone" },
            kind: { enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"] },
            tags: { type: "array", items: { $ref: "#/$defs/Tag" } },
            either: { anyOf: [{ type: "string" }, { type: "number" }] },
            nested: { properties: { a: { type: "string" } } },
            body: {
              type: "object",
              properties: { text: { type: "string" }, title: { type: "string" } },
              required: ["text"],
            },
            fixed: { const: 7 },
          },
          required: ["zone", "kind"],
        },
        { Zone: { type: "string" }, Tag: { type: "object", properties: {} } },
      ),
    ).toBe(
      "zone (string, required); kind (A|AAAA|CNAME|MX|TXT|NS|…, required); optional (string); tags (object[]); either (string|number); nested (object{a}); body (object{text*, title}); fixed (7)",
    );
    const wideBody = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`k${i}`, { type: "string" }]),
    );
    expect(
      compactArguments({
        type: "object",
        properties: { body: { type: "object", properties: wideBody } },
      }),
    ).toBe("body (object{k0, k1, k2, k3, k4, k5, +3})");
    const wide = Object.fromEntries(
      Array.from({ length: COMPACT_ARGUMENT_LIMIT + 3 }, (_, i) => [`p${i}`, { type: "string" }]),
    );
    const summary = compactArguments({ type: "object", properties: wide });
    expect(summary.split("; ")).toHaveLength(COMPACT_ARGUMENT_LIMIT + 1);
    expect(summary.endsWith("; +3 more")).toBe(true);
  });
});

const inputSchema = {
  type: "object",
  properties: {
    body: {
      type: "object",
      properties: {
        title: { type: "string" },
        text: { type: "string" },
      },
      required: ["title"],
    },
  },
  required: ["body"],
};
const tool: Tool = {
  address: ToolAddress.make("tools.sample.org.main.create"),
  integration: IntegrationSlug.make("sample"),
  owner: "org",
  connection: ConnectionName.make("main"),
  name: ToolName.make("create"),
  pluginId: "sample",
  description: "Create a sample. More details.",
  inputSchema,
};

for (const enabled of [false, true]) {
  it.effect(`gates the registration schema, hits, and feedback with compact ${enabled}`, () =>
    Effect.gen(function* () {
      const forkFeatures = enabled
        ? yield* parseForkFeatures({ explicitFeatures: "compact-search" })
        : forkFeaturesOff;
      const server = yield* createExecutorMcpServer({
        engine,
        forkFeatures,
        mode: "passthrough",
        artifactsEnabled: false,
        tools: { list: () => Effect.succeed([tool]), schema: () => Effect.succeed(tool) },
        integrations: { list: () => Effect.succeed([]) },
        connections: { list: () => Effect.succeed([]) },
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "compact-test", version: "1.0.0" });
      yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
      yield* Effect.promise(async () => {
        await server.connect(b);
        await client.connect(a);
        const list = await client.listTools();
        expect(list.tools.find((t) => t.name === "search")?.inputSchema.properties).toHaveProperty(
          "query",
        );
        expect(
          Object.keys(
            list.tools.find((t) => t.name === "search")?.inputSchema.properties ?? {},
          ).includes("detail"),
        ).toBe(enabled);
        const full = {
          id: String(tool.address),
          name: "create",
          integration: "sample",
          owner: "org",
          connection: "main",
          description: tool.description,
          inputSchema,
        };
        const compact = {
          id: String(tool.address),
          name: "create",
          integration: "sample",
          owner: "org",
          connection: "main",
          description: "Create a sample.",
          arguments: "body (object{title*, text}, required)",
        };
        const result = await client.callTool({ name: "search", arguments: { query: "create" } });
        expect(result.structuredContent).toEqual({
          items: [enabled ? compact : full],
          total: 1,
          hasMore: false,
          nextOffset: null,
        });
        const detailed = await client.callTool({
          name: "search",
          arguments: { query: "create", detail: "full" },
        });
        expect(detailed.structuredContent).toEqual({
          items: [full],
          total: 1,
          hasMore: false,
          nextOffset: null,
        });
        const invalid = await client.callTool({
          name: "invoke",
          arguments: { tool: String(tool.address), arguments: {} },
        });
        expect(invalid.isError).toBe(true);
        expect(JSON.stringify(invalid.content).includes("Expected inputSchema:")).toBe(enabled);
      });
    }).pipe(Effect.scoped),
  );
}

it(`finds compact anchor ${COMPACT_SEARCH_READ_ANCHOR} exactly once in the live upstream guide`, () => {
  expect(
    SEARCH_INVOKE_SKILL.body
      .split("\n")
      .filter((line) => line.startsWith(COMPACT_SEARCH_READ_ANCHOR)),
    COMPACT_SEARCH_READ_ANCHOR,
  ).toHaveLength(1);
});
it.effect("finds the compact tool text key exactly once in live upstream registration", () =>
  Effect.gen(function* () {
    const keys = yield* liveGuidanceKeys;
    expect(
      keys.filter((key) => key === GUIDANCE_KEYS.searchDescription),
      GUIDANCE_KEYS.searchDescription,
    ).toHaveLength(1);
  }),
);

it.effect("registers compact-search text on the live tool list", () =>
  Effect.gen(function* () {
    const features = yield* parseForkFeatures({ explicitFeatures: "compact-search" });
    const descriptions = new Map(yield* liveGuidanceDescriptions(features));
    expect(descriptions.get(GUIDANCE_KEYS.searchDescription), GUIDANCE_KEYS.searchDescription).toBe(
      COMPACT_SEARCH_DESCRIPTION,
    );
    expect(descriptions.get(GUIDANCE_KEYS.searchDetail), GUIDANCE_KEYS.searchDetail).toBe(
      COMPACT_SEARCH_DETAIL,
    );
  }),
);
