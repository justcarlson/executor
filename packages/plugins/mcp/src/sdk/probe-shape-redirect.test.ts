import assert from "node:assert/strict";
import { describe, expect, it, onTestFinished } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createExecutor } from "@executor-js/sdk";
import { makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import { probeMcpEndpointShape } from "./probe-shape";

const KEY = "test-key-not-secret";

const MCP_RESULT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    serverInfo: { name: "t", version: "0" },
  },
});

const answerMcp = (response: ServerResponse) =>
  response.writeHead(200, { "content-type": "application/json" }).end(MCP_RESULT);

const serve = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{
  readonly url: string;
  readonly keys: string[];
  readonly paths: string[];
}> => {
  const keys: string[] = [];
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    keys.push(String(request.headers["x-api-key"]));
    paths.push(request.url ?? "/");
    request.resume();
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, keys, paths };
};

// oxlint-disable-next-line executor/no-raw-fetch -- test boundary: the spy records each request's abort signal and must delegate to the platform fetch
const platformFetch: typeof globalThis.fetch = globalThis.fetch;

const layerFor = (hosted: boolean) =>
  hosted ? makeHostedHttpClientLayer({ allowLocalNetwork: true }) : FetchHttpClient.layer;

/** A fetch that records, as each request after a redirect starts, whether every
 *  earlier request that got a redirect status was already aborted. Releasing a
 *  response aborts its fetch, so this sees a redirect body released before the
 *  next hop, in any runtime and before the probe's own scope closes. */
const releaseRecorder = () => {
  const redirects: AbortSignal[] = [];
  const earlierReleased: boolean[] = [];
  const fetch = (async (input, init) => {
    if (redirects.length > 0) earlierReleased.push(redirects.every((signal) => signal.aborted));
    assert(init?.signal);
    const signal = init.signal;
    const response = await platformFetch(input, init);
    if (response.status >= 300 && response.status < 400) redirects.push(signal);
    return response;
  }) as typeof globalThis.fetch;
  return { fetch, earlierReleased };
};

/** Probes `endpoint` on the production layer. A `fetch` spy, when given, is
 *  provided from outside as the layer's `FetchHttpClient.Fetch`. */
const probe = (endpoint: string, hosted: boolean, fetch?: typeof globalThis.fetch) => {
  const layer = layerFor(hosted);
  return Effect.runPromise(
    probeMcpEndpointShape(endpoint, {
      headers: { "X-API-Key": KEY },
      timeoutMs: 2_000,
      httpClientLayer: fetch
        ? layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch)))
        : layer,
    }),
  );
};

