import { Effect } from "effect";
import { parseForkConfiguration, type ForkFeatureInput } from "@executor-js/sdk/core";

export const loadForkConfig = (
  input: ForkFeatureInput = {
    profile: process.env.EXECUTOR_FORK_PROFILE,
    explicitFeatures: process.env.EXECUTOR_FORK_FEATURES,
  },
) =>
  parseForkConfiguration(input).pipe(
    Effect.tap(({ features, unavailable, selector }) =>
      Effect.logInfo(
        `fork features: profile=${selector} enabled=[${features.enabled.join(",")}] unavailable=[${unavailable.join(",")}]`,
      ),
    ),
    Effect.map(({ features }) => features),
  );
