import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Fiber, Option, Queue } from "effect";
import { TestClock } from "effect/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { CATALOG_READER_WAIT_MS, createExecutor } from "./executor";
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
    const drain = Effect.gen(function* () {
      let registered: number;
      do {
        registered = completions.length;
        yield* Effect.promise(() => Promise.all(completions));
      } while (registered !== completions.length);
    });
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
    return { executor, config, drain, expire, create, completions };
  });

const makeReaderClock = Effect.gen(function* () {
  const clock = yield* TestClock.make();
  const parks = yield* Queue.unbounded<void>();
  return {
    clock: {
      ...clock,
      sleep: (duration: Duration.Duration) =>
        Duration.toMillis(duration) === CATALOG_READER_WAIT_MS
          ? Queue.offer(parks, undefined).pipe(Effect.andThen(clock.sleep(duration)))
          : clock.sleep(duration),
    },
    parked: Queue.take(parks).pipe(Effect.timeout(10_000)),
    advance: clock.adjust,
  };
});

const makeHeldReaderFixture = (
  options: { readonly graceMs?: number; readonly incomplete?: boolean } = {},
) =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const secondReading = yield* Deferred.make<void>();
    const releaseRead = yield* Deferred.make<void>();
    let holdRead = false;
    let readers = 0;
    let discoveries = 0;
    let refreshing = false;
    const fixture = yield* makeFixture(
      () =>
        Effect.sync(() => {
          if (refreshing) {
            discoveries += 1;
          }
          return refreshing && options.incomplete
            ? { tools: [], incomplete: true, incompleteReason: "fixture offline" }
            : catalog;
        }),
      {
        graceMs: options.graceMs,
        readPolicy: Effect.gen(function* () {
          if (!holdRead) return;
          readers += 1;
          yield* Deferred.succeed(readers === 1 ? reading : secondReading, undefined);
          yield* Deferred.await(releaseRead);
        }),
      },
    );
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(releaseRead, undefined).pipe(Effect.andThen(fixture.drain)),
    );
    yield* fixture.create("main");
    const before = yield* fixture.executor.tools.list();
    yield* fixture.drain;
    if (options.graceMs === 0) {
      yield* Effect.promise(() =>
        fixture.config.db.updateMany("connection", { set: { tools_synced_at: null } }),
      );
    } else {
      yield* fixture.expire;
    }
    holdRead = true;
    refreshing = true;
    const reader = yield* Effect.forkChild(fixture.executor.tools.list());
    yield* Deferred.await(reading);
    yield* Effect.sleep(20);
    return {
      ...fixture,
      before,
      reader,
      secondReading,
      releaseRead,
      discoveries: () => discoveries,
      resumeReads: Effect.sync(() => {
        holdRead = false;
      }),
    };
  });

