import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it, onTestFinished } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/unstable/http";

import { makeHostedHttpClientLayer } from "./hosted-http-client";
import { executeWithinOrigin } from "./within-origin-redirect";

interface TestServer {
  readonly url: string;
  readonly paths: string[];
}

const serve = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> => {
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
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
  return { url: `http://127.0.0.1:${address.port}`, paths };
};

const ok = (response: ServerResponse) => response.writeHead(200).end("ok");

// oxlint-disable-next-line executor/no-raw-fetch -- test boundary: the spy records each request's abort signal and must delegate to the platform fetch
const platformFetch: typeof globalThis.fetch = globalThis.fetch;

const layers = {
  fetch: (fetch: typeof globalThis.fetch) =>
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch))),
  hosted: (fetch: typeof globalThis.fetch) =>
    makeHostedHttpClientLayer({ allowLocalNetwork: true, fetch }),
} as const;

/** Runs `request` through the helper. `whileOpen` runs before the caller's scope
 *  closes, with the abort state of each fetch the client made so far. Releasing a
 *  response aborts its fetch, so this observes the release in any runtime. */
const run = <A>(
  layer: keyof typeof layers,
  request: HttpClientRequest.HttpClientRequest,
  whileOpen: (
    response: HttpClientResponse.HttpClientResponse,
    aborted: readonly boolean[],
  ) => Effect.Effect<A, HttpClientError.HttpClientError>,
) => {
  const signals: AbortSignal[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    assert(init?.signal);
    signals.push(init.signal);
    return platformFetch(input, init);
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* executeWithinOrigin(client, request);
      const aborted = signals.map((signal) => signal.aborted);
      return { status: response.status, whileOpen: yield* whileOpen(response, aborted) };
    }).pipe(
      Effect.scoped,
      Effect.provide(layers[layer](fetch)),
      Effect.timeout(Duration.seconds(3)),
    ),
  );
};

const execute = (layer: keyof typeof layers, request: HttpClientRequest.HttpClientRequest) =>
  run(layer, request, () => Effect.void).then(({ status }) => status);

const request = (method: "GET" | "POST", url: string) =>
  method === "GET"
    ? HttpClientRequest.get(url)
    : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText("{}", "application/json"));

/** Whether a redirect from the source's `/start` to `location` is followed.
 *  `null` sends no `Location` header at all. */
interface RedirectCase {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly status: number;
  readonly location: (origins: {
    readonly source: string;
    readonly target: string;
  }) => string | null;
  readonly followed: boolean;
}

const sourcePort = (source: string) => new URL(source).port;

const cases: readonly RedirectCase[] = [
  ...[301, 302, 303, 307, 308].map((status) => ({
    name: `refuses a cross-origin ${status} on GET`,
    method: "GET" as const,
    status,
    location: ({ target }: { readonly target: string }) => `${target}/next`,
    followed: false,
  })),
  ...[307, 308].map((status) => ({
    name: `refuses a cross-origin ${status} on POST`,
    method: "POST" as const,
    status,
    location: ({ target }: { readonly target: string }) => `${target}/next`,
    followed: false,
  })),
  ...[301, 302, 303, 307, 308].map((status) => ({
    name: `follows a same-origin ${status} on GET`,
    method: "GET" as const,
    status,
    location: () => "/next",
    followed: true,
  })),
  ...[301, 302, 303].map((status) => ({
    name: `refuses a same-origin ${status} on POST, which would change the method`,
    method: "POST" as const,
    status,
    location: () => "/next",
    followed: false,
  })),
  ...[307, 308].map((status) => ({
    name: `follows a same-origin ${status} on POST`,
    method: "POST" as const,
    status,
    location: () => "/next",
    followed: true,
  })),
  {
    name: "follows a relative Location",
    method: "GET",
    status: 302,
    location: () => "next",
    followed: true,
  },
  {
    name: "refuses a same-origin Location that adds userinfo",
    method: "GET",
    status: 307,
    location: ({ source }) => `http://user:pass@127.0.0.1:${sourcePort(source)}/next`,
    followed: false,
  },
  {
    name: "refuses a Location on another port of the same host",
    method: "GET",
    status: 307,
    location: ({ target }) => `${target}/next`,
    followed: false,
  },
  {
    name: "returns a redirect with an empty Location",
    method: "GET",
    status: 307,
    location: () => "",
    followed: false,
  },
  {
    name: "returns a redirect with no Location",
    method: "GET",
    status: 307,
    location: () => null,
    followed: false,
  },
];

