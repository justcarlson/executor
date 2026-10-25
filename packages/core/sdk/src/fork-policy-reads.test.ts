import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin, tool } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./testing";
import { createExecutor } from "./executor";
import { parseForkFeatures } from "./fork-features";

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const VERCEL = IntegrationSlug.make("vercel");
const GITHUB = IntegrationSlug.make("github");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const policyTestPlugin = definePlugin(() => ({
  id: "ptest" as const,
  storage: () => ({}),
  credentialProviders: [memoryProvider()],
  resolveTools: ({ integration }) => {
    const tools =
      String(integration.slug) === "vercel"
        ? [
            { name: ToolName.make("deploy"), description: "deploy" },
            {
              name: ToolName.make("delete"),
              description: "delete a deployment",
              annotations: { requiresApproval: true },
            },
          ]
        : [{ name: ToolName.make("list"), description: "list repos" }];
    return Effect.succeed({ tools });
  },
  resolveAnnotations: ({ toolRows }) => {
    const out: Record<string, { requiresApproval?: boolean }> = {};
    for (const row of toolRows) {
      out[row.name] = {
        requiresApproval: row.name.toLowerCase().includes("delete"),
      };
    }
    return Effect.succeed(out);
  },
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: `${toolRow.integration}.${toolRow.name}` }),
  extension: (ctx) => ({
    seed: () =>
      Effect.gen(function* () {
        yield* ctx.core.integrations.register({
          slug: VERCEL,
          description: "Vercel",
          config: {},
        });
        yield* ctx.core.integrations.register({
          slug: GITHUB,
          description: "GitHub",
          config: {},
        });
      }),
  }),
}));

const CONN = ConnectionName.make("main");

const addr = (integration: IntegrationSlug, tool: string): ToolAddress =>
  ToolAddress.make(`tools.${integration}.org.${CONN}.${tool}`);

const setupExecutor = (enabled = true) =>
  Effect.gen(function* () {
    const config = makeTestConfig({ plugins: [policyTestPlugin()] as const });
    const forkFeatures = yield* parseForkFeatures({
      explicitFeatures: enabled ? "catalog-read-fastpath" : "",
    });
    return yield* createExecutor({ ...config, forkFeatures });
  }).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.ptest.seed();
        yield* executor.connections.create({
          owner: "org",
          name: CONN,
          integration: VERCEL,
          template: TEMPLATE,
          from: {
            provider: ProviderKey.make("memory"),
            id: ProviderItemId.make("v"),
          },
        });
        yield* executor.connections.create({
          owner: "org",
          name: CONN,
          integration: GITHUB,
          template: TEMPLATE,
          from: {
            provider: ProviderKey.make("memory"),
            id: ProviderItemId.make("g"),
          },
        });
      }),
    ),
  );

describe("tools.schema policy read", () => {
  it.effect("narrowed rule reads keep list and schema visibility identical", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      // Exact rules for other tools never match; wildcard and exact rules for
      // the tool itself decide. Mix both owners' worth of shapes.
      yield* executor.policies.create({ owner: "org", pattern: "*", action: "block" });
      yield* executor.policies.create({
        owner: "org",
        pattern: `vercel.org.${CONN}.deploy`,
        action: "approve",
      });
      yield* executor.policies.create({ owner: "org", pattern: "github.*", action: "approve" });
      yield* executor.policies.create({
        owner: "org",
        pattern: `github.org.${CONN}.list`,
        action: "block",
      });
      for (const name of ["a", "b", "c"]) {
        yield* executor.policies.create({
          owner: "org",
          pattern: `vercel.org.${CONN}.${name}`,
          action: "approve",
        });
      }

      const visible = new Set((yield* executor.tools.list()).map((tool) => String(tool.address)));
      const addresses = [addr(VERCEL, "deploy"), addr(VERCEL, "delete"), addr(GITHUB, "list")];
      for (const address of addresses) {
        const full = yield* executor.tools.schema(address);
        const lean = yield* executor.tools.schema(address, { typeScript: false });
        expect(full !== null).toBe(visible.has(String(address)));
        expect(lean !== null).toBe(visible.has(String(address)));
        expect(lean?.inputTypeScript).toBeUndefined();
        expect(lean?.outputTypeScript).toBeUndefined();
        expect(lean?.typeScriptDefinitions).toBeUndefined();
        const {
          inputTypeScript: _i,
          outputTypeScript: _o,
          typeScriptDefinitions: _d,
          ...rest
        } = full ?? {};
        expect(lean && { ...lean }).toEqual(full && rest);
      }
      expect([...visible].sort()).toEqual([String(addr(VERCEL, "deploy"))]);
    }),
  );
});

