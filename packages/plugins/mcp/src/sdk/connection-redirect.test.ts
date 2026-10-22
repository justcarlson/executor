import assert from "node:assert/strict";
import { describe, expect, it, onTestFinished } from "@effect/vitest";
import { Effect, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createServer, type Server } from "node:http";
import { makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";

import { createMcpConnector } from "./connection";

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

describe("MCP redirect credential protection", () => {
  for (const hosted of [false, true]) {
    it(`preserves headers on a same-origin redirect through the ${hosted ? "hosted" : "fetch"} layer`, async () => {
      const received: string[] = [];
      const server = createServer((request, response) => {
        request.resume();
        if (request.url === "/mcp") {
          response.writeHead(307, { location: "/redirected" }).end();
        } else {
          received.push(String(request.headers["x-api-key"]));
          response.writeHead(400).end();
        }
      });
      const url = await listen(server);
      onTestFinished(() => close(server));
      await Effect.runPromise(
        createMcpConnector({
          transport: "remote",
          endpoint: `${url}/mcp`,
          remoteTransport: "streamable-http",
          headers: { "X-API-Key": "test-only-key" },
          httpClientLayer: hosted
            ? makeHostedHttpClientLayer({ allowLocalNetwork: true })
            : FetchHttpClient.layer,
        }).pipe(Effect.result),
      );
      expect(received.length).toBeGreaterThan(0);
      expect(received.every((header) => header === "test-only-key")).toBe(true);
    });
    for (const status of [302, 307]) {
      it(`refuses a cross-origin ${status} redirect through the ${hosted ? "hosted" : "fetch"} layer`, async () => {
        const received: string[] = [];
        const originalHeaders: string[] = [];
        const target = createServer((request, response) => {
          received.push(String(request.headers["x-api-key"]));
          request.resume();
          response.writeHead(400).end();
        });
        const targetUrl = await listen(target);
        const source = createServer((request, response) => {
          originalHeaders.push(String(request.headers["x-api-key"]));
          request.resume();
          response.writeHead(status, { location: `${targetUrl}/mcp` }).end();
        });
        const sourceUrl = await listen(source);
        onTestFinished(async () => {
          await close(source);
          await close(target);
        });
        const result = await Effect.runPromise(
          createMcpConnector({
            transport: "remote",
            endpoint: `${sourceUrl}/mcp`,
            remoteTransport: "streamable-http",
            headers: { "X-API-Key": "test-only-key" },
            httpClientLayer: hosted
              ? makeHostedHttpClientLayer({ allowLocalNetwork: true })
              : FetchHttpClient.layer,
          }).pipe(Effect.result),
        );
        expect(originalHeaders.length).toBeGreaterThan(0);
        expect(originalHeaders.every((header) => header === "test-only-key")).toBe(true);
        expect(received).toEqual([]);
        expect(Result.isFailure(result)).toBe(true);
      });
    }
  }
});
