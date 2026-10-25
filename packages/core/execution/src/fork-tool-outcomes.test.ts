import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  ToolResult,
  createExecutor,
  definePlugin,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolName,
  ProviderKey,
  ProviderItemId,
  type CredentialProvider,
} from "@executor-js/sdk";
import { parseForkFeatures, forkFeaturesOff } from "@executor-js/sdk/core";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import type { ExecuteResult } from "@executor-js/codemode-core";
import { createExecutionEngine, formatExecuteResult } from "./engine";
import { withForkCodeExecutor } from "./fork-code-executor";

const features = Effect.runSync(parseForkFeatures({ explicitFeatures: "tool-usage" }));
const formatSelectedResult = (result: ExecuteResult) =>
  formatExecuteResult(result, { forkFeatures: features });

describe("selected tool usage formatting", () => {
  it("returns the sole distinct connected tool name without exposing the call trace", () => {
    const result: ExecuteResult = {
      result: { issues: [] },
      logs: [],
      toolPaths: ["linear.org.work.issues.list", "linear.org.work.issues.list"],
    };

    const formatted = formatSelectedResult(result);

    expect(formatted.structured).toEqual({
      status: "completed",
      result: { issues: [] },
      toolName: "linear.org.work.issues.list",
      toolPaths: ["linear.org.work.issues.list"],
      logs: [],
    });
  });

  it("omits a tool name but lists distinct paths in first-call order when several tools were used", () => {
    const result: ExecuteResult = {
      result: { issues: [], projects: [] },
      logs: [],
      toolPaths: [
        "linear.org.work.projects.list",
        "linear.org.work.issues.list",
        "linear.org.work.projects.list",
      ],
    };

    const formatted = formatSelectedResult(result);

    expect(formatted.structured).not.toHaveProperty("toolName");
    expect(formatted.structured["toolPaths"]).toEqual([
      "linear.org.work.projects.list",
      "linear.org.work.issues.list",
    ]);
  });

  it("omits tool paths when no connected tool was called", () => {
    const formatted = formatSelectedResult({ result: 1, logs: [], toolPaths: [] });

    expect(formatted.structured).not.toHaveProperty("toolPaths");
    expect(formatted.structured).not.toHaveProperty("toolName");
  });

  it("retains successful paths and outcome identifiers in script-error envelopes", () => {
    const formatted = formatSelectedResult({
      result: null,
      error: "script-secret",
      logs: ["log-secret"],
      toolPaths: ["sample.org.main.read"],
      toolCalls: [{ path: "sample.org.main.read", status: "ok" }],
    });
    expect(formatted.isError).toBe(true);
    expect(formatted.structured).toMatchObject({
      status: "error",
      toolPaths: ["sample.org.main.read"],
      toolCalls: [{ path: "sample.org.main.read", status: "ok" }],
    });
    expect(formatted.structured).not.toHaveProperty("toolName");
  });

  it("caps outcome identifiers and reduces repeats after the cap without retaining extra fields", () => {
    const calls = Array.from({ length: 35 }, (_, index) => ({
      path: `sample.org.main.read${index}`,
      status: "ok" as const,
      args: "argument-secret",
      result: "result-secret",
      error: "error-secret",
    }));
    const formatted = formatSelectedResult({
      result: null,
      toolCalls: [
        ...calls,
        { path: "sample.org.main.read0", status: "error" },
        { path: "tools.sample.org.main.read0", status: "blocked" },
        { path: "sample.org.main.read0", status: "ok" },
        { path: "bearer secret@example.test", status: "error" },
        { path: "sample.org.main." + "x".repeat(512), status: "error" },
      ],
    });
    expect(formatted.structured["toolCalls"]).toEqual([
      { path: "sample.org.main.read0", status: "blocked" },
      ...calls.slice(1, 32).map(({ path, status }) => ({ path, status })),
    ]);
    expect(JSON.stringify(formatted.structured)).not.toMatch(/secret|args|error/);
  });

  it("keeps the upstream envelope when disabled", () => {
    const result: ExecuteResult = {
      result: 1,
      toolPaths: ["sample.org.main.read"],
      toolCalls: [{ path: "sample.org.main.read", status: "ok" }],
    };
    expect(formatExecuteResult(result, { forkFeatures: forkFeaturesOff })).toEqual(
      formatExecuteResult(result),
    );
    expect(formatExecuteResult(result).structured).toEqual({
      status: "completed",
      result: 1,
      logs: [],
      toolName: "sample.org.main.read",
    });
  });
});

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    has: (id) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync(() => [...store.keys()].map((id) => ({ id: ProviderItemId.make(id), name: id }))),
  };
};
const plugin = definePlugin(() => ({
  id: "outcomes" as const,
  storage: () => ({}),
  credentialProviders: [memoryProvider()],
  resolveTools: () =>
    Effect.succeed({
      tools: ["read", "fail", "approval"].map((name) => ({
        name: ToolName.make(name),
        description: name,
        inputSchema: { type: "object", properties: {} },
        ...(name === "approval" ? { annotations: { requiresApproval: true } } : {}),
      })),
    }),
  invokeTool: ({ toolRow }) =>
    Effect.succeed(
      toolRow.name === "fail"
        ? ToolResult.fail({ code: "invalid_query", message: "invalid" })
        : ToolResult.ok({ done: true }),
    ),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: IntegrationSlug.make("sample"),
        description: "Read sample records.",
        config: {},
      }),
  }),
}));
const seed = (
  executor: Effect.Success<ReturnType<typeof createExecutor<readonly [ReturnType<typeof plugin>]>>>,
) =>
  Effect.gen(function* () {
    yield* executor.outcomes.seed();
    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make("main"),
      integration: IntegrationSlug.make("sample"),
      template: AuthTemplateSlug.make("apiKey"),
      value: "test-token",
    });
  });
