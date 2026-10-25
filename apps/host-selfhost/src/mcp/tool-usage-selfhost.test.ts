import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { createSelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import { makeSelfHostMcpSessionStore } from "./session-store";

const base = resolve(import.meta.dirname, "../../../../.audit/u3");
mkdirSync(base, { recursive: true });
const directories: string[] = [];
const databases: SelfHostDbHandle[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("tool usage host feature selection", () => {
  for (const enabled of [false, true]) {
    it(`creates telemetry tables only when ${enabled ? "enabled" : "disabled"}`, async () => {
      const directory = mkdtempSync(join(base, "usage-"));
      directories.push(directory);
      const db = await createSelfHostDb({ path: join(directory, "usage.db") });
      databases.push(db);
      const batch = db.client.batch.bind(db.client);
      let batches = 0;
      db.client.batch = (...args) => {
        batches++;
        return batch(...args);
      };
      const forkFeatures = enabled
        ? Effect.runSync(parseForkFeatures({ explicitFeatures: "tool-usage" }))
        : forkFeaturesOff;
      const store = makeSelfHostMcpSessionStore(db, undefined, 0, forkFeatures);
      await store.close();
      expect(batches > 0).toBe(enabled);
      const tables = await db.client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'executor_tool_usage%' ORDER BY name",
      );
      expect(tables.rows.map((row) => row.name)).toEqual(
        enabled ? ["executor_tool_usage", "executor_tool_usage_state"] : [],
      );
    });
  }
});
