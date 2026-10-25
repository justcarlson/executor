import type { GuidanceText, GuidanceSkill, GuidanceInstructions } from "./fork-guidance-types";
export const text: GuidanceText = (_features, _key, upstream) => upstream;
export const skill: GuidanceSkill = (_features, upstream) => upstream;
export const instructions: GuidanceInstructions = (_features, upstream) => upstream;
