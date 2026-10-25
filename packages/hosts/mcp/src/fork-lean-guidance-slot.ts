import type { GuidanceText, GuidanceSkill, GuidanceInstructions } from "./fork-guidance-types";
import {
  forkPassthroughText,
  forkSearchInvokeSkill,
  forkPassthroughInstructions,
} from "./fork-passthrough-guidance";
import { codemodeInstructions } from "./codemode-instructions";
export const text: GuidanceText = (features, key, upstream) =>
  features.has("lean-guidance") ? forkPassthroughText(features, key) : upstream;
export const skill: GuidanceSkill = (features, upstream) =>
  features.has("lean-guidance") ? forkSearchInvokeSkill(upstream) : upstream;
export const instructions: GuidanceInstructions = (features, upstream, mode) =>
  features.has("lean-guidance")
    ? mode === "codemode"
      ? codemodeInstructions(features)
      : forkPassthroughInstructions(features)
    : upstream;
