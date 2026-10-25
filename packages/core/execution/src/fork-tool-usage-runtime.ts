import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import type { ForkFeatures } from "@executor-js/sdk/core";
import type { PreparedInvocation } from "./fork-runtime-types";
export const prepareToolOutcomes = (
  _invoker: SandboxToolInvoker,
  _features: ForkFeatures,
): PreparedInvocation | undefined => undefined;
