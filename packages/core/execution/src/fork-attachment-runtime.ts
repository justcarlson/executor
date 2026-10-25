import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import type { ForkFeatures } from "@executor-js/sdk/core";
import { withAttachmentDelivery } from "./attachment-delivery";
export const prepareAttachmentDelivery = (invoker: SandboxToolInvoker, features: ForkFeatures) =>
  features.has("automatic-attachments") ? withAttachmentDelivery(invoker) : undefined;
