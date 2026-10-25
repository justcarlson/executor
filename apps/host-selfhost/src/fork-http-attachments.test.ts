import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { forkFeaturesOff, parseForkFeatures } from "@executor-js/sdk/core";
import { httpImageExecution } from "./testing/fork-http";

const decodeImage = Schema.decodeUnknownSync(
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Struct({
      isError: Schema.Boolean,
      structuredContent: Schema.Unknown,
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, mimeType: Schema.String, data: Schema.String }),
      ),
    }),
  }),
);

it.effect("delivers attachments through the self-host HTTP composition", () =>
  Effect.gen(function* () {
    const off = yield* httpImageExecution(forkFeaturesOff);
    expect(off.isError).toBe(false);
    const original = decodeImage(off.structured.result);
    expect(original.data.content[0]?.type).toBe("image");
    expect(original.data.content[0]?.data.length).toBeGreaterThan(0);
    expect(off.structured.emitted).toBeUndefined();
    expect(off.structured.toolCalls).toBeUndefined();
    expect(off.structured.toolPaths).toBeUndefined();
    expect(off.text).toBe(JSON.stringify(off.structured.result, null, 2));
    const features = yield* parseForkFeatures({ explicitFeatures: "automatic-attachments" });
    const on = yield* httpImageExecution(features);
    expect(on.isError).toBe(false);
    expect(on.structured.emitted).toBe(1);
    expect(on.structured.result).toEqual({
      ...original,
      data: {
        ...original.data,
        content: [
          { type: "text", text: JSON.stringify({ delivery: "attachment", mimeType: "image/png" }) },
        ],
      },
    });
  }),
);
