import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ForkFeatureId, parseForkFeatures, parseForkConfiguration } from "@executor-js/sdk/core";
import { EXECUTE_SKILL, skillCatalogFor } from "./skills";
import { transformSkill as lean } from "./fork-lean-skill-slot";
import { transformSkill as alias } from "./fork-alias-skill-slot";
import { transformSkill as attachment } from "./fork-attachment-skill-slot";

it.effect("retains every installed slot's markers in the all-on execute guide", () =>
  Effect.gen(function* () {
    const { unavailable } = yield* parseForkConfiguration();
    const features = yield* parseForkFeatures({
      explicitFeatures: ForkFeatureId.literals.filter((id) => !unavailable.includes(id)).join(","),
    });
    const guide = skillCatalogFor({ artifacts: false, forkFeatures: features }).find(
      (skill) => skill.name === EXECUTE_SKILL.name,
    );
    expect(guide).toBeDefined();
    const upstreamLines = new Set(EXECUTE_SKILL.body.split("\n"));
    for (const [name, transform] of [
      ["lean-guidance", lean],
      ["integration-aliases", alias],
      ["automatic-attachments", attachment],
    ] as const) {
      if (!features.has(name)) continue;
      const markers = transform(EXECUTE_SKILL, features)
        .body.split("\n")
        .filter((line) => !upstreamLines.has(line));
      for (const marker of markers) expect(guide?.body, name).toContain(marker);
    }
  }),
);
