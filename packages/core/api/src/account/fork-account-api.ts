import { forkFeaturesOff, type ForkFeatures } from "@executor-js/sdk/core";
import { Layer } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiGroup,
  HttpApiMiddleware,
  type HttpApiEndpoint,
} from "effect/unstable/httpapi";

import { AccountApi, AccountHttpApi } from "./api";
import { AccountUnavailable } from "./fork-membership-errors";
import { accountHandlers } from "./handlers";

const membershipEndpoints = new Set(["me", "listApiKeys", "createApiKey", "revokeApiKey"]);

// This pass-through middleware only adds the error to the endpoint schemas.
export class AccountMembership extends HttpApiMiddleware.Service<AccountMembership>()(
  "AccountMembership",
  { error: AccountUnavailable },
) {}

type MembershipAccountApi = HttpApiGroup.AddMiddleware<typeof AccountApi, AccountMembership>;

export type AccountGroupHandlers = HttpApiBuilder.Handlers.FromGroup<MembershipAccountApi>;

const endpoints = Object.values(AccountApi.endpoints).map(
  (endpoint): HttpApiEndpoint.Any =>
    membershipEndpoints.has(endpoint.name) ? endpoint.middleware(AccountMembership) : endpoint,
);

// oxlint-disable-next-line executor/no-double-cast -- boundary: Effect has no typed per-endpoint group map
const membershipAccountApi = HttpApiGroup.make("account").add(
  ...(endpoints as [HttpApiEndpoint.Any]),
) as unknown as MembershipAccountApi;

const membershipAccountHttpApi = HttpApi.make("executor-account").add(membershipAccountApi);

// Off keeps the v1.6.11 runtime schema. Only the static type carries the membership error.
export const makeAccountHttpApi = (forkFeatures: ForkFeatures = forkFeaturesOff) =>
  forkFeatures.has("current-membership")
    ? membershipAccountHttpApi
    : // oxlint-disable-next-line executor/no-double-cast -- boundary: off widens only the static error type
      (AccountHttpApi as unknown as typeof membershipAccountHttpApi);

export const makeAccountHandlers = (forkFeatures: ForkFeatures = forkFeaturesOff) =>
  HttpApiBuilder.group(makeAccountHttpApi(forkFeatures), "account", accountHandlers).pipe(
    Layer.provide(Layer.succeed(AccountMembership)((httpEffect) => httpEffect)),
  );

export const AccountHandlers = makeAccountHandlers();
