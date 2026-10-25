import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExecutionEngine } from "@executor-js/execution";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { makeInMemoryMcpSessionStore } from "./in-memory-session-store";
import { defaultMcpResource, type Principal } from "./seams";
import { createExecutorMcpServer } from "./tool-server";
import { withStandaloneStreamKeepalive } from "./fork-standalone-stream";

const TEST_PRINCIPAL: Principal = {
  accountId: "acct_test",
  organizationId: "org_test",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["user"],
  orgRoleModel: "organization",
};

const makeIdleTestEngine = (): ExecutionEngine => ({
  execute: () => Effect.succeed({ result: "unused" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "unused" } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("idle-eviction test executor"),
  shutdown: Effect.void,
});

const IDLE_TTL_MS = 60_000;
type TestSessionStore = ReturnType<typeof makeInMemoryMcpSessionStore>;
const openSession = async (
  sessions: TestSessionStore,
  principal: Principal = TEST_PRINCIPAL,
  requestUrl = "https://executor.test/mcp",
): Promise<string> => {
  const response = await Effect.runPromise(
    sessions.store
      .dispatch({
        request: new Request(requestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "idle-test", version: "1.0.0" },
            },
          }),
        }),
        principal,
        resource: defaultMcpResource,
        sessionId: null,
        method: "POST",
      })
      .pipe(
        Effect.flatMap((response) =>
          response instanceof Response
            ? Effect.succeed(response)
            : Effect.die("Expected HTTP response"),
        ),
      ),
  );
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id") ?? "";
  expect(sessionId).not.toBe("");
  return sessionId;
};

describe("standalone GET stream keepalive", () => {
  let sessions: TestSessionStore;
  let timersBeforeStore: number;
  let server: McpServer;

  beforeEach(async () => {
    vi.useFakeTimers();
    timersBeforeStore = vi.getTimerCount();
    const engine = makeIdleTestEngine();
    server = await Effect.runPromise(createExecutorMcpServer({ engine }));
    sessions = makeInMemoryMcpSessionStore(() => Effect.succeed({ mcpServer: server, engine }), {
      sessionIdleTtlMs: IDLE_TTL_MS,
      forkFeatures: await Effect.runPromise(
        parseForkFeatures({ explicitFeatures: "standalone-sse-keepalive" }),
      ),
    });
  });

  afterEach(async () => {
    await sessions.close();
    vi.useRealTimers();
  });

  const getStream = (sessionId: string, method: "GET" | "DELETE" = "GET") =>
    Effect.runPromise(
      sessions.store
        .dispatch({
          request: new Request("https://executor.test/mcp", {
            method,
            headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
          }),
          principal: TEST_PRINCIPAL,
          resource: defaultMcpResource,
          sessionId,
          method,
        })
        .pipe(
          Effect.flatMap((response) =>
            response instanceof Response
              ? Effect.succeed(response)
              : Effect.fail("Expected HTTP response"),
          ),
        ),
    );

  const openStream = async (sessionId: string) => {
    const response = await getStream(sessionId);
    expect(response.status).toBe(200);
    const reader = await Effect.runPromise(
      response.body ? Effect.succeed(response.body.getReader()) : Effect.fail("Expected SSE body"),
    );
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    return reader;
  };

  it("sends a ping comment after 25 seconds", async () => {
    const sessionId = await openSession(sessions);
    const timersBeforeGet = vi.getTimerCount();
    const reader = await openStream(sessionId);
    expect(vi.getTimerCount()).toBe(timersBeforeGet + 1);

    const next = reader.read();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(new TextDecoder().decode((await next).value)).toBe(": ping\n\n");
    const following = reader.read();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(new TextDecoder().decode((await following).value)).toBe(": ping\n\n");
    await reader.cancel();
  });

  it("clears its ping timer and permits a second GET after cancellation", async () => {
    const sessionId = await openSession(sessions);
    const timersBeforeGet = vi.getTimerCount();
    const reader = await openStream(sessionId);
    expect(vi.getTimerCount()).toBe(timersBeforeGet + 1);

    await reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(timersBeforeGet);
    const reopened = await openStream(sessionId);
    await reopened.cancel();
  });

  it("clears its ping timer when the source closes", async () => {
    const sessionId = await openSession(sessions);
    const timersBeforeGet = vi.getTimerCount();
    const reader = await openStream(sessionId);
    expect(vi.getTimerCount()).toBe(timersBeforeGet + 1);

    expect((await getStream(sessionId, "DELETE")).status).toBe(200);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(timersBeforeGet);
  });

  it("clears its ping timer when the store closes", async () => {
    const sessionId = await openSession(sessions);
    const timersBeforeGet = vi.getTimerCount();
    const reader = await openStream(sessionId);
    expect(vi.getTimerCount()).toBe(timersBeforeGet + 1);

    await sessions.close();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(timersBeforeStore);
  });

  it.each(["store close", "idle sweep"] as const)(
    "stops pings before draining unread notifications after %s",
    async (disposal) => {
      const sessionId = await openSession(sessions);
      const timersBeforeGet = vi.getTimerCount();
      const reader = await openStream(sessionId);
      await Effect.runPromise(
        Effect.promise(async () => {
          await server.server.notification({ method: "notifications/tools/list_changed" });
          await server.server.notification({ method: "notifications/tools/list_changed" });
          await vi.advanceTimersByTimeAsync(0);
          expect(vi.getTimerCount()).toBe(timersBeforeGet + 1);

          if (disposal === "store close") await sessions.close();
          else await sessions.sweepIdleSessions(Date.now() + IDLE_TTL_MS + 1);
          expect(sessions.sessionCount()).toBe(0);
          expect(vi.getTimerCount()).toBe(
            disposal === "store close" ? timersBeforeStore : timersBeforeGet,
          );

          await vi.advanceTimersByTimeAsync(50_000);
          for (let index = 0; index < 2; index += 1) {
            const chunk = await reader.read();
            expect(chunk.done).toBe(false);
            const text = new TextDecoder().decode(chunk.value);
            expect(text).toContain('"method":"notifications/tools/list_changed"');
            expect(text).not.toContain(": ping");
          }
          expect(await reader.read()).toEqual({ done: true, value: undefined });
        }).pipe(Effect.ensuring(Effect.promise(() => reader.cancel()))),
      );
    },
  );
});

