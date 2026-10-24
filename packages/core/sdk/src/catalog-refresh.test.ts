import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { createExecutor } from "./executor";
import { ConnectionName, IntegrationSlug, NO_AUTH_TEMPLATE, ToolName } from "./ids";
import { definePlugin, type ResolveToolsResult } from "./plugin";
import { makeTestConfig, memoryCredentialsPlugin } from "./testing";

const integration = IntegrationSlug.make("refresh-fixture");
const ref = { owner: "org" as const, integration, name: ConnectionName.make("main") };
const catalog: ResolveToolsResult = {
  tools: [
    {
      name: ToolName.make("list"),
      description: "List items",
      inputSchema: { type: "object", properties: { id: { $ref: "#/$defs/Id" } } },
      outputSchema: { type: "array", items: { type: "string" } },
      annotations: { requiresApproval: false },
    },
    { name: ToolName.make("alpha"), description: "Another tool" },
  ],
  definitions: { Id: { type: "string" } },
};

const makeFixture = (
  resolve: (name: string) => Effect.Effect<ResolveToolsResult>,
  options: {
    readonly graceMs?: number | null;
    readonly readPolicy?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(process.cwd(), ".catalog-refresh-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const fixture = definePlugin(() => ({
      id: "refresh-fixture" as const,
      storage: () => ({}),
      remoteToolCatalog: true,
      describeAuthMethods: () => [
        { id: "none", label: "No authentication", kind: "none", template: "none" },
      ],
      resolveTools: ({ connection }) => resolve(String(connection.name)),
      toolPolicyProvider: () => ({
        list: () =>
          (options.readPolicy ?? Effect.void).pipe(
            Effect.as([{ id: "allow", pattern: "*", action: "approve" as const, position: "a0" }]),
          ),
      }),
      invokeTool: () => Effect.succeed(null),
      extension: (ctx) => ({
        seed: () =>
          ctx.core.integrations.register({
            slug: integration,
            description: "Refresh fixture",
            config: {},
          }),
      }),
    }))();
    const config = makeTestConfig({
      dataDir: dir,
      plugins: [memoryCredentialsPlugin(), fixture] as const,
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => config.testDb.close()));
    const completions: Promise<unknown>[] = [];
    const executor = yield* createExecutor({
      ...config,
      toolsSyncGraceMs: options.graceMs,
      waitUntil: (promise) => completions.push(promise),
    });
    yield* executor["refresh-fixture"].seed();
    const drain = Effect.promise(() => Promise.all(completions));
    const expire = Effect.promise(() =>
      config.db.updateMany("connection", { set: { tools_synced_at: 1 } }),
    );
    const create = (name: string) =>
      executor.connections.create({
        ...ref,
        name: ConnectionName.make(name),
        template: NO_AUTH_TEMPLATE,
        inputs: {},
      });
    return { executor, config, drain, expire, create };
  });

