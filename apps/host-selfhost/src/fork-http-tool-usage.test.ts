import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { httpImageExecution } from "./testing/fork-http";

it.effect("records HTTP sandbox outcomes through the real self-host app", () =>
  Effect.gen(function* () {
    const off = yield* httpImageExecution(forkFeaturesOff);
    expect(off.isError).toBe(false);
    expect(off.structured.toolCalls).toBeUndefined();
    expect(off.structured.toolPaths).toBeUndefined();
    const production = yield* parseForkFeatures({ profile: "production-v1" });
    const withoutUsage = yield* parseForkFeatures({
      explicitFeatures: production.enabled.filter((id) => id !== "tool-usage").join(","),
    });
    const baseline = yield* httpImageExecution(withoutUsage);
    const on = yield* httpImageExecution(production);
    expect(on).toEqual({
      ...baseline,
      structured: {
        ...baseline.structured,
        toolCalls: [{ path: "http_images.org.main.get_test_image", status: "ok" }],
        toolPaths: ["http_images.org.main.get_test_image"],
      },
    });
  }),
);
