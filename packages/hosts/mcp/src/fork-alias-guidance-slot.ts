import { GUIDANCE_KEYS } from "./fork-guidance-types";
import type { GuidanceText, GuidanceSkill, GuidanceInstructions } from "./fork-guidance-types";
import { aliasSearchInvokeSkill, ALIAS_INSTRUCTIONS } from "./fork-alias-selection";
export const text: GuidanceText = (features, key, upstream) => {
  if (!features.has("integration-aliases")) return upstream;
  if (key === GUIDANCE_KEYS.integrationsIntegration)
    return "Integration slug, or an unambiguous alias such as gmail.";
  if (key === GUIDANCE_KEYS.searchIntegration)
    return "Integration slug from integrations, or an unambiguous alias such as gmail (resolved slug is returned as integration).";
  return upstream;
};
export const skill: GuidanceSkill = (features, upstream) =>
  features.has("integration-aliases") ? aliasSearchInvokeSkill(upstream) : upstream;
export const instructions: GuidanceInstructions = (features, upstream) =>
  features.has("integration-aliases") && upstream !== undefined
    ? `${upstream} ${ALIAS_INSTRUCTIONS}`
    : upstream;
