import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { AccountHttpApi } from "./api";
import { makeAccountHttpApi } from "./fork-account-api";

it("preserves the live upstream account contract with features off", () => {
  expect(makeAccountHttpApi(forkFeaturesOff)).toBe(AccountHttpApi);
});

it.effect("adds unavailable only to the four membership endpoints", () =>
  Effect.gen(function* () {
    const features = yield* parseForkFeatures({ explicitFeatures: "current-membership" });
    const spec = OpenApi.fromApi(makeAccountHttpApi(features));
    const unavailable = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (operation.responses?.["503"]) unavailable.push(`${method} ${path}`);
      }
    }
    expect(unavailable).toEqual([
      "get /account/me",
      "get /account/api-keys",
      "post /account/api-keys",
      "delete /account/api-keys/{apiKeyId}",
    ]);
  }),
);