describe("standalone stream boundary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("preserves responses that are not successful event streams", async () => {
    for (const response of [
      new Response("data"),
      new Response(null, { status: 204 }),
      new Response("error", { status: 500, headers: { "content-type": "text/event-stream" } }),
    ]) {
      expect(withStandaloneStreamKeepalive(response, new AbortController().signal)).toBe(response);
      await response.body?.cancel();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer and forwards a source error", async () => {
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const response = withStandaloneStreamKeepalive(
      new Response(source.readable, { headers: { "content-type": "text/event-stream" } }),
      new AbortController().signal,
    );
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(": connected\n\n");
    const pending = reader?.read();
    const rejected = expect(pending).rejects.toBe("source failed");
    await source.writable.abort("source failed");
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending source read and clears the timer", async () => {
    const cancel = vi.fn();
    const response = withStandaloneStreamKeepalive(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { "content-type": "text/event-stream" },
      }),
      new AbortController().signal,
    );
    const reader = response.body?.getReader();
    await reader?.read();
    const pending = reader?.read();
    await reader?.cancel("client disconnected");
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledWith("client disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a timer for an already aborted session", async () => {
    const lifetime = new AbortController();
    lifetime.abort();
    const response = withStandaloneStreamKeepalive(
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      }),
      lifetime.signal,
    );
    expect(vi.getTimerCount()).toBe(0);
    await response.body?.cancel();
  });
});

it("off mode leaves a standalone stream silent and creates no keepalive timer", async () => {
  vi.useFakeTimers();
  const engine = makeIdleTestEngine();
  const server = await Effect.runPromise(createExecutorMcpServer({ engine }));
  const sessions = makeInMemoryMcpSessionStore(
    () => Effect.succeed({ mcpServer: server, engine }),
    { forkFeatures: forkFeaturesOff, sessionIdleTtlMs: 0 },
  );
  await Effect.runPromise(
    Effect.promise(async () => {
      const sessionId = await openSession(sessions);
      const response = await Effect.runPromise(
        sessions.store
          .dispatch({
            request: new Request("https://executor.test/mcp", {
              headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
            }),
            principal: TEST_PRINCIPAL,
            resource: defaultMcpResource,
            sessionId,
            method: "GET",
          })
          .pipe(
            Effect.flatMap((response) =>
              response instanceof Response
                ? Effect.succeed(response)
                : Effect.die("Expected HTTP response"),
            ),
          ),
      );
      const reader = response.body?.getReader();
      let resolved = false;
      const pending = reader?.read().then((value) => {
        resolved = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(resolved).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await reader?.cancel();
      expect(await pending).toEqual({ done: true, value: undefined });
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await sessions.close();
          vi.useRealTimers();
        }),
      ),
    ),
  );
});
