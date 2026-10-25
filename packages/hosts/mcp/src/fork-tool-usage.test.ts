import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExecutionEngine } from "@executor-js/execution";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { createExecutorMcpServer } from "./tool-server";
const path = "sample.org.main.read";
const fixture = (emitted: boolean) => {
  const result = {
    result: { answer: 42 },
    logs: [],
    toolPaths: [path],
    toolCalls: [{ path, status: "ok" as const }],
    ...(emitted
      ? {
          output: [
            { type: "content" as const, content: { type: "text" as const, text: "visible" } },
          ],
        }
      : {}),
  };
  const completed = { status: "completed" as const, result };
  const engine: ExecutionEngine = {
    execute: () => Effect.succeed(result),
    executeWithPause: () => Effect.succeed(completed),
    resume: () => Effect.succeed(completed),
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    getDescription: Effect.succeed("test executor"),
    shutdown: Effect.void,
  };
  const upstream = {
    status: "completed",
    result: { answer: 42 },
    toolName: path,
    ...(emitted ? { emitted: 1 } : {}),
    logs: [],
  };
  return {
    engine,
    expected: (enabled: boolean) => ({
      ...upstream,
      ...(enabled ? { toolPaths: [path], toolCalls: [{ path, status: "ok" }] } : {}),
    }),
  };
};

describe("MCP tool usage serialization", () => {
  for (const enabled of [false, true])
    for (const emitted of [false, true]) {
      for (const method of ["execute", "resume"] as const) {
        it.effect(`${method}, emitted ${emitted}, usage ${enabled}`, () =>
          Effect.gen(function* () {
            const { engine, expected } = fixture(emitted);
            const forkFeatures = enabled
              ? yield* parseForkFeatures({ explicitFeatures: "tool-usage" })
              : forkFeaturesOff;
            const server = yield* createExecutorMcpServer({
              engine,
              forkFeatures,
              artifactsEnabled: false,
              elicitationMode: { mode: "model" },
            });
            const [a, b] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: "usage-test", version: "1.0.0" });
            yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
            yield* Effect.promise(async () => {
              await server.connect(b);
              await client.connect(a);
              const result = await client.callTool({
                name: method,
                arguments:
                  method === "execute"
                    ? { code: "return 42" }
                    : { executionId: "run", action: "accept" },
              });
              expect(result.structuredContent).toEqual(expected(enabled));
              expect(result.content).toEqual([
                ...(emitted ? [{ type: "text", text: "visible" }] : []),
                { type: "text", text: JSON.stringify({ answer: 42 }, null, 2) },
              ]);
            });
          }).pipe(Effect.scoped),
        );
      }
    }
});
