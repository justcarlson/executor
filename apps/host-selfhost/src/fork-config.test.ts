import { expect, it } from "@effect/vitest";
import { Effect, Logger, Predicate } from "effect";
import { ForkFeatureId } from "@executor-js/sdk/core";
import { loadForkConfig } from "./fork-config";

it.effect("logs the effective boot selection once", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const features = yield* loadForkConfig({
      explicitFeatures: "current-membership",
      receipt: { upstreamCommit: "test", available: [...ForkFeatureId.literals], production: [] },
    }).pipe(Effect.provide(Logger.layer([logger])));
    expect(features.enabled).toEqual(["current-membership"]);
    expect(messages).toEqual([
      ["fork features: profile=explicit enabled=[current-membership] unavailable=[]"],
    ]);
  }),
);

it.effect("logs unavailable features from the explicit receipt in schema order", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const features = yield* loadForkConfig({
      receipt: {
        upstreamCommit: "test",
        available: ForkFeatureId.literals
          .filter((id) => id !== "inventory-descriptions" && id !== "tool-usage")
          .toReversed(),
        production: [],
      },
    }).pipe(Effect.provide(Logger.layer([logger])));
    expect(features.enabled).toEqual([]);
    expect(messages).toEqual([
      ["fork features: profile=off enabled=[] unavailable=[inventory-descriptions,tool-usage]"],
    ]);
  }),
);

it.effect("does not report success for invalid boot configuration", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const error = yield* loadForkConfig({ explicitFeatures: "missing" }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.flip,
    );
    expect(Predicate.isTagged(error, "ForkConfigurationError")).toBe(true);
    expect(messages).toEqual([]);
  }),
);

for (const [input, selector] of [
  [{ profile: "", explicitFeatures: "" }, "off"],
  [{ profile: "production-v1", explicitFeatures: "" }, "production-v1"],
] as const) {
  it.effect(`logs the effective ${selector} selector for empty values`, () =>
    Effect.gen(function* () {
      const messages: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      const features = yield* loadForkConfig({
        ...input,
        receipt: { upstreamCommit: "test", available: [...ForkFeatureId.literals], production: [] },
      }).pipe(Effect.provide(Logger.layer([logger])));
      expect(features.enabled).toEqual([]);
      expect(messages).toEqual([[`fork features: profile=${selector} enabled=[] unavailable=[]`]]);
    }),
  );
}
