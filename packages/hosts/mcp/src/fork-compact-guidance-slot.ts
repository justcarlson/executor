import { GUIDANCE_KEYS } from "./fork-guidance-types";
import type { GuidanceText, GuidanceSkill } from "./fork-guidance-types";
import { COMPACT_SEARCH_DESCRIPTION, compactSearchSkill } from "./fork-compact-search";
export const text: GuidanceText = (features, key, upstream) =>
  features.has("compact-search") && key === GUIDANCE_KEYS.searchDescription
    ? COMPACT_SEARCH_DESCRIPTION
    : upstream;
export const skill: GuidanceSkill = (features, upstream) =>
  features.has("compact-search") ? compactSearchSkill(upstream) : upstream;
