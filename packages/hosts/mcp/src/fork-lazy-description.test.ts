import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExecutionEngine } from "@executor-js/execution";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { createExecutorMcpServer } from "./tool-server";

const fixture = (fail = false) => {
  let reads = 0;
  const engine: ExecutionEngine = {
    execute: () => Effect.succeed({ result: null }),
    executeWithPause: () => Effect.succeed({ status: "completed", result: { result: null } }),
    resume: () => Effect.succeed(null),
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    shutdown: Effect.void,
    getDescription: Effect.sync(() => {
      reads++;
      return "Execute tools.\n\n## Available integrations\n\n- `sample`";
    }).pipe(
      Effect.flatMap((text) => (fail ? Effect.die("inventory failed") : Effect.succeed(text))),
    ),
  };
  return { engine, reads: () => reads };
};
const ports = {
  tools: { list: () => Effect.succeed([]), schema: () => Effect.succeed(null) },
  connections: { list: () => Effect.succeed([]) },
  integrations: { list: () => Effect.succeed([]) },
};

describe("lazy description selection", () => {
  for (const mode of ["codemode", "passthrough"] as const)
    for (const enabled of [false, true]) {
      it.effect(`${mode} read timing and session caching with lazy ${enabled}`, () =>
        Effect.gen(function* () {
          const test = fixture();
          const forkFeatures = enabled
            ? yield* parseForkFeatures({ explicitFeatures: "lazy-execute-description" })
            : forkFeaturesOff;
          for (let session = 0; session < 2; session++) {
            const before = test.reads();
            const server = yield* createExecutorMcpServer({
              ...ports,
              engine: test.engine,
              forkFeatures,
              mode,
              artifactsEnabled: false,
            });
            expect(test.reads() - before).toBe(enabled && mode === "passthrough" ? 0 : 1);
            const [a, b] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: "lazy-test", version: "1.0.0" });
            yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
            yield* Effect.promise(async () => {
              await server.connect(b);
              await client.connect(a);
              await client.listTools();
              expect(test.reads() - before).toBe(enabled && mode === "passthrough" ? 0 : 1);
              for (let n = 0; n < 2; n++) {
                const result = await client.callTool({
                  name: "skills",
                  arguments: { name: mode === "codemode" ? "execute" : "search-invoke" },
                });
                expect(result.isError).not.toBe(true);
              }
            });
            expect(test.reads() - before).toBe(1);
          }
          expect(test.reads()).toBe(2);
        }).pipe(Effect.scoped),
      );
    }
  for (const enabled of [false, true]) {
    it.effect(
      `preserves eager failure timing or defers a cached failure with lazy ${enabled}`,
      () =>
        Effect.gen(function* () {
          const test = fixture(true);
          const forkFeatures = enabled
            ? yield* parseForkFeatures({ explicitFeatures: "lazy-execute-description" })
            : forkFeaturesOff;
          const built = yield* Effect.exit(
            createExecutorMcpServer({
              ...ports,
              engine: test.engine,
              forkFeatures,
              mode: "passthrough",
              artifactsEnabled: false,
            }),
          );
          expect(Exit.isSuccess(built)).toBe(enabled);
          expect(test.reads()).toBe(enabled ? 0 : 1);
          if (Exit.isFailure(built)) return;
          const [a, b] = InMemoryTransport.createLinkedPair();
          const client = new Client({ name: "failure-test", version: "1.0.0" });
          yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
          yield* Effect.promise(async () => {
            await built.value.connect(b);
            await client.connect(a);
            for (let n = 0; n < 2; n++) {
              const result = await client.callTool({
                name: "skills",
                arguments: { name: "search-invoke" },
              });
              expect(result.isError).toBe(true);
            }
          });
          expect(test.reads()).toBe(1);
        }).pipe(Effect.scoped),
    );
  }
  it.effect("uses the configured description without reading the engine", () =>
    Effect.gen(function* () {
      const test = fixture(true);
      const forkFeatures = yield* parseForkFeatures({
        explicitFeatures: "lazy-execute-description",
      });
      yield* createExecutorMcpServer({
        engine: test.engine,
        forkFeatures,
        description: "configured",
        artifactsEnabled: false,
      });
      expect(test.reads()).toBe(0);
    }),
  );
});
