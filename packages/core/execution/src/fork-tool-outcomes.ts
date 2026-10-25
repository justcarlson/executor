import { Cause, Effect, Schema } from "effect";
import { isToolResult } from "@executor-js/sdk/core";
import type { ExecuteResult, SandboxToolInvoker } from "@executor-js/codemode-core";

export const connectedToolOutcomes = () => {
  const calls = new Map<string, NonNullable<ExecuteResult["toolCalls"]>[number]>();
  const severity = { ok: 0, error: 1, blocked: 2 } as const;
  const record = (path: unknown, status: unknown) => {
    if (
      typeof path !== "string" ||
      path.length > 512 ||
      (status !== "ok" && status !== "error" && status !== "blocked")
    )
      return;
    const canonical = path.startsWith("tools.") ? path : `tools.${path}`;
    if (
      canonical.length > 512 ||
      !/^tools\.[a-zA-Z0-9_-]{1,64}\.(?:org|user)\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$/.test(canonical)
    )
      return;
    const normalized = canonical.slice("tools.".length);
    const previous = calls.get(normalized);
    if (previous ? severity[status] > severity[previous.status] : calls.size < 32) {
      calls.set(normalized, { path: normalized, status });
    }
  };
  return { record, values: () => [...calls.values()] };
};

const isApprovalDecline = Schema.is(
  Schema.Struct({
    cause: Schema.Struct({ _tag: Schema.Literal("ElicitationDeclinedError") }),
  }),
);

export const withToolOutcomes = (invoker: SandboxToolInvoker) => {
  const calls = connectedToolOutcomes();
  return {
    invoker: {
      invoke: (input) =>
        invoker.invoke(input).pipe(
          Effect.tap((result) =>
            Effect.sync(() =>
              calls.record(
                input.path,
                !isToolResult(result) || result.ok
                  ? "ok"
                  : result.error.code === "tool_blocked"
                    ? "blocked"
                    : "error",
              ),
            ),
          ),
          Effect.tapCause((cause) =>
            Effect.sync(() =>
              calls.record(
                input.path,
                cause.reasons.some(
                  (reason) => Cause.isFailReason(reason) && isApprovalDecline(reason.error),
                )
                  ? "blocked"
                  : "error",
              ),
            ),
          ),
        ),
    } satisfies SandboxToolInvoker,
    finish: (result: ExecuteResult): ExecuteResult => ({
      ...result,
      ...(calls.values().length > 0 ? { toolCalls: calls.values() } : {}),
    }),
  };
};

export const connectedResultFields = (result: ExecuteResult) => {
  const toolPaths = [...new Set(result.toolPaths ?? [])];
  const outcomes = connectedToolOutcomes();
  if (Array.isArray(result.toolCalls)) {
    for (const call of result.toolCalls) {
      if (typeof call === "object" && call !== null) outcomes.record(call.path, call.status);
    }
  }
  const toolCalls = outcomes.values();
  return {
    ...(toolPaths.length > 0 ? { toolPaths } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
};
