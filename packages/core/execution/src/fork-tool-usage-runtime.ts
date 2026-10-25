import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import type { ForkFeatures } from "@executor-js/sdk/core";
import { withToolOutcomes } from "./fork-tool-outcomes";
export const prepareToolOutcomes = (invoker: SandboxToolInvoker, features: ForkFeatures) =>
  features.has("tool-usage") ? withToolOutcomes(invoker) : undefined;
