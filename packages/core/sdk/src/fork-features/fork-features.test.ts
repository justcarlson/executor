import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import {
  ForkFeatureId,
  forkFeaturesOff,
  parseForkConfiguration,
  parseForkFeatures as parseSelection,
} from "./index";
import receipt from "./replay.json";
const replay = {
  ...receipt,
  available: [...ForkFeatureId.literals],
  production: [...ForkFeatureId.literals],
};
const parseForkFeatures = (input: Parameters<typeof parseSelection>[0] = {}) =>
  parseSelection({ receipt: replay, ...input });

describe("fork feature selection", () => {
  it.effect("defaults to an immutable empty selection", () =>
    Effect.gen(function* () {
      const parsed = yield* parseForkFeatures();
      for (const value of [parsed, forkFeaturesOff]) {
        expect(value.enabled).toEqual([]);
        expect(value.has("current-membership")).toBe(false);
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.enabled)).toBe(true);
        expect(Reflect.set(value, "has", () => true)).toBe(false);
        expect(Reflect.set(value.enabled, "0", "current-membership")).toBe(false);
        expect("add" in value).toBe(false);
        expect("delete" in value).toBe(false);
        expect("clear" in value).toBe(false);
      }
    }),
  );
  it.effect("copies explicit selections and keeps hosts independent", () =>
    Effect.gen(function* () {
      const on = yield* parseForkFeatures({
        explicitFeatures: "current-membership, compact-search",
      });
      expect(on.has("current-membership")).toBe(true);
      expect(on.has("compact-search")).toBe(true);
      expect(on.has("tool-usage")).toBe(false);
      expect(forkFeaturesOff.has("current-membership")).toBe(false);
      expect(Reflect.set(on.enabled, "0", "tool-usage")).toBe(false);
    }),
  );
  it.effect("derives production from the receipt", () =>
    Effect.gen(function* () {
      const production = ["current-membership"];
      const on = yield* parseForkFeatures({
        profile: "production-v1",
        receipt: { ...replay, production },
      });
      production.length = 0;
      expect(on.enabled).toEqual(["current-membership"]);
      expect((yield* parseForkFeatures({ profile: "production-v1" })).enabled).toEqual(
        ForkFeatureId.literals.filter((id) => replay.production.includes(id)),
      );
      expect((yield* parseSelection({ profile: "production-v1" })).enabled).toEqual(
        ForkFeatureId.literals.filter((id) => receipt.production.includes(id)),
      );
    }),
  );
  for (const [name, input] of [
    ["unknown id", { explicitFeatures: "not-a-feature" }],
    ["duplicate id", { explicitFeatures: "tool-usage,tool-usage" }],
    ["conflicting selectors", { profile: "production-v1", explicitFeatures: "tool-usage" }],
    ["unknown profile", { profile: "production" }],
    ["unavailable id", { explicitFeatures: "tool-usage", receipt: { ...replay, available: [] } }],
    ["invalid receipt", { receipt: { available: ["not-a-feature"] } }],
    ["duplicate available id", { receipt: { ...replay, available: ["tool-usage", "tool-usage"] } }],
    [
      "duplicate production id",
      { receipt: { ...replay, production: ["tool-usage", "tool-usage"] } },
    ],
    [
      "unavailable production id",
      { receipt: { ...replay, available: [], production: ["tool-usage"] } },
    ],
  ] as const) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* parseForkFeatures(input).pipe(Effect.flip);
        expect(Predicate.isTagged(error, "ForkConfigurationError")).toBe(true);
      }),
    );
  }
});

it.effect("treats an empty profile as unset and ignores empty list items", () =>
  Effect.gen(function* () {
    expect((yield* parseForkFeatures({ profile: "" })).enabled).toEqual([]);
    expect(
      (yield* parseForkFeatures({ profile: "", explicitFeatures: ", tool-usage, ," })).enabled,
    ).toEqual(["tool-usage"]);
    const error = yield* parseForkFeatures({ explicitFeatures: ", unknown-id," }).pipe(Effect.flip);
    expect(error.reason).toBe("Unknown fork feature: unknown-id");
  }),
);

for (const [input, selector, enabled] of [
  [{ profile: "", explicitFeatures: "" }, "off", []],
  [{ profile: "production-v1", explicitFeatures: "" }, "production-v1", replay.production],
  [{ profile: "", explicitFeatures: "tool-usage" }, "explicit", ["tool-usage"]],
] as const) {
  it.effect(`normalizes empty selectors for ${selector}`, () =>
    Effect.gen(function* () {
      const result = yield* parseForkConfiguration({ ...input, receipt: replay });
      expect(result.selector).toBe(selector);
      expect(result.features.enabled).toEqual(enabled);
    }),
  );
}
