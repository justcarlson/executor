import type { ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "./skills";
import { withAliasInstructions } from "./integration-aliases";
export const transformSkill = (skill: Skill, features: ForkFeatures): Skill =>
  features.has("integration-aliases") ? withAliasInstructions(skill) : skill;