describe("file-backed catalog refresh", () => {
  it.live("discovers newly stale connections while an urgent discovery is held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const discoveredB = yield* Deferred.make<void>();
        let refreshing = false;
        const discoveries: string[] = [];
        const fixture = yield* makeFixture(
          (name) =>
            Effect.gen(function* () {
              if (!refreshing) return catalog;
              discoveries.push(name);
              if (name === "a") {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              } else {
                yield* Deferred.succeed(discoveredB, undefined);
              }
              return { tools: [{ name: ToolName.make("updated") }] };
            }),
          { graceMs: 50 },
        );
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(Effect.andThen(fixture.drain)),
        );
        yield* fixture.create("a");
        yield* fixture.create("b");
        refreshing = true;
        yield* Effect.promise(() =>
          fixture.config.db.updateMany("connection", {
            where: (b) => b("name", "=", "a"),
            set: { tools_synced_at: null },
          }),
        );
        yield* fixture.executor.tools.list();
        yield* Deferred.await(started).pipe(Effect.timeout(2000));
        yield* Effect.promise(() =>
          fixture.config.db.updateMany("connection", {
            where: (b) => b("name", "=", "b"),
            set: { tools_synced_at: null },
          }),
        );
        yield* fixture.executor.tools.list();
        expect(
          Option.isSome(yield* Deferred.await(discoveredB).pipe(Effect.timeoutOption(2000))),
        ).toBe(true);
        expect(discoveries.slice().sort()).toEqual(["a", "b"]);
      }),
    ),
  );

  it.live("keeps identical tool and definition rows while reads overlap reordered discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let refreshing = false;
        const fixture = yield* makeFixture(() =>
          Effect.gen(function* () {
            if (!refreshing) return catalog;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { ...catalog, tools: [...catalog.tools].reverse() };
          }),
        );
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(Effect.andThen(fixture.drain)),
        );
        yield* fixture.create("main");
        const beforeTools = yield* Effect.promise(() => fixture.config.db.findMany("tool", {}));
        const beforeDefinitions = yield* Effect.promise(() =>
          fixture.config.db.findMany("definition", {}),
        );
        const before = yield* fixture.executor.tools.list();
        yield* fixture.drain;
        refreshing = true;
        const refresh = yield* Effect.forkChild(fixture.executor.connections.refresh(ref));
        yield* Deferred.await(started);
        expect(yield* fixture.executor.tools.list()).toEqual(before);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(refresh);
        expect(yield* Effect.promise(() => fixture.config.db.findMany("tool", {}))).toEqual(
          beforeTools,
        );
        expect(yield* Effect.promise(() => fixture.config.db.findMany("definition", {}))).toEqual(
          beforeDefinitions,
        );
      }),
    ),
  );

  it.live("serializes and shares queued TTL discoveries while preserving health and catalogs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let refreshing = false;
        let incomplete = true;
        let listing = catalog;
        const discoveries: string[] = [];
        const fixture = yield* makeFixture((name) =>
          Effect.gen(function* () {
            if (!refreshing) return catalog;
            discoveries.push(name);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return incomplete
              ? { tools: [], incomplete: true, incompleteReason: "fixture offline" }
              : listing;
          }),
        );
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(Effect.andThen(fixture.drain)),
        );
        for (const name of ["a", "b", "c"]) yield* fixture.create(name);
        const before = yield* fixture.executor.tools.list();
        yield* fixture.drain;
        yield* fixture.expire;
        refreshing = true;
        expect(yield* fixture.executor.tools.list()).toEqual(before);
        yield* Deferred.await(started);
        expect(yield* fixture.executor.tools.list()).toEqual(before);
        yield* Effect.sleep(20);
        expect(discoveries).toHaveLength(1);
        yield* Deferred.succeed(release, undefined);
        yield* fixture.drain;
        expect(discoveries.slice().sort()).toEqual(["a", "b", "c"]);
        const failed = yield* Effect.promise(() => fixture.config.db.findMany("connection", {}));
        for (const connection of failed) {
          expect(connection.last_health).toMatchObject({
            status: "degraded",
            reason: "tool_sync_failed",
          });
          expect(Number(connection.tools_synced_at)).toBeGreaterThan(1);
        }
        const explicit = yield* fixture.executor.connections.refresh({
          ...ref,
          name: ConnectionName.make("a"),
        });
        const retained = explicit.find((tool) => String(tool.name) === "list");
        expect(retained?.inputSchema).toEqual(catalog.tools[0]?.inputSchema);
        expect(retained?.outputSchema).toEqual(catalog.tools[0]?.outputSchema);
        incomplete = false;
        yield* fixture.expire;
        yield* fixture.executor.tools.list();
        yield* fixture.drain;
        const recovered = yield* Effect.promise(() => fixture.config.db.findMany("connection", {}));
        expect(recovered.every((connection) => connection.last_health === null)).toBe(true);
        expect(yield* fixture.executor.tools.list()).toEqual(before);
        const variants: readonly ResolveToolsResult[] = [
          { ...catalog, tools: [{ ...catalog.tools[0]!, description: "Changed description" }] },
          { ...catalog, tools: [{ ...catalog.tools[0]!, inputSchema: { type: "string" } }] },
          { ...catalog, tools: [{ ...catalog.tools[0]!, outputSchema: { type: "number" } }] },
          {
            ...catalog,
            tools: [{ ...catalog.tools[0]!, annotations: { requiresApproval: true } }],
          },
          { ...catalog, definitions: { Id: { type: "number" }, Extra: { type: "boolean" } } },
          { ...catalog, definitions: {} },
          {
            tools: [...catalog.tools, { name: ToolName.make("added"), description: "Added tool" }],
          },
          { tools: [{ name: ToolName.make("replacement"), description: "Replacement tool" }] },
          { tools: [] },
        ];
        for (const variant of variants) {
          listing = variant;
          const tools = yield* fixture.executor.connections.refresh({
            ...ref,
            name: ConnectionName.make("a"),
          });
          expect(
            tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              annotations: tool.annotations,
            })),
          ).toEqual(
            variant.tools.map((tool) => ({
              ...tool,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema ?? undefined,
              outputSchema: tool.outputSchema ?? undefined,
              annotations: tool.annotations ?? undefined,
            })),
          );
          const definitions = yield* Effect.promise(() =>
            fixture.config.db.findMany("definition", { where: (b) => b("connection", "=", "a") }),
          );
          expect(Object.fromEntries(definitions.map((row) => [row.name, row.schema]))).toEqual(
            variant.definitions ?? {},
          );
        }
      }),
    ),
  );

  it.live(
    "lets explicit and urgent refreshes bypass queued TTL discoveries without repeating them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let refreshing = false;
          let blocked: string | undefined;
          const discoveries: string[] = [];
          const fixture = yield* makeFixture((name) =>
            Effect.gen(function* () {
              if (!refreshing) return catalog;
              discoveries.push(name);
              if (blocked === undefined) blocked = name;
              if (name === blocked) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return {
                tools: [{ name: ToolName.make("updated"), description: "Updated catalog" }],
              };
            }),
          );
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(Effect.andThen(fixture.drain)),
          );
          const names = ["a", "b", "c"];
          for (const name of names) yield* fixture.create(name);
          yield* fixture.expire;
          refreshing = true;
          yield* fixture.executor.tools.list();
          yield* Deferred.await(started);
          yield* Effect.sleep(20);
          expect(discoveries).toHaveLength(1);
          const peers = names.filter((name) => name !== blocked);
          const explicitName = peers[0]!;
          const urgentName = peers[1]!;
          const explicit = yield* fixture.executor.connections.refresh({
            ...ref,
            name: ConnectionName.make(explicitName),
          });
          expect(explicit.map((tool) => String(tool.name))).toEqual(["updated"]);
          yield* Effect.promise(() =>
            fixture.config.db.updateMany("connection", {
              where: (b) => b("name", "=", urgentName),
              set: { tools_synced_at: null },
            }),
          );
          const tools = yield* fixture.executor.tools.list();
          expect(
            tools
              .filter((tool) => String(tool.connection) === urgentName)
              .map((tool) => String(tool.name)),
          ).toEqual(["updated"]);
          yield* Deferred.succeed(release, undefined);
          yield* fixture.drain;
          expect(discoveries.slice().sort()).toEqual(names);
        }),
      ),
  );
});
