import type { SandboxToolInvoker, ExecuteResult } from "@executor-js/codemode-core";
export type PreparedInvocation = {
  readonly invoker: SandboxToolInvoker;
  readonly finish: (result: ExecuteResult) => ExecuteResult;
};
