import { Effect } from "effect";
import type * as Cause from "effect/Cause";
import type { CodeExecutor } from "@executor-js/codemode-core";
import { forkFeaturesOff, type ForkFeatures } from "@executor-js/sdk/core";
import { prepareToolOutcomes } from "./fork-tool-usage-runtime";
import { prepareAttachmentDelivery } from "./fork-attachment-runtime";

export const withForkCodeExecutor = <E extends Cause.YieldableError>(
  codeExecutor: CodeExecutor<E>,
  { forkFeatures = forkFeaturesOff }: { readonly forkFeatures?: ForkFeatures } = {},
): CodeExecutor<E> =>
  !forkFeatures.has("automatic-attachments") && !forkFeatures.has("tool-usage")
    ? codeExecutor
    : {
        ...codeExecutor,
        execute: (code, invoker) => {
          const outcomes = prepareToolOutcomes(invoker, forkFeatures);
          const delivery = prepareAttachmentDelivery(outcomes?.invoker ?? invoker, forkFeatures);
          return codeExecutor.execute(code, delivery?.invoker ?? outcomes?.invoker ?? invoker).pipe(
            Effect.map((result) => {
              const delivered = delivery ? delivery.finish(result) : result;
              return outcomes ? outcomes.finish(delivered) : delivered;
            }),
          );
        },
      };
