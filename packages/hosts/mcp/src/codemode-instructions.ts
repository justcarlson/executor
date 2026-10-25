import type { ForkFeatures } from "@executor-js/sdk/core";

export const CODEMODE_BASE_INSTRUCTIONS = [
  "Executor runs tools of connected integrations inside `execute` (a TypeScript sandbox). Fastest path, one call:",
  '1. `const { items } = await tools.search({ query: "<action words>", namespace: "<integration slug or alias>", limit: 3 });`',
  '2. `if (!items[0]) return "no matching tool"; return await tools[items[0].path]({ ...arguments });`',
  "`namespace` accepts the slug or an unambiguous alias (`gmail` resolves to `google_gmail`); the `execute` description lists the connected integrations. Omit `namespace` when the integration is unknown.",
  "Call `tools.describe.tool({ path })` only when the argument shape is unknown. Results are `{ ok: true, data }` or `{ ok: false, error }`.",
  'Read `skills({ name: "execute" })` once per session for files, `emit`, pagination, and resume.',
].join("\n");

export const codemodeInstructions = (features: ForkFeatures): string =>
  CODEMODE_BASE_INSTRUCTIONS.replaceAll(
    "slug or alias",
    features.has("integration-aliases") ? "slug or alias" : "slug",
  ).replace(
    "`namespace` accepts the slug or an unambiguous alias (`gmail` resolves to `google_gmail`);",
    features.has("integration-aliases")
      ? "`namespace` accepts the slug or an unambiguous alias (`gmail` resolves to `google_gmail`);"
      : "`namespace` accepts the exact integration slug;",
  );
