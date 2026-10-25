import { INTEGRATION_INVENTORY_HEADER, buildExecuteDescription } from "./description";
import { forkFeaturesOff, type ForkFeatures } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { Connection, Executor, Integration, Tool } from "@executor-js/sdk/core";

export const buildForkExecuteDescription = (
  executor: Executor,
  { forkFeatures = forkFeaturesOff }: { readonly forkFeatures?: ForkFeatures } = {},
): Effect.Effect<string> =>
  !forkFeatures.has("inventory-descriptions")
    ? buildExecuteDescription(executor)
    : Effect.gen(function* () {
        const connections: readonly Connection[] = yield* executor.connections.list().pipe(
          // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: ExecutionEngine.getDescription currently exposes no error channel; engine typed-error widening is covered separately
          Effect.orDie,
          Effect.withSpan("executor.connections.list"),
        );

        const integrations: readonly Integration[] = yield* executor.integrations.list().pipe(
          // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: same as the connections read above; ExecutionEngine.getDescription exposes no error channel
          Effect.orDie,
          Effect.withSpan("executor.integrations.list"),
        );

        const callableIntegrations: ReadonlySet<string> | null = yield* executor.tools
          .list({ includeAnnotations: false })
          .pipe(
            Effect.map(
              (tools: readonly Tool[]) => new Set(tools.map((tool) => String(tool.integration))),
            ),
            Effect.catch((error) =>
              Effect.logWarning("execute description tool inventory read failed", { error }).pipe(
                Effect.as(null),
              ),
            ),
            Effect.withSpan("executor.tools.list"),
          );

        const listed =
          callableIntegrations === null
            ? connections
            : connections.filter((connection) =>
                callableIntegrations.has(String(connection.integration)),
              );

        const description = yield* Effect.sync(() => {
          const lines = [
            "Execute TypeScript in a sandboxed runtime.",
            "",
            'Before writing code, call `skills({ name: "execute" })` for the workflow on how to use this tool.',
          ];
          const inventory = formatIntegrationInventory(listed, integrations);
          if (inventory.length > 0) {
            lines.push("");
            lines.push(inventory);
          }
          return lines.join("\n");
        }).pipe(
          Effect.withSpan("schema.compile.description", {
            attributes: { "executor.connection_count": connections.length },
          }),
        );

        yield* Effect.annotateCurrentSpan({
          "executor.connection_count": connections.length,
          "executor.connection_hidden_count":
            callableIntegrations === null ? -1 : connections.length - listed.length,
          "schema.kind": "execute",
          "executor.connection_addresses": connections
            .map((connection) => connectionPath(connection))
            .slice(0, 50)
            .join(","),
          "executor.connection_integrations": [
            ...new Set(connections.map((connection) => String(connection.integration))),
          ].join(","),
          "executor.connection_owners": [
            ...new Set(connections.map((connection) => connection.owner)),
          ].join(","),
        });

        return description;
      }).pipe(Effect.withSpan("schema.describe.execute"));

const connectionPath = (connection: Connection): string => {
  const address = String(connection.address);
  return address.startsWith("tools.") ? address.slice("tools.".length) : address;
};

const INVENTORY_DESCRIBED_INTEGRATION_LIMIT = 50;

const INVENTORY_DESCRIPTION_LIMIT = 120;

const formatInventoryDescription = (description: string | null | undefined): string => {
  if (!description) return "";
  const flat = description.split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  if (flat.length <= INVENTORY_DESCRIPTION_LIMIT) return flat;
  const cut = flat.slice(0, INVENTORY_DESCRIPTION_LIMIT);
  const edge = cut.lastIndexOf(" ");
  return `${edge > 0 ? cut.slice(0, edge) : cut}…`;
};

const formatIntegrationInventory = (
  connections: readonly Connection[],
  integrations: readonly Integration[],
): string => {
  const slugs = [...new Set(connections.map((connection) => String(connection.integration)))].sort(
    (a, b) => a.localeCompare(b),
  );
  if (slugs.length === 0) return "";
  const descriptions = new Map(
    integrations.map((integration) => [
      String(integration.slug),
      {
        name: integration.name,
        summary: formatInventoryDescription(integration.description),
      },
    ]),
  );
  const lines = [
    INTEGRATION_INVENTORY_HEADER,
    "",
    "Integrations you have connected. Their tools live under `tools.<integration>.…`.",
    ...slugs.map((slug, index) => {
      if (index >= INVENTORY_DESCRIBED_INTEGRATION_LIMIT) return `- \`${slug}\``;
      const entry = descriptions.get(slug);
      const summary =
        entry &&
        entry.summary.length > 0 &&
        entry.summary.toLowerCase() !== slug.toLowerCase() &&
        entry.summary.toLowerCase() !== entry.name.toLowerCase()
          ? entry.summary
          : "";
      return summary ? `- \`${slug}\` — ${summary}` : `- \`${slug}\``;
    }),
  ];
  return lines.join("\n");
};