describe("file-backed catalog refresh", () => {
  it.live(
    "prioritizes cached reads and resumes discovery after the last reader is interrupted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeHeldReaderFixture({ graceMs: 0 });
          expect(fixture.discoveries()).toBe(0);
          const second = yield* Effect.forkChild(fixture.executor.tools.list());
          yield* Deferred.await(fixture.secondReading);
          yield* Fiber.interrupt(fixture.reader);
          yield* Effect.sleep(20);
          expect(fixture.discoveries()).toBe(0);
          yield* Fiber.interrupt(second);
          yield* fixture.drain.pipe(Effect.timeout(500));
          expect(fixture.discoveries()).toBe(1);
          yield* fixture.resumeReads;
          expect(yield* fixture.executor.tools.list()).toEqual(fixture.before);
        }),
      ),
  );

  for (const count of [1, 3]) {
    it.live(
      `bounds every reader park while refreshing ${count} queued connections`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const clock = yield* makeReaderClock;
            const reading = yield* Deferred.make<void>();
            const releaseRead = yield* Deferred.make<void>();
            const discovered = yield* Queue.unbounded<string>();
            const discoveries: string[] = [];
            let refreshing = false;
            let holdNextRead = false;
            const fixture = yield* makeFixture(
              (name) =>
                Effect.gen(function* () {
                  if (refreshing) {
                    discoveries.push(name);
                    yield* Queue.offer(discovered, name);
                  }
                  return catalog;
                }),
              {
                readPolicy: Effect.gen(function* () {
                  if (!holdNextRead) return;
                  holdNextRead = false;
                  yield* Deferred.succeed(reading, undefined);
                  yield* Deferred.await(releaseRead);
                }),
              },
            );
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(releaseRead, undefined).pipe(
                Effect.andThen(fixture.drain.pipe(Effect.timeout(10_000), Effect.orDie)),
              ),
            );
            const names = Array.from({ length: count }, (_, index) => `connection${index}`);
            for (const name of names) yield* fixture.create(name);
            const before = yield* fixture.executor.tools.list();
            yield* fixture.drain;
            yield* fixture.expire;
            refreshing = true;
            holdNextRead = true;
            const reader = yield* Effect.forkChild(
              fixture.executor.tools.list().pipe(Effect.provideService(Clock.Clock, clock.clock)),
            );
            yield* Deferred.await(reading).pipe(Effect.timeout(10_000));
            for (let index = 0; index < count; index += 1) {
              yield* clock.parked;
              expect(discoveries).toHaveLength(index);
              const readAt = clock.clock.currentTimeMillisUnsafe();
              expect(
                yield* fixture.executor.tools
                  .list()
                  .pipe(Effect.provideService(Clock.Clock, clock.clock), Effect.timeout(10_000)),
              ).toEqual(before);
              expect(clock.clock.currentTimeMillisUnsafe()).toBe(readAt);
              yield* clock.advance(CATALOG_READER_WAIT_MS - 1);
              expect(discoveries).toHaveLength(index);
              yield* clock.advance(1);
              yield* Queue.take(discovered).pipe(Effect.timeout(10_000));
              expect(discoveries).toHaveLength(index + 1);
              for (let phase = 0; phase < 2; phase += 1) {
                yield* clock.parked;
                yield* clock.advance(CATALOG_READER_WAIT_MS);
              }
            }
            yield* fixture.drain.pipe(Effect.timeout(10_000));
            expect(discoveries.slice().sort()).toEqual(names);
            const rows = yield* Effect.promise(() => fixture.config.db.findMany("connection", {}));
            expect(rows.every((row) => Number(row.tools_synced_at) > 1)).toBe(true);
            yield* Deferred.succeed(releaseRead, undefined);
            expect(yield* Fiber.join(reader)).toEqual(before);
          }),
        ),
      { timeout: 30_000 },
    );
  }

  for (const trigger of ["stale-marked", "config-revised"] as const) {
    it.live(
      `queues ${trigger} work with zero grace`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const clock = yield* makeReaderClock;
            const reading = yield* Deferred.make<void>();
            const releaseRead = yield* Deferred.make<void>();
            const started = yield* Deferred.make<void>();
            const releaseDiscovery = yield* Deferred.make<void>();
            let refreshing = false;
            let holdRead = false;
            const discoveries: string[] = [];
            const fixture = yield* makeFixture(
              (name) =>
                Effect.gen(function* () {
                  if (refreshing) {
                    discoveries.push(name);
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(releaseDiscovery);
                  }
                  return catalog;
                }),
              {
                graceMs: 0,
                readPolicy: Effect.gen(function* () {
                  if (!holdRead) return;
                  yield* Deferred.succeed(reading, undefined);
                  yield* Deferred.await(releaseRead);
                }),
              },
            );
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(releaseRead, undefined).pipe(
                Effect.andThen(Deferred.succeed(releaseDiscovery, undefined)),
                Effect.andThen(fixture.drain.pipe(Effect.timeout(10_000), Effect.orDie)),
              ),
            );
            for (const name of ["a", "b"]) yield* fixture.create(name);
            const before = yield* fixture.executor.tools.list();
            yield* fixture.drain;
            yield* Effect.promise(() =>
              fixture.config.db.updateMany("connection", {
                set:
                  trigger === "stale-marked"
                    ? { tools_synced_at: null }
                    : { tools_synced_at: Date.now() - 1000 },
              }),
            );
            if (trigger === "config-revised") {
              yield* Effect.promise(() =>
                fixture.config.db.updateMany("integration", {
                  set: { config_revised_at: Date.now() },
                }),
              );
            }
            refreshing = true;
            holdRead = true;
            const reader = yield* Effect.forkChild(
              fixture.executor.tools.list().pipe(Effect.provideService(Clock.Clock, clock.clock)),
            );
            yield* Deferred.await(reading).pipe(Effect.timeout(10_000));
            yield* clock.parked;
            expect(discoveries).toEqual([]);
            yield* clock.advance(CATALOG_READER_WAIT_MS - 1);
            expect(discoveries).toEqual([]);
            yield* clock.advance(1);
            yield* Deferred.await(started).pipe(Effect.timeout(10_000));
            expect(discoveries).toHaveLength(1);
            yield* Deferred.succeed(releaseRead, undefined);
            expect(yield* Fiber.join(reader)).toEqual(before);
            yield* Deferred.succeed(releaseDiscovery, undefined);
            yield* fixture.drain.pipe(Effect.timeout(10_000));
            expect(discoveries.slice().sort()).toEqual(["a", "b"]);
          }),
        ),
      { timeout: 30_000 },
    );
  }

  it.live("lets an explicit refresh join reader-deferred discovery and retain full schemas", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHeldReaderFixture({ incomplete: true });
        expect(fixture.discoveries()).toBe(0);
        const tools = yield* fixture.executor.connections.refresh(ref).pipe(Effect.timeout(500));
        const retained = tools.find((tool) => String(tool.name) === "list");
        expect(retained?.inputSchema).toEqual(catalog.tools[0]?.inputSchema);
        expect(retained?.outputSchema).toEqual(catalog.tools[0]?.outputSchema);
        yield* fixture.drain;
        expect(fixture.discoveries()).toBe(1);
        yield* Deferred.succeed(fixture.releaseRead, undefined);
        expect(yield* Fiber.join(fixture.reader)).toEqual(fixture.before);
      }),
    ),
  );

  it.live("lets an urgent read promote reader-deferred discovery within its grace wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHeldReaderFixture();
        expect(fixture.discoveries()).toBe(0);
        yield* fixture.resumeReads;
        yield* Effect.promise(() =>
          fixture.config.db.updateMany("connection", { set: { tools_synced_at: null } }),
        );
        expect(yield* fixture.executor.tools.list().pipe(Effect.timeout(500))).toEqual(
          fixture.before,
        );
        yield* fixture.drain;
        expect(fixture.discoveries()).toBe(1);
        yield* Deferred.succeed(fixture.releaseRead, undefined);
        expect(yield* Fiber.join(fixture.reader)).toEqual(fixture.before);
      }),
    ),
  );

  for (const { column, change, stored } of [
    {
      column: "description",
      change: { description: "Changed description" },
      stored: { description: "Changed description" },
    },
    {
      column: "input_schema",
      change: { inputSchema: { type: "string" } },
      stored: { input_schema: { type: "string" } },
    },
    {
      column: "output_schema",
      change: { outputSchema: { type: "number" } },
      stored: { output_schema: { type: "number" } },
    },
    {
      column: "annotations",
      change: { annotations: { requiresApproval: true } },
      stored: { annotations: { requiresApproval: true } },
    },
  ]) {
    it.live(`persists a changed tool ${column} with the same names and count`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          let listing = catalog;
          const fixture = yield* makeFixture(() => Effect.succeed(listing));
          yield* fixture.create("main");
          const beforeTools = yield* Effect.promise(() => fixture.config.db.findMany("tool", {}));
          listing = {
            ...catalog,
            tools: catalog.tools.map((tool) =>
              tool.name === "list" ? { ...tool, ...change } : tool,
            ),
          };
          yield* fixture.executor.connections.refresh(ref);
          const tools = yield* Effect.promise(() => fixture.config.db.findMany("tool", {}));
          expect(tools.map((tool) => tool.name).sort()).toEqual(
            beforeTools.map((tool) => tool.name).sort(),
          );
          expect(tools.find((tool) => tool.name === "list")).toMatchObject(stored);
          expect(
            yield* Effect.promise(() => fixture.config.db.findMany("definition", {})),
          ).toMatchObject([{ name: "Id", schema: { type: "string" } }]);
        }),
      ),
    );
  }

  it.live("persists a changed definition schema with the same names and count", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let listing = catalog;
        const fixture = yield* makeFixture(() => Effect.succeed(listing));
        yield* fixture.create("main");
        const beforeDefinitions = yield* Effect.promise(() =>
          fixture.config.db.findMany("definition", {}),
        );
        listing = { ...catalog, definitions: { Id: { type: "number" } } };
        yield* fixture.executor.connections.refresh(ref);
        const definitions = yield* Effect.promise(() =>
          fixture.config.db.findMany("definition", {}),
        );
        expect(definitions.map((definition) => definition.name)).toEqual(
          beforeDefinitions.map((definition) => definition.name),
        );
        expect(definitions).toMatchObject([{ name: "Id", schema: { type: "number" } }]);
      }),
    ),
  );

  it.live(
    "skips an owned production and refreshes later queued connections after interruption",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const discoveredA = yield* Deferred.make<void>();
          let refreshing = false;
          const discoveries: string[] = [];
          const fixture = yield* makeFixture((name) =>
            Effect.gen(function* () {
              if (!refreshing) return catalog;
              discoveries.push(name);
              if (name === "b") {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return yield* Effect.interrupt;
              }
              yield* Deferred.succeed(discoveredA, undefined);
              return catalog;
            }),
          );
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          yield* fixture.create("a");
          yield* fixture.create("b");
          yield* Effect.promise(() =>
            fixture.config.db.updateMany("connection", {
              where: (b) => b("name", "=", "b"),
              set: { tools_synced_at: 1 },
            }),
          );
          refreshing = true;
          const explicit = yield* Effect.forkChild(
            fixture.executor.connections.refresh({ ...ref, name: ConnectionName.make("b") }),
          );
          yield* Deferred.await(started).pipe(Effect.timeout(10_000));
          yield* fixture.executor.tools.list();
          yield* fixture.drain.pipe(Effect.timeout(10_000));
          expect(discoveries).toEqual(["b"]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.await(explicit).pipe(Effect.timeout(10_000));
          yield* Effect.promise(() =>
            fixture.config.db.updateMany("connection", {
              set: { tools_synced_at: 1 },
              where: (b) => b("name", "=", "a"),
            }),
          );
          yield* fixture.executor.tools.list();
          yield* Deferred.await(discoveredA).pipe(Effect.timeout(10_000));
          yield* fixture.drain.pipe(Effect.timeout(10_000));
          expect(discoveries.filter((name) => name === "a")).toHaveLength(1);
        }),
      ),
    { timeout: 30_000 },
  );

  it.live(
    "preserves a health verdict written while detached persistence is parked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const releaseDiscovery = yield* Deferred.make<void>();
          const reading = yield* Deferred.make<void>();
          const releaseRead = yield* Deferred.make<void>();
          const parked = yield* Deferred.make<void>();
          const clock = yield* TestClock.make();
          let refreshing = false;
          let holdRead = false;
          let observePark = false;
          const fixture = yield* makeFixture(
            () =>
              Effect.gen(function* () {
                if (refreshing) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(releaseDiscovery);
                }
                return catalog;
              }),
            {
              readPolicy: Effect.gen(function* () {
                if (!holdRead) return;
                yield* Deferred.succeed(reading, undefined);
                yield* Deferred.await(releaseRead);
              }),
            },
          );
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(releaseDiscovery, undefined).pipe(
              Effect.andThen(Deferred.succeed(releaseRead, undefined)),
              Effect.andThen(fixture.drain.pipe(Effect.timeout(10_000), Effect.orDie)),
            ),
          );
          yield* fixture.create("main");
          yield* Effect.promise(() =>
            fixture.config.db.updateMany("connection", {
              set: {
                tools_synced_at: 1,
                updated_at: new Date(0),
                last_health: { status: "degraded", checkedAt: 1, reason: "tool_sync_failed" },
              },
            }),
          );
          refreshing = true;
          yield* fixture.executor.tools.list().pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              sleep: (duration) =>
                observePark && Duration.toMillis(duration) === CATALOG_READER_WAIT_MS
                  ? Deferred.succeed(parked, undefined).pipe(Effect.andThen(clock.sleep(duration)))
                  : clock.sleep(duration),
            }),
          );
          yield* Deferred.await(started).pipe(Effect.timeout(10_000));
          holdRead = true;
          const reader = yield* Effect.forkChild(fixture.executor.tools.list());
          yield* Deferred.await(reading).pipe(Effect.timeout(10_000));
          observePark = true;
          yield* Deferred.succeed(releaseDiscovery, undefined);
          yield* Deferred.await(parked).pipe(Effect.timeout(10_000));
          const verdict = { status: "expired", checkedAt: 2, detail: "HTTP 401" };
          yield* Effect.promise(() =>
            fixture.config.db.updateMany("connection", {
              set: { last_health: verdict, updated_at: new Date(1000) },
            }),
          );
          yield* Deferred.succeed(releaseRead, undefined);
          yield* Fiber.join(reader);
          yield* fixture.drain.pipe(Effect.timeout(10_000));
          const rows = yield* Effect.promise(() => fixture.config.db.findMany("connection", {}));
          expect(rows[0]?.last_health).toEqual(verdict);
        }),
      ),
    { timeout: 30_000 },
  );

  it.live(
    "settles every queued batch when a shared discovery is interrupted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const interrupted = yield* Deferred.make<void>();
          let refreshing = false;
          let first: string | undefined;
          const discoveries: string[] = [];
          const fixture = yield* makeFixture(
            (name) =>
              Effect.gen(function* () {
                if (!refreshing) return catalog;
                discoveries.push(name);
                if (first === undefined) first = name;
                if (name === first) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                  return catalog;
                }
                yield* Deferred.succeed(interrupted, undefined);
                return yield* Effect.interrupt;
              }),
            { graceMs: 10_000 },
          );
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          yield* fixture.create("a");
          yield* fixture.create("b");
          yield* fixture.expire;
          refreshing = true;
          yield* fixture.executor.tools.list();
          yield* Deferred.await(started).pipe(Effect.timeout(10_000));
          yield* fixture.executor.tools.list();
          expect(fixture.completions).toHaveLength(4);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(interrupted).pipe(Effect.timeout(10_000));
          expect(Option.isSome(yield* fixture.drain.pipe(Effect.timeoutOption(10_000)))).toBe(true);
          expect(discoveries.slice().sort()).toEqual(["a", "b"]);
        }),
      ),
    { timeout: 30_000 },
  );

  it.live(
    "discovers newly stale connections while an urgent discovery is held",
    () =>
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
          yield* Deferred.await(started).pipe(Effect.timeout(10_000));
          yield* Effect.promise(() =>
            fixture.config.db.updateMany("connection", {
              where: (b) => b("name", "=", "b"),
              set: { tools_synced_at: null },
            }),
          );
          yield* fixture.executor.tools.list();
          expect(
            Option.isSome(yield* Deferred.await(discoveredB).pipe(Effect.timeoutOption(10_000))),
          ).toBe(true);
          expect(discoveries.slice().sort()).toEqual(["a", "b"]);
        }),
      ),
    { timeout: 30_000 },
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
        yield* Effect.promise(() =>
          fixture.config.db.updateMany("tool", {
            set: { created_at: new Date(0), updated_at: new Date(0) },
          }),
        );
        yield* Effect.promise(() =>
          fixture.config.db.updateMany("definition", { set: { created_at: new Date(0) } }),
        );
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