const withEngine = <A>(
  run: (engine: ReturnType<typeof createExecutionEngine>) => Effect.Effect<A, unknown>,
  enabled = true,
) =>
  Effect.gen(function* () {
    const forkFeatures = enabled ? features : forkFeaturesOff;
    const executor = yield* createExecutor({
      ...makeTestConfig({ plugins: [plugin()] as const }),
      forkFeatures,
    });
    yield* seed(executor);
    const engine = createExecutionEngine({
      executor,
      forkFeatures,
      codeExecutor: withForkCodeExecutor(makeQuickJsExecutor(), { forkFeatures }),
    });
    yield* Effect.addFinalizer(() =>
      engine.shutdown.pipe(Effect.andThen(executor.close()), Effect.ignore),
    );
    return yield* run(engine);
  }).pipe(Effect.scoped);

describe("sandbox tool outcomes through the provider", () => {
  for (const enabled of [true, false]) {
    it.effect(
      `retains successful and failed targets with tool usage ${enabled ? "on" : "off"}`,
      () =>
        withEngine(
          (engine) =>
            Effect.gen(function* () {
              const result = yield* engine.execute(
                "await tools.sample.org.main.read({}); return await tools.sample.org.main.fail({});",
                { onElicitation: () => Effect.succeed({ action: "accept" }) },
              );
              expect(result.error).toBeUndefined();
              expect(result.toolPaths).toEqual(["sample.org.main.read"]);
              expect(result.toolCalls).toEqual(
                enabled
                  ? [
                      { path: "sample.org.main.read", status: "ok" },
                      { path: "sample.org.main.fail", status: "error" },
                    ]
                  : undefined,
              );
            }),
          enabled,
        ),
    );
  }
  for (const action of ["accept", "decline", "cancel"] as const) {
    it.effect(`correlates ${action} outcomes across a real approval pause`, () =>
      withEngine((engine) =>
        Effect.gen(function* () {
          const paused = yield* engine.executeWithPause(
            "return await tools.sample.org.main.approval({});",
          );
          if (paused.status !== "paused") return yield* Effect.die("expected approval pause");
          const resumed = yield* engine.resume(paused.execution.id, { action, content: {} });
          if (resumed?.status !== "completed")
            return yield* Effect.die("expected completed resume");
          expect(resumed.result.toolCalls).toEqual([
            { path: "sample.org.main.approval", status: action === "accept" ? "ok" : "blocked" },
          ]);
          expect(yield* engine.resume(paused.execution.id, { action, content: {} })).toEqual(
            resumed,
          );
        }),
      ),
    );
  }
  it.effect("retains successful targets before a script failure", () =>
    withEngine((engine) =>
      Effect.gen(function* () {
        const result = yield* engine.execute(
          'await tools.sample.org.main.read({}); throw new Error("script failed");',
          { onElicitation: () => Effect.succeed({ action: "accept" }) },
        );
        expect(result.error).toContain("script failed");
        expect(formatSelectedResult(result).structured).toMatchObject({
          status: "error",
          toolCalls: [{ path: "sample.org.main.read", status: "ok" }],
        });
      }),
    ),
  );
  it.effect("records hard policy blocks", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [plugin()] as const }));
      yield* seed(executor);
      yield* executor.policies.create({ owner: "org", pattern: "sample.*", action: "block" });
      const engine = createExecutionEngine({
        executor,
        codeExecutor: withForkCodeExecutor(makeQuickJsExecutor(), { forkFeatures: features }),
      });
      yield* Effect.addFinalizer(() =>
        engine.shutdown.pipe(Effect.andThen(executor.close()), Effect.ignore),
      );
      const result = yield* engine.execute("return await tools.sample.org.main.read({});", {
        onElicitation: () => Effect.succeed({ action: "accept" }),
      });
      expect(result.toolCalls).toEqual([{ path: "sample.org.main.read", status: "blocked" }]);
    }).pipe(Effect.scoped),
  );
});
