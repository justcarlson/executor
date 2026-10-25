import { Context, Effect } from "effect";
import { type ForkFeatureId, parseForkConfiguration } from "@executor-js/sdk/core";
import { Target } from "../../src/services";

/** An attached E2E_SELFHOST_URL server must use the same fork variables as this process.
 * Docker does not forward those variables, so only the selfhost target provides features. */
export const withForkFeatures = <A, E, R>(
  required: readonly [ForkFeatureId, ...ForkFeatureId[]],
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const enabled =
      target.name === "selfhost"
        ? (yield* parseForkConfiguration({
            profile: process.env.EXECUTOR_FORK_PROFILE,
            explicitFeatures: process.env.EXECUTOR_FORK_FEATURES,
          })).features.enabled
        : [];
    for (const id of required) {
      if (!enabled.includes(id)) {
        yield* Effect.sync(() =>
          Context.getUnsafe(Context.empty(), Context.Service<true>(`e2e/fork-feature-${id}`)),
        );
      }
    }
    return yield* body;
  });
