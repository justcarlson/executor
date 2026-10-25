import type { ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "./skills";
import { withAttachmentInstructions } from "./fork-attachment-skill";
export const transformSkill = (skill: Skill, features: ForkFeatures): Skill =>
  features.has("automatic-attachments") ? withAttachmentInstructions(skill) : skill;
