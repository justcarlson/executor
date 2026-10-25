import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ForkFeatureId, parseForkFeatures, parseForkConfiguration } from "@executor-js/sdk/core";
import { SEARCH_INVOKE_SKILL } from "./passthrough-tools";
import { mcpGuidanceSkill } from "./fork-guidance";
import * as compact from "./fork-compact-guidance-slot";
import * as alias from "./fork-alias-guidance-slot";
import * as lean from "./fork-lean-guidance-slot";

it.effect("retains every installed slot's markers in all-on guidance", () =>
  Effect.gen(function* () {
    const { unavailable } = yield* parseForkConfiguration();
    const features = yield* parseForkFeatures({
      explicitFeatures: ForkFeatureId.literals.filter((id) => !unavailable.includes(id)).join(","),
    });
    const body = mcpGuidanceSkill(features, SEARCH_INVOKE_SKILL).body;
    const upstreamLines = new Set(SEARCH_INVOKE_SKILL.body.split("\n"));
    for (const [name, slot] of [
      ["compact-search", compact],
      ["integration-aliases", alias],
      ["lean-guidance", lean],
    ] as const) {
      if (!features.has(name)) continue;
      const markers = slot
        .skill(features, SEARCH_INVOKE_SKILL)
        .body.split("\n")
        .filter((line) => !upstreamLines.has(line));
      for (const marker of markers) expect(body, name).toContain(marker);
    }
  }),
);
