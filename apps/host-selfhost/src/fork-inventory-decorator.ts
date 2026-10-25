import type { EngineDecoratorShape } from "@executor-js/api/server";
import type { ForkFeatures } from "@executor-js/sdk/core";
import type { ExecutionEngine } from "@executor-js/execution";
import type * as Cause from "effect/Cause";
export const withForkInventoryDescription = <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  _context: Parameters<EngineDecoratorShape["decorate"]>[2],
  _features: ForkFeatures,
) => engine;
