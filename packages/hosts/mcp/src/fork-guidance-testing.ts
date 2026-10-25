import { forkFeaturesOff, type ForkFeatures } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExecutionEngine } from "@executor-js/execution";
import { createExecutorMcpServer } from "./tool-server";

export const guidanceTestEngine: ExecutionEngine = {
  execute: () => Effect.succeed({ result: null }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: null } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test executor"),
  shutdown: Effect.void,
};
const decodeProperties = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Struct({ description: Schema.optional(Schema.String) })),
);
export const liveGuidanceDescriptions = (forkFeatures: ForkFeatures = forkFeaturesOff) =>
  Effect.gen(function* () {
    const server = yield* createExecutorMcpServer({
      engine: guidanceTestEngine,
      forkFeatures,
      mode: "passthrough",
      artifactsEnabled: false,
      integrations: { list: () => Effect.succeed([]) },
      connections: { list: () => Effect.succeed([]) },
      tools: { list: () => Effect.succeed([]), schema: () => Effect.succeed(null) },
    });
    const client = new Client({ name: "guidance-keys", version: "1.0.0" });
    yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
    const [a, b] = InMemoryTransport.createLinkedPair();
    yield* Effect.promise(async () => {
      await server.connect(b);
      await client.connect(a);
    });
    const { tools } = yield* Effect.promise(() => client.listTools());
    return tools.flatMap((tool) => [
      ...(tool.description === undefined
        ? []
        : [[`${tool.name}.description`, tool.description] as const]),
      ...Object.entries(decodeProperties(tool.inputSchema.properties ?? {}))
        .filter(([, schema]) => schema.description !== undefined)
        .map(([field, schema]) => [`${tool.name}.${field}`, schema.description] as const),
    ]);
  }).pipe(Effect.scoped);

export const liveGuidanceKeys = liveGuidanceDescriptions().pipe(
  Effect.map((entries) => entries.map(([key]) => key)),
);
