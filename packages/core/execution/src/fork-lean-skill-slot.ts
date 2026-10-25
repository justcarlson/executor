import type { ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "./skills";
import { forkExecuteSkill } from "./fork-execute-guidance";
export const transformSkill = (skill: Skill, features: ForkFeatures): Skill =>
  features.has("lean-guidance") ? forkExecuteSkill(skill, features) : skill;
