// ---------------------------------------------------------------------------
// Redirects for requests that carry caller-supplied credentials.
//
// A caller-supplied endpoint often carries a credential in its query string
// or in a header the caller typed. Plain fetch follows a cross-origin redirect
// with both, so the credential reaches whatever origin the endpoint names.
// `executeWithinOrigin` follows a redirect only under the MCP SDK's
// `fetchWithinOrigin` rule: same origin (or its https upgrade on default
// ports), same method, same userinfo, at most five hops. Any other redirect is
// returned as the response and nothing is sent to its target.
// ---------------------------------------------------------------------------

import { Effect, Exit, Option, Result, Scope } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  UrlParams,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/unstable/http";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

const isWithinOrigin = (from: URL, to: URL): boolean =>
  (from.protocol === to.protocol && from.host === to.host) ||
  (from.protocol === "http:" &&
    to.protocol === "https:" &&
    from.hostname === to.hostname &&
    !from.port &&
    !to.port);

const requestUrl = (request: HttpClientRequest.HttpClientRequest) =>
  UrlParams.makeUrl(request.url, request.urlParams, Option.getOrUndefined(request.hash));

/** Execute `request`, following a redirect only within its origin.
 *
 *  Every redirect body is cancelled as soon as its headers arrive, whether the
 *  hop is followed or returned, so a slow or endless redirect body cannot hold
 *  the connection or stall the next hop. A returned redirect therefore has no
 *  readable body. Any other response stays readable until the caller's scope
 *  closes. */
export const executeWithinOrigin = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const scopedClient = HttpClient.withScope(client);
    let current = request;
    for (let followed = 0; ; followed++) {
      const hop = yield* Scope.fork(scope);
      const response = yield* scopedClient
        .execute(current)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Scope.provide(hop),
        );
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      yield* Scope.close(hop, Exit.void);

      const location = response.headers["location"];
      const from = requestUrl(current);
      if (
        !location ||
        followed === MAX_REDIRECTS ||
        Result.isFailure(from) ||
        !URL.canParse(location, from.success.href)
      ) {
        return response;
      }
      const target = new URL(location, from.success);
      const keepsMethod =
        current.method === "GET" || response.status === 307 || response.status === 308;
      const keepsUserinfo =
        (!target.username && !target.password) ||
        (target.username === from.success.username && target.password === from.success.password);
      if (!keepsMethod || !keepsUserinfo || !isWithinOrigin(from.success, target)) return response;
      current = HttpClientRequest.setUrl(current, target);
    }
  });
