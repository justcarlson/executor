import { forkFeaturesOff, type ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "./skills";
import { transformSkill as attachment } from "./fork-attachment-skill-slot";
import { transformSkill as alias } from "./fork-alias-skill-slot";
import { transformSkill as lean } from "./fork-lean-skill-slot";
export const forkSkillCatalog = (
  catalog: readonly Skill[],
  features: ForkFeatures = forkFeaturesOff,
): readonly Skill[] =>
  features.enabled.length === 0
    ? catalog
    : catalog.map((skill) => attachment(alias(lean(skill, features), features), features));