describe("catalog read feature selection", () => {
  it.effect("keeps TypeScript previews when disabled", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor(false);
      const address = addr(VERCEL, "deploy");
      expect(yield* executor.tools.schema(address, { typeScript: false })).toEqual(
        yield* executor.tools.schema(address),
      );
    }),
  );

  const staticPlugin = definePlugin(() => ({
    id: "tools" as const,
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id: "tools.ctl",
        kind: "control" as const,
        name: "Control",
        tools: [
          tool({
            name: "read",
            description: "Read",
            inputSchema: Schema.toStandardSchemaV1(
              Schema.toStandardJSONSchemaV1(Schema.Struct({})),
            ),
            execute: () => Effect.void,
          }),
        ],
      },
    ],
  }));

  it.effect("keeps the full static address when filtering policy rows", () =>
    Effect.gen(function* () {
      const forkFeatures = yield* parseForkFeatures({ explicitFeatures: "catalog-read-fastpath" });
      const executor = yield* createExecutor({
        ...makeTestConfig({ plugins: [staticPlugin()] }),
        forkFeatures,
      });
      yield* executor.policies.create({ owner: "org", pattern: "tools.ctl.read", action: "block" });
      expect(yield* executor.tools.schema(ToolAddress.make("tools.ctl.read"))).toBeNull();
      yield* executor.policies.create({
        owner: "user",
        pattern: "tools.ctl.read",
        action: "approve",
      });
      expect(yield* executor.tools.schema(ToolAddress.make("tools.ctl.read"))).toBeNull();
    }),
  );

  it.effect("orders provider rules before resolving a snapshot", () =>
    Effect.gen(function* () {
      const rules = [
        { id: "deny", pattern: "*", action: "block" as const, position: "a1" },
        { id: "allow", pattern: "tools.ctl.read", action: "approve" as const, position: "a0" },
      ];
      const provider = definePlugin(() => ({
        id: "provider" as const,
        storage: () => ({}),
        toolPolicyProvider: () => ({ list: () => Effect.succeed(rules) }),
      }));
      const forkFeatures = yield* parseForkFeatures({ explicitFeatures: "catalog-read-fastpath" });
      const executor = yield* createExecutor({
        ...makeTestConfig({ plugins: [staticPlugin(), provider()] }),
        forkFeatures,
      });
      expect((yield* executor.tools.list()).map((tool) => tool.address)).toEqual([
        "tools.ctl.read",
      ]);
      const schema = yield* executor.tools.schema(ToolAddress.make("tools.ctl.read"), {
        typeScript: false,
      });
      expect(schema?.name).toBe("read");
      expect(schema?.inputTypeScript).toBeUndefined();
      expect(rules.map((rule) => rule.id)).toEqual(["deny", "allow"]);
    }),
  );
});

describe("invalid schema addresses", () => {
  it.effect("skips policy I/O only when the fast path is enabled", () =>
    Effect.gen(function* () {
      for (const enabled of [true, false]) {
        let reads = 0;
        const provider = definePlugin(() => ({
          id: "address-policy" as const,
          storage: () => ({}),
          toolPolicyProvider: () => ({
            list: () =>
              Effect.sync(() => {
                reads += 1;
                return [];
              }),
          }),
        }));
        const forkFeatures = yield* parseForkFeatures({
          explicitFeatures: enabled ? "catalog-read-fastpath" : "",
        });
        const executor = yield* createExecutor({
          ...makeTestConfig({ plugins: [provider()] }),
          forkFeatures,
        });
        const before = reads;
        expect(yield* executor.tools.schema(ToolAddress.make("invalid"))).toBeNull();
        expect(reads - before).toBe(enabled ? 0 : 1);
      }
    }),
  );
});
