import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExecutionEngine } from "@executor-js/execution";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { createExecutorMcpServer } from "./tool-server";

const engine: ExecutionEngine = {
  execute: () => Effect.succeed({ result: null }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: null } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test executor"),
  shutdown: Effect.void,
};

describe("attachment guidance at the MCP boundary", () => {
  for (const mode of ["codemode", "passthrough"] as const) {
    for (const enabled of [false, true]) {
      it.effect(`${mode} exposes attachment guidance with selection ${enabled}`, () =>
        Effect.gen(function* () {
          const forkFeatures = enabled
            ? yield* parseForkFeatures({ explicitFeatures: "automatic-attachments" })
            : forkFeaturesOff;
          const server = yield* createExecutorMcpServer({
            engine,
            mode,
            forkFeatures,
            artifactsEnabled: false,
            tools: { list: () => Effect.succeed([]), schema: () => Effect.succeed(null) },
            connections: { list: () => Effect.succeed([]) },
            integrations: { list: () => Effect.succeed([]) },
          });
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          const client = new Client({ name: "catalog-test", version: "1.0.0" });
          yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
          yield* Effect.promise(async () => {
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            const result = await client.callTool({ name: "skills", arguments: {} });
            expect(JSON.stringify(result).includes("automatic-attachments")).toBe(false);
            const execute = await client.callTool({
              name: "skills",
              arguments: { name: "execute" },
            });
            expect(JSON.stringify(execute).includes("automatically")).toBe(
              enabled && mode === "codemode",
            );
          });
        }).pipe(Effect.scoped),
      );
    }
  }
});