describe("probeMcpEndpointShape redirect credential protection", () => {
  for (const hosted of [false, true]) {
    const layer = hosted ? "hosted" : "fetch";

    for (const status of [302, 307, 308]) {
      it(`does not follow a cross-origin ${status} on initialize through the ${layer} layer`, async () => {
        const target = await serve((_, response) => answerMcp(response));
        const source = await serve((_, response) =>
          response.writeHead(status, { location: `${target.url}/mcp` }).end(),
        );
        const result = await probe(`${source.url}/mcp`, hosted);
        expect(target.keys).toEqual([]);
        expect(source.keys.length).toBeGreaterThan(0);
        expect(source.keys.every((key) => key === KEY)).toBe(true);
        expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
      });
    }

    it(`does not follow a cross-origin redirect on the legacy GET through the ${layer} layer`, async () => {
      const target = await serve((_, response) =>
        response.writeHead(200, { "content-type": "text/event-stream" }).end(),
      );
      const source = await serve((request, response) =>
        request.method === "GET"
          ? response.writeHead(302, { location: `${target.url}/sse` }).end()
          : response.writeHead(405).end(),
      );
      const result = await probe(`${source.url}/mcp`, hosted);
      expect(target.keys).toEqual([]);
      expect(source.keys).toContain(KEY);
      expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
    });

    it(`follows a same-origin 307 with the headers through the ${layer} layer`, async () => {
      const seen: string[] = [];
      const server = await serve((request, response) => {
        if (request.url === "/mcp") {
          response.writeHead(307, { location: "/mcp/" }).end();
          return;
        }
        seen.push(String(request.headers["x-api-key"]));
        answerMcp(response);
      });
      const result = await probe(`${server.url}/mcp`, hosted);
      expect(result).toEqual({ kind: "mcp", requiresAuth: false });
      expect(seen).toEqual([KEY]);
    });

    it(`does not follow a same-origin 302 that would change the POST method through the ${layer} layer`, async () => {
      const server = await serve((request, response) =>
        request.url === "/mcp"
          ? response.writeHead(302, { location: "/next" }).end()
          : answerMcp(response),
      );
      const result = await probe(`${server.url}/mcp`, hosted);
      expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
      expect(server.paths).toEqual(["/mcp", "/mcp"]);
    });

    it(`does not follow a same-origin Location that adds userinfo through the ${layer} layer`, async () => {
      const server = await serve((request, response) =>
        request.url === "/mcp"
          ? response
              .writeHead(307, { location: `http://user:pass@${request.headers.host}/next` })
              .end()
          : answerMcp(response),
      );
      const result = await probe(`${server.url}/mcp`, hosted);
      expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
      expect(server.paths).toEqual(["/mcp", "/mcp"]);
    });

    it(`stops a same-origin redirect loop through the ${layer} layer`, async () => {
      const server = await serve((_, response) =>
        response.writeHead(307, { location: "/mcp" }).end(),
      );
      const result = await probe(`${server.url}/mcp`, hosted);
      expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
      // Initialize and `server/discover` each send the first request and five
      // followed hops, then stop at the sixth redirect.
      expect(server.keys.length).toBe(12);
    });

    it(`does not follow an empty Location through the ${layer} layer`, async () => {
      const server = await serve((_, response) => response.writeHead(307, { location: "" }).end());
      const result = await probe(`${server.url}/mcp`, hosted);
      expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
      expect(server.paths).toEqual(["/mcp", "/mcp"]);
    });

    it(`does not follow a cross-origin redirect on the metadata GET through the ${layer} layer`, async () => {
      const target = await serve((_, response) =>
        response.writeHead(200, { "content-type": "application/json" }).end("{}"),
      );
      const source = await serve((request, response) =>
        request.url?.startsWith("/.well-known/")
          ? response.writeHead(302, { location: `${target.url}${request.url}` }).end()
          : response.writeHead(401).end(),
      );
      const result = await probe(`${source.url}/mcp`, hosted);
      expect(target.paths).toEqual([]);
      expect(source.paths).toContain("/.well-known/oauth-protected-resource/mcp");
      expect(result).toMatchObject({ kind: "not-mcp", category: "auth-required" });
    });

    it(`follows a same-origin redirect on the metadata GET through the ${layer} layer`, async () => {
      const server = await serve((request, response) => {
        if (request.url === "/.well-known/oauth-protected-resource/mcp") {
          response.writeHead(302, { location: "/metadata" }).end();
        } else if (request.url === "/metadata") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              resource: `${server.url}/mcp`,
              authorization_servers: [server.url],
            }),
          );
        } else {
          response.writeHead(401).end();
        }
      });
      const result = await probe(`${server.url}/mcp`, hosted);
      expect(result).toEqual({ kind: "mcp", requiresAuth: true });
    });

    it(`cancels a refused redirect body through the ${layer} layer`, async () => {
      const target = await serve((_, response) => answerMcp(response));
      const source = await serve((_, response) => {
        response.writeHead(307, { location: `${target.url}/mcp` });
        response.write("a body that never ends");
      });
      const recorder = releaseRecorder();
      const result = await probe(`${source.url}/mcp`, hosted, recorder.fetch);
      expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
      expect(target.keys).toEqual([]);
      expect(source.paths.length).toBe(2);
      expect(recorder.earlierReleased).toEqual([true]);
    });

    it(`follows a same-origin redirect with an unfinished body through the ${layer} layer`, async () => {
      const server = await serve((request, response) => {
        if (request.url !== "/mcp") return answerMcp(response);
        response.writeHead(307, { location: "/next" });
        response.write("a body that never ends");
      });
      const recorder = releaseRecorder();
      const result = await probe(`${server.url}/mcp`, hosted, recorder.fetch);
      expect(result).toEqual({ kind: "mcp", requiresAuth: false });
      expect(server.paths).toEqual(["/mcp", "/next"]);
      expect(recorder.earlierReleased).toEqual([true]);
    });

    it(`does not send the endpoint query across origins from probeEndpoint through the ${layer} layer`, async () => {
      const target = await serve((_, response) => response.writeHead(404).end());
      const challenges: string[] = [];
      const source = await serve((request, response) => {
        if (request.url?.includes("/.well-known/")) return response.writeHead(404).end();
        if (request.method === "GET" && request.headers.accept === "application/json") {
          challenges.push(request.url ?? "/");
          return response.writeHead(302, { location: `${target.url}${request.url}` }).end();
        }
        response
          .writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": 'Bearer error="invalid_token"',
          })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32000, message: "unauthorized" },
            }),
          );
      });
      const httpClientLayer = layerFor(hosted);
      const config = makeTestConfig({ plugins: [mcpPlugin({ httpClientLayer })] as const });
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const executor = yield* createExecutor({ ...config, httpClientLayer });
            const probed = yield* executor.mcp.probeEndpoint({
              endpoint: `${source.url}/mcp?api_key=${KEY}`,
            });
            yield* executor.close();
            return probed;
          }),
        ).pipe(Effect.ensuring(Effect.promise(() => config.testDb.close()))),
      );
      expect(target.paths).toEqual([]);
      expect(challenges).toEqual([`/mcp?api_key=${KEY}`]);
      expect(result).toMatchObject({ connected: false, requiresAuthentication: true });
    });
  }
});
