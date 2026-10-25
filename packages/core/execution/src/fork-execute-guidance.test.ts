import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseForkConfiguration, parseForkFeatures } from "@executor-js/sdk/core";
import { EXECUTE_SKILL } from "./skills";
import { forkExecuteSkill, EXECUTE_WORKFLOW_ANCHOR } from "./fork-execute-guidance";
import { EXECUTE_WORKFLOW_START_ANCHOR, EXECUTE_RULES_ANCHOR } from "./fork-execute-guidance";
import { SKILLS } from "./skills";
import { LEAN_EXECUTE_SKILL_NAME } from "./fork-execute-guidance";

it("matches the live upstream workflow exactly once", () => {
  expect([
    ...EXECUTE_SKILL.body.matchAll(new RegExp(EXECUTE_WORKFLOW_ANCHOR.source, "g")),
  ]).toHaveLength(1);
});
for (const aliases of [false, true]) {
  it.effect(`uses the selected namespace vocabulary with aliases ${aliases}`, () =>
    Effect.gen(function* () {
      const { unavailable } = yield* parseForkConfiguration();
      const features = yield* parseForkFeatures({
        explicitFeatures:
          aliases && !unavailable.includes("integration-aliases")
            ? "lean-guidance,integration-aliases"
            : "lean-guidance",
      });
      const body = forkExecuteSkill(EXECUTE_SKILL, features).body;
      expect(body.includes("integration slug or alias")).toBe(features.has("integration-aliases"));
      expect(body.split("integration slug")).toHaveLength(2);
      expect(body).toContain("limit: 3");
    }),
  );
}

it("finds each workflow boundary exactly once in the live upstream guide", () => {
  expect(
    [...EXECUTE_SKILL.body.matchAll(new RegExp(EXECUTE_WORKFLOW_START_ANCHOR.source, "g"))],
    EXECUTE_WORKFLOW_START_ANCHOR.source,
  ).toHaveLength(1);
  expect(EXECUTE_SKILL.body.split(EXECUTE_RULES_ANCHOR).length - 1, EXECUTE_RULES_ANCHOR).toBe(1);
});

it("finds the lean execute skill key exactly once in the live upstream catalog", () => {
  expect(
    SKILLS.filter((skill) => skill.name === LEAN_EXECUTE_SKILL_NAME),
    LEAN_EXECUTE_SKILL_NAME,
  ).toHaveLength(1);
});
