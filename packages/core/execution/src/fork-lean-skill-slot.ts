import type { ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "./skills";
export const transformSkill = (skill: Skill, _features: ForkFeatures): Skill => skill;
