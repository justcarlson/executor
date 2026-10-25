import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { createExecutor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import type { ExecutionEngine } from "@executor-js/execution";
import { ExecutionsApi } from "../executions/api";
import { ExecutionsHandlers } from "./executions";
import { ExecutionEngineService, ExecutorService } from "../services";
import { HostConfig } from "../server/scoped-executor";
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

describe("HTTP tool usage serialization", () => {
  for (const enabled of [false, true])
    for (const emitted of [false, true]) {
      for (const method of ["execute", "resume"] as const) {
        it.effect(`${method}, emitted ${emitted}, usage ${enabled}`, () =>
          Effect.gen(function* () {
            const { engine, expected } = fixture(emitted);
            const forkFeatures = enabled
              ? yield* parseForkFeatures({ explicitFeatures: "tool-usage" })
              : forkFeaturesOff;
            const executor = yield* createExecutor(makeTestConfig({}));
            yield* Effect.addFinalizer(() => executor.close().pipe(Effect.orDie));
            const services = Layer.mergeAll(
              Layer.succeed(ExecutionEngineService)(engine),
              Layer.succeed(ExecutorService)(executor),
              Layer.succeed(HostConfig)({
                forkFeatures,
                allowLocalNetwork: false,
                oauthCallbackPath: "/oauth/callback",
              }),
            );
            const web = HttpRouter.toWebHandler(
              HttpApiBuilder.layer(HttpApi.make("executor").add(ExecutionsApi)).pipe(
                Layer.provide(ExecutionsHandlers),
                Layer.provide(services),
                Layer.provideMerge(HttpServer.layerServices),
              ),
              { disableLogger: true },
            );
            yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
            const response = yield* Effect.promise(() =>
              web.handler(
                new Request(
                  method === "execute"
                    ? "http://localhost/executions"
                    : "http://localhost/executions/run/resume",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(
                      method === "execute" ? { code: "return 42" } : { action: "accept" },
                    ),
                  },
                ),
                Context.make(ExecutionEngineService, engine).pipe(
                  Context.add(ExecutorService, executor),
                  Context.add(HostConfig, {
                    forkFeatures,
                    allowLocalNetwork: false,
                    oauthCallbackPath: "/oauth/callback",
                  }),
                ),
              ),
            );
            expect(response.status).toBe(200);
            const payload = yield* Effect.promise(() => response.json());
            expect(payload).toEqual({
              status: "completed",
              text: JSON.stringify({ answer: 42 }, null, 2),
              structured: expected(enabled),
              isError: false,
            });
          }).pipe(Effect.scoped),
        );
      }
    }
});
