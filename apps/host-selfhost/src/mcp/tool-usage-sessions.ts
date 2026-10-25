import { Effect } from "effect";
import type { Client } from "@libsql/client";
import { makeInMemoryMcpSessionStore } from "@executor-js/host-mcp/in-memory-session-store";
import { makeToolUsageRecorder } from "./tool-usage-store";
import { observeToolUsageServer } from "./tool-usage";

export const makeToolUsageSessionStore =
  (client: Client): typeof makeInMemoryMcpSessionStore =>
  (build, options) => {
    const usage = makeToolUsageRecorder(client);
    const store = makeInMemoryMcpSessionStore(
      (principal, buildOptions) =>
        Effect.promise(() => usage.ready).pipe(
          Effect.flatMap(() => build(principal, buildOptions)),
          Effect.tap(({ mcpServer }) =>
            Effect.sync(() => {
              const memberHash = usage.memberHash(principal.organizationId, principal.accountId);
              if (memberHash !== null)
                observeToolUsageServer(mcpServer, memberHash, usage.record, usage.drop);
            }),
          ),
        ),
      options,
    );
    return {
      ...store,
      close: async () => {
        await store.close();
        await usage.close();
      },
    };
  };
