import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { createExecutor, definePlugin, tool } from "@executor-js/sdk";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { createExecutionEngine } from "./engine";
import { withForkCodeExecutor } from "./fork-code-executor";
import { skillCatalogFor } from "./skills";
import { EXECUTE_SKILL } from "./skills";
import {
  ATTACHMENT_FILE_ANCHOR,
  ATTACHMENT_RETURN_ANCHOR,
  ATTACHMENT_PROVIDER_ANCHOR,
} from "./fork-attachment-skill";
import { SKILLS } from "./skills";
import { ATTACHMENT_EXECUTE_SKILL_NAME } from "./fork-attachment-skill";

const image = {
  type: "image",
  mimeType: "image/gif",
  data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};
const features = Effect.runSync(parseForkFeatures({ explicitFeatures: "automatic-attachments" }));
const plugin = definePlugin(() => ({
  id: "attachment-test" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "delivery.files",
      kind: "in-memory" as const,
      name: "Files",
      tools: [
        tool({
          name: "render",
          description: "Render an attachment.",
          annotations: { requiresApproval: true },
          inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
          execute: () => Effect.succeed({ content: [image] }),
        }),
      ],
    },
  ],
}));

describe("automatic attachment factory selection", () => {
  for (const enabled of [true, false]) {
    for (const mode of ["execute", "resume"] as const) {
      it.effect(
        `${mode} delivers the expected payload with attachments ${enabled ? "on" : "off"}`,
        () =>
          Effect.gen(function* () {
            const forkFeatures = enabled ? features : forkFeaturesOff;
            const executor = yield* createExecutor({
              ...makeTestConfig({ plugins: [plugin()] as const }),
              forkFeatures,
            });
            const engine = createExecutionEngine({
              executor,
              forkFeatures,
              codeExecutor: withForkCodeExecutor(makeQuickJsExecutor(), { forkFeatures }),
            });
            yield* Effect.addFinalizer(() =>
              engine.shutdown.pipe(Effect.andThen(executor.close()), Effect.ignore),
            );
            const code = "return await tools.delivery.files.render({});";
            const result = yield* mode === "execute"
              ? engine.execute(code, { onElicitation: () => Effect.succeed({ action: "accept" }) })
              : Effect.gen(function* () {
                  const paused = yield* engine.executeWithPause(code);
                  if (paused.status !== "paused")
                    return yield* Effect.die("expected approval pause");
                  const resumed = yield* engine.resume(paused.execution.id, {
                    action: "accept",
                    content: {},
                  });
                  if (resumed?.status !== "completed")
                    return yield* Effect.die("expected completed resume");
                  return resumed.result;
                });
            expect(result.error).toBeUndefined();
            expect(result.output).toEqual(
              enabled ? [{ type: "content", content: image }] : undefined,
            );
            expect(JSON.stringify(result.result).includes(image.data)).toBe(!enabled);
          }).pipe(Effect.scoped),
      );
    }
  }
  it("preserves the off executor and timeout", () => {
    const runtime = { ...makeQuickJsExecutor(), timeoutMs: 1234 };
    expect(withForkCodeExecutor(runtime, { forkFeatures: forkFeaturesOff })).toBe(runtime);
    expect(withForkCodeExecutor(runtime, { forkFeatures: features }).timeoutMs).toBe(1234);
  });
  it("selects truthful attachment instructions without changing the off catalog", () => {
    const off = skillCatalogFor({ artifacts: false, forkFeatures: forkFeaturesOff });
    expect(off).toEqual(skillCatalogFor({ artifacts: false }));
    expect(off[0]?.body).toContain("does not emit content");
    const on = skillCatalogFor({ artifacts: false, forkFeatures: features });
    expect(on[0]?.body).toContain("delivered automatically");
    expect(on[0]?.body).not.toContain("does not emit content");
  });
});

for (const anchor of [
  ATTACHMENT_FILE_ANCHOR,
  ATTACHMENT_RETURN_ANCHOR,
  ATTACHMENT_PROVIDER_ANCHOR,
]) {
  it(`finds attachment anchor ${anchor} exactly once in the live upstream guide`, () => {
    expect(
      EXECUTE_SKILL.body.split("\n").filter((line) => line.startsWith(anchor)),
      anchor,
    ).toHaveLength(1);
  });
}

it("finds the attachment execute skill key exactly once in the live upstream catalog", () => {
  expect(
    SKILLS.filter((skill) => skill.name === ATTACHMENT_EXECUTE_SKILL_NAME),
    ATTACHMENT_EXECUTE_SKILL_NAME,
  ).toHaveLength(1);
});
