import type { McpToolMode } from "./browser-approval";
import type { ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "@executor-js/execution";
export const GUIDANCE_KEYS = {
  integrationsDescription: "integrations.description",
  integrationsIntegration: "integrations.integration",
  searchDescription: "search.description",
  searchQuery: "search.query",
  searchIntegration: "search.integration",
  searchConnection: "search.connection",
  searchDetail: "search.detail",
  invokeDescription: "invoke.description",
  invokeTool: "invoke.tool",
  invokeArguments: "invoke.arguments",
  skillsDescription: "skills.description",
  skillsName: "skills.name",
} as const;
export type GuidanceKey = (typeof GUIDANCE_KEYS)[keyof typeof GUIDANCE_KEYS];
const guidanceKeys: ReadonlySet<string> = new Set(Object.values(GUIDANCE_KEYS));
export const isGuidanceKey = (key: string): key is GuidanceKey => guidanceKeys.has(key);
export type GuidanceMode = McpToolMode;
export type GuidanceText = (features: ForkFeatures, key: GuidanceKey, upstream: string) => string;
export type GuidanceSkill = (features: ForkFeatures, upstream: Skill) => Skill;
export type GuidanceInstructions = (
  features: ForkFeatures,
  upstream: string | undefined,
  mode: GuidanceMode,
) => string | undefined;
