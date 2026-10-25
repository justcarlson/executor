import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { freshForkIdentity } from "./support/fork-identity";
import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { withForkFeatures } from "./support/fork-features";
import { Api, Browser, Mcp } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);
const decodeContent = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        data: Schema.optional(Schema.String),
        mimeType: Schema.optional(Schema.String),
      }),
    ),
  }),
);

scenario(
  "Fork automatic-attachments · native images survive execution and approval",
  { timeout: 180_000 },
  withForkFeatures(
    ["automatic-attachments"],
    Effect.scoped(
      Effect.gen(function* () {
        const mcp = yield* Mcp;
        const browser = yield* Browser;
        const { client: makeClient } = yield* Api;
        const identity = yield* freshForkIdentity;
        const client = yield* makeClient(api, identity);
        const baseUrl = yield* createEmulatorInstance("mcp", "fork-attachments");
        const emulator = yield* Effect.acquireRelease(
          Effect.promise(() => connectEmulator({ baseUrl })),
          (instance) => Effect.promise(() => instance.reset()),
        );
        yield* Effect.promise(() => emulator.seed({ auth: "bearer" }));
        const credential = yield* Effect.promise(() =>
          emulator.credentials.mint({ type: "bearer-token" }),
        );
        if (!credential.token) return yield* Effect.die("Emulator omitted bearer token");
        const slug = IntegrationSlug.make(`fork_images_${randomBytes(4).toString("hex")}`);
        yield* Effect.gen(function* () {
          yield* client.mcp.addServer({
            payload: {
              transport: "remote",
              name: "Fork image emulator",
              slug,
              endpoint: `${baseUrl}/mcp`,
              remoteTransport: "streamable-http",
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
                },
              ],
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              integration: slug,
              name: ConnectionName.make("main"),
              template: AuthTemplateSlug.make("apiKey"),
              value: credential.token,
            },
          });
          const session = mcp.session(identity, { artifacts: false, elicitationMode: "model" });
          const code = `await tools.${slug}.org.main.get_test_image({}); return "image delivered";`;
          const executed = yield* session.call("execute", { code });
          const images = decodeContent(executed.raw).content.filter(
            (item) => item.type === "image",
          );
          expect(images).toHaveLength(1);
          expect(images[0]?.mimeType).toBe("image/png");
          expect(images[0]?.data?.length).toBeGreaterThan(0);
          const rule = yield* client.policies.create({
            payload: {
              owner: "org",
              pattern: `${slug}.*.*.get_test_image`,
              action: "require_approval",
            },
          });
          yield* Effect.gen(function* () {
            const paused = yield* session.call("execute", { code });
            const resumed = yield* session.approvePaused(paused.text);
            expect(
              decodeContent(resumed.raw).content.filter((item) => item.type === "image"),
            ).toEqual(images);
          }).pipe(
            Effect.ensuring(
              client.policies
                .remove({ params: { policyId: rule.id }, payload: { owner: "org" } })
                .pipe(Effect.orDie),
            ),
          );
          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the integration list for the recording", async () => {
              await visit(page, "/integrations");
              await page.getByText("Fork image emulator", { exact: true }).first().waitFor();
            });
          });
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* client.connections
                .remove({
                  params: { owner: "org", integration: slug, name: ConnectionName.make("main") },
                })
                .pipe(Effect.ignore);
              yield* client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore);
            }),
          ),
        );
      }),
    ),
  ),
);
