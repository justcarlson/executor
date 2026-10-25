import { Effect, Schema } from "effect";
import replay from "./replay.json";

export const ForkFeatureId = Schema.Literals([
  "inventory-descriptions",
  "automatic-attachments",
  "catalog-read-fastpath",
  "compact-search",
  "integration-aliases",
  "lean-guidance",
  "secret-key-cache",
  "tool-usage",
  "lazy-execute-description",
  "current-membership",
  "standalone-sse-keepalive",
  "detached-catalog-refresh",
]);
export type ForkFeatureId = typeof ForkFeatureId.Type;

export const ForkReplaySelection = Schema.Struct({
  upstreamCommit: Schema.String,
  available: Schema.Array(ForkFeatureId),
  production: Schema.Array(ForkFeatureId),
});
export type ForkReplaySelection = typeof ForkReplaySelection.Type;

export class ForkConfigurationError extends Schema.TaggedErrorClass<ForkConfigurationError>()(
  "ForkConfigurationError",
  { reason: Schema.String },
) {}

const freezeForkFeatures = (features: readonly ForkFeatureId[]) => {
  const enabled = Object.freeze([...features]);
  return Object.freeze({ enabled, has: (id: ForkFeatureId) => enabled.includes(id) });
};
export type ForkFeatures = ReturnType<typeof freezeForkFeatures>;
export const forkFeaturesOff = freezeForkFeatures([]);

export interface ForkFeatureInput {
  readonly profile?: string;
  readonly explicitFeatures?: string;
  readonly receipt?: unknown;
}

export const parseForkConfiguration = (input: ForkFeatureInput = {}) =>
  Effect.gen(function* () {
    const profile = input.profile === "" ? undefined : input.profile;
    const explicitFeatures = input.explicitFeatures === "" ? undefined : input.explicitFeatures;
    if (profile !== undefined && explicitFeatures !== undefined) {
      return yield* new ForkConfigurationError({
        reason: "A profile and an explicit feature list cannot be combined",
      });
    }
    if (profile !== undefined && profile !== "production-v1") {
      return yield* new ForkConfigurationError({
        reason: `Unknown fork profile: ${profile}`,
      });
    }
    const receipt = yield* Schema.decodeUnknownEffect(ForkReplaySelection)(
      input.receipt ?? replay,
    ).pipe(
      Effect.mapError(() => new ForkConfigurationError({ reason: "Invalid fork replay receipt" })),
    );
    for (const [name, ids] of [
      ["available", receipt.available],
      ["production", receipt.production],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        return yield* new ForkConfigurationError({
          reason: `Duplicate feature in receipt ${name}`,
        });
      }
    }
    if (receipt.production.some((id) => !receipt.available.includes(id))) {
      return yield* new ForkConfigurationError({
        reason: "Production receipt selects an unavailable feature",
      });
    }
    const names =
      profile === "production-v1"
        ? receipt.production
        : explicitFeatures === undefined
          ? []
          : explicitFeatures
              .split(",")
              .map((name) => name.trim())
              .filter((name) => name.length > 0);
    const selected = yield* Effect.forEach(names, (name) =>
      Schema.decodeUnknownEffect(ForkFeatureId)(name).pipe(
        Effect.mapError(
          () => new ForkConfigurationError({ reason: `Unknown fork feature: ${name}` }),
        ),
      ),
    );
    if (new Set(selected).size !== selected.length) {
      return yield* new ForkConfigurationError({ reason: "Duplicate fork feature" });
    }
    for (const id of selected) {
      if (!receipt.available.includes(id)) {
        return yield* new ForkConfigurationError({ reason: `Unavailable fork feature: ${id}` });
      }
    }
    return {
      selector: profile ?? (explicitFeatures === undefined ? "off" : "explicit"),
      features: freezeForkFeatures(selected),
      unavailable: ForkFeatureId.literals.filter((id) => !receipt.available.includes(id)),
    };
  });

export const parseForkFeatures = (
  input: ForkFeatureInput = {},
): Effect.Effect<ForkFeatures, ForkConfigurationError> =>
  parseForkConfiguration(input).pipe(Effect.map(({ features }) => features));
