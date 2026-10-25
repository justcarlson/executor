import { expect, it } from "@effect/vitest";
import { forkFeaturesOff } from "@executor-js/sdk/core";
import { Effect, Exit } from "effect";
import { httpImageExecution } from "./fork-http";

it.effect("executes through local MCP and restores the fixture environment", () =>
  Effect.gen(function* () {
    const before = { ...process.env };
    const result = yield* httpImageExecution(forkFeaturesOff).pipe(Effect.exit);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(process.env)])].filter(
      (key) => before[key] !== process.env[key],
    );
    expect(changed).toEqual([]);
    expect(Exit.isSuccess(result), String(result)).toBe(true);
  }),
);
