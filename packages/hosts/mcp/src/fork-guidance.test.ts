import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { EXECUTE_SKILL, skillCatalogFor } from "@executor-js/execution";
import { parseForkConfiguration, parseForkFeatures, forkFeaturesOff } from "@executor-js/sdk/core";
import { codemodeInstructions, CODEMODE_BASE_INSTRUCTIONS } from "./codemode-instructions";
import {
  forkPassthroughInstructions,
  forkPassthroughText,
  forkSearchInvokeSkill,
  PASSTHROUGH_BASE_INSTRUCTIONS,
  SEARCH_GUIDE_PAGE_ANCHOR,
} from "./fork-passthrough-guidance";
import { mcpGuidanceSkill, mcpGuidanceInstructions } from "./fork-guidance";
import { SEARCH_INVOKE_SKILL, passthroughInstructions } from "./passthrough-tools";
import reference from "./fork-guidance-reference.json";
import { GUIDANCE_KEYS } from "./fork-guidance-types";
import { liveGuidanceKeys, liveGuidanceDescriptions } from "./fork-guidance-testing";

const occurrences = (text: string, anchor: string) => text.split(anchor).length - 1;
const featuresFor = (aliases: boolean, compact: boolean) =>
  Effect.gen(function* () {
    const { unavailable } = yield* parseForkConfiguration();
    return yield* parseForkFeatures({
      explicitFeatures: [
        "lean-guidance",
        ...(aliases ? ["integration-aliases"] : []),
        ...(compact ? ["compact-search"] : []),
      ]
        .filter((id) => !unavailable.some((missing) => missing === id))
        .join(","),
    });
  });
it("returns live upstream guides and instructions with all features off", () => {
  expect(skillCatalogFor({ artifacts: false, forkFeatures: forkFeaturesOff })[0]).toBe(
    EXECUTE_SKILL,
  );
  expect(mcpGuidanceSkill(forkFeaturesOff, SEARCH_INVOKE_SKILL)).toBe(SEARCH_INVOKE_SKILL);
  expect(
    mcpGuidanceInstructions("passthrough", passthroughInstructions(), forkFeaturesOff),
  ).toEqual({
    instructions: passthroughInstructions(),
  });
  expect(mcpGuidanceInstructions("codemode", undefined, forkFeaturesOff)).toEqual({});
});
it("finds each rewritten guidance anchor exactly once in its live input", () => {
  expect(occurrences(SEARCH_INVOKE_SKILL.body, SEARCH_GUIDE_PAGE_ANCHOR)).toBe(1);
  for (const anchor of [
    "slug or alias",
    "`namespace` accepts the slug or an unambiguous alias (`gmail` resolves to `google_gmail`);",
  ]) {
    expect(occurrences(CODEMODE_BASE_INSTRUCTIONS, anchor)).toBe(1);
  }
  for (const anchor of [
    "slug or alias",
    "Hits are compact: id, one-line description, and an argument summary.",
    'Use detail: "full" on search only when the argument summary is not enough; an invoke rejected for invalid arguments also returns the schema.\n',
  ]) {
    expect(occurrences(PASSTHROUGH_BASE_INSTRUCTIONS, anchor)).toBe(1);
  }
  expect(forkSearchInvokeSkill(SEARCH_INVOKE_SKILL).body).not.toContain(SEARCH_GUIDE_PAGE_ANCHOR);
});
it.effect("preserves fork-owned instructions for available features", () =>
  Effect.gen(function* () {
    const features = yield* featuresFor(true, true);
    expect(codemodeInstructions(features).includes("alias")).toBe(
      features.has("integration-aliases"),
    );
    expect(forkPassthroughInstructions(features).includes('detail: "full"')).toBe(
      features.has("compact-search"),
    );
    expect(codemodeInstructions(features) === reference.codemode).toBe(
      features.has("integration-aliases"),
    );
    expect(forkPassthroughInstructions(features) === reference.productionInstructions).toBe(
      features.has("integration-aliases") && features.has("compact-search"),
    );
  }),
);
describe("guidance follows the effective selection", () => {
  for (const aliases of [false, true])
    for (const compact of [false, true]) {
      it.effect(`aliases ${aliases}, compact ${compact}`, () =>
        Effect.gen(function* () {
          const features = yield* featuresFor(aliases, compact);
          const instructions = forkPassthroughInstructions(features);
          expect(instructions.includes("alias")).toBe(features.has("integration-aliases"));
          expect(instructions.includes('detail: "full"')).toBe(features.has("compact-search"));
          expect(codemodeInstructions(features).includes("alias")).toBe(
            features.has("integration-aliases"),
          );
        }),
      );
    }
});

it.effect("finds every lean upstream tool text key exactly once", () =>
  Effect.gen(function* () {
    const keys = yield* liveGuidanceKeys;
    for (const anchor of Object.values(GUIDANCE_KEYS).filter(
      (key) => key !== GUIDANCE_KEYS.searchDetail,
    )) {
      expect(
        keys.filter((key) => key === anchor),
        anchor,
      ).toHaveLength(1);
    }
  }),
);

it.effect("registers lean-guidance text on the live tool list", () =>
  Effect.gen(function* () {
    const own = yield* parseForkFeatures({ explicitFeatures: "lean-guidance" });
    const available = yield* featuresFor(true, true);
    for (const features of [own, available]) {
      const descriptions = new Map(yield* liveGuidanceDescriptions(features));
      for (const key of Object.values(GUIDANCE_KEYS)) {
        if (key === GUIDANCE_KEYS.searchDetail && !features.has("compact-search")) continue;
        expect(descriptions.get(key), key).toBe(forkPassthroughText(features, key));
      }
    }
  }),
);
