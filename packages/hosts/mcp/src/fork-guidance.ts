import { forkFeaturesOff, type ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "@executor-js/execution";
import type { GuidanceKey, GuidanceMode } from "./fork-guidance-types";
import * as compact from "./fork-compact-guidance-slot";
import * as alias from "./fork-alias-guidance-slot";
import * as lean from "./fork-lean-guidance-slot";
export const mcpGuidanceText = (
  features: ForkFeatures = forkFeaturesOff,
  key: GuidanceKey,
  upstream: string,
): string =>
  lean.text(features, key, alias.text(features, key, compact.text(features, key, upstream)));
export const mcpGuidanceSkill = (
  features: ForkFeatures = forkFeaturesOff,
  upstream: Skill,
): Skill => compact.skill(features, alias.skill(features, lean.skill(features, upstream)));
export const mcpGuidanceInstructions = (
  mode: GuidanceMode,
  upstream: string | undefined,
  features: ForkFeatures = forkFeaturesOff,
): { readonly instructions?: string } => {
  const instructions = lean.instructions(
    features,
    alias.instructions(features, upstream, mode),
    mode,
  );
  return instructions === undefined ? {} : { instructions };
};