describe("executeWithinOrigin", () => {
  for (const layer of ["fetch", "hosted"] as const) {
    describe(`through the ${layer} layer`, () => {
      for (const testCase of cases) {
        it(testCase.name, async () => {
          const target = await serve((_, response) => ok(response));
          let origins = { source: "", target: target.url };
          const source = await serve((incoming, response) => {
            if (incoming.url !== "/start") return ok(response);
            const location = testCase.location(origins);
            response
              .writeHead(testCase.status, location === null ? {} : { location })
              .end("redirect body");
          });
          origins = { source: source.url, target: target.url };

          const status = await execute(layer, request(testCase.method, `${source.url}/start`));

          expect(target.paths).toEqual([]);
          expect({ status, paths: source.paths }).toEqual(
            testCase.followed
              ? { status: 200, paths: ["/start", "/next"] }
              : { status: testCase.status, paths: ["/start"] },
          );
        });
      }

      it("follows five hops and returns the sixth redirect", async () => {
        const source = await serve((incoming, response) => {
          const hop = Number((incoming.url ?? "").slice("/hop".length));
          if (hop === 6) return ok(response);
          response.writeHead(307, { location: `/hop${hop + 1}` }).end();
        });

        const status = await execute(layer, request("GET", `${source.url}/hop0`));

        expect(status).toBe(307);
        expect(source.paths).toEqual(["/hop0", "/hop1", "/hop2", "/hop3", "/hop4", "/hop5"]);
      });

      it("resolves Location against the full URL of a followed hop, query included", async () => {
        // The first hop's query sits in the request URL. After a followed hop
        // it moves to the request's URL params, so only a second redirect
        // shows whether the helper resolves against the full URL.
        const locations = ["/mid?page=3", "#next"];
        const source = await serve((_, response) => {
          const location = locations.shift();
          if (location === undefined) return ok(response);
          response.writeHead(307, { location }).end();
        });

        const status = await execute(layer, request("GET", `${source.url}/start?page=2`));

        expect(status).toBe(200);
        expect(source.paths).toEqual(["/start?page=2", "/mid?page=3", "/mid?page=3"]);
      });

      it("cancels a refused redirect body before it returns", async () => {
        const target = await serve((_, response) => ok(response));
        const source = await serve((_, response) => {
          response.writeHead(307, { location: `${target.url}/next` });
          response.write("a body that never ends");
        });

        const result = await run(layer, request("GET", `${source.url}/start`), (_, aborted) =>
          Effect.succeed(aborted),
        );

        expect(result).toEqual({ status: 307, whileOpen: [true] });
        expect(target.paths).toEqual([]);
      });

      it("cancels a followed redirect body and keeps the final body readable", async () => {
        const source = await serve((incoming, response) => {
          if (incoming.url !== "/start") return ok(response);
          response.writeHead(307, { location: "/next" });
          response.write("a body that never ends");
        });

        const result = await run(
          layer,
          request("GET", `${source.url}/start`),
          (response, aborted) => Effect.map(response.text, (body) => ({ aborted, body })),
        );

        expect(result).toEqual({ status: 200, whileOpen: { aborted: [true, false], body: "ok" } });
        expect(source.paths).toEqual(["/start", "/next"]);
      });
    });
  }
});
