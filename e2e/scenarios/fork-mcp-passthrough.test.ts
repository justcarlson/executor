import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { connectEmulator } from "@executor-js/emulate";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { withForkFeatures } from "./support/fork-features";
import { freshForkIdentity } from "./support/fork-identity";
import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Mcp } from "../src/services";
import { visit } from "../src/surfaces/browser";

const decodeToolSearch = Schema.decodeUnknownSync(
  Schema.Struct({
    structuredContent: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          arguments: Schema.optional(Schema.String),
          inputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    }),
  }),
);

const decodeInputSchema = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const decodeEmailSubject = Schema.decodeUnknownOption(Schema.Struct({ subject: Schema.String }));

const api = composePluginApi([openApiHttpPlugin()] as const);

scenario(
  "Fork compact-search · discovery returns summaries and full schemas on request",
  { timeout: 180_000 },
  withForkFeatures(
    ["compact-search"],
    Effect.scoped(
      Effect.gen(function* () {
        const mcp = yield* Mcp;
        const browser = yield* Browser;
        const { client: makeClient } = yield* Api;
        const identity = yield* freshForkIdentity;
        const client = yield* makeClient(api, identity);
        const baseUrl = yield* createEmulatorInstance("resend", "fork-compact-search");
        const upstream = yield* Effect.acquireRelease(
          Effect.promise(() => connectEmulator({ baseUrl })),
          (emulator) => Effect.promise(() => emulator.reset()),
        );
        const credential = yield* Effect.promise(() =>
          upstream.credentials.mint({ type: "api-key" }),
        );
        if (!credential.token) return yield* Effect.die("Emulator omitted API key");
        const slug = IntegrationSlug.make(`fork_search_${randomBytes(4).toString("hex")}`);
        yield* Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "url", url: upstream.openapiUrl },
              slug,
              baseUrl: upstream.baseUrl,
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
                },
              ],
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: ConnectionName.make("main"),
              integration: slug,
              template: AuthTemplateSlug.make("apiKey"),
              value: credential.token,
            },
          });
          const session = mcp.session(identity, { mode: "passthrough", artifacts: false });
          const query = { query: "emails", integration: slug, owner: "org", connection: "main" };
          const compact = decodeToolSearch(
            (yield* session.call("search", query)).raw,
          ).structuredContent;
          expect(compact.items.length, "compact-search returns email matches").toBeGreaterThan(0);
          for (const tool of compact.items) {
            expect(
              tool.inputSchema,
              "compact-search omits full schemas by default",
            ).toBeUndefined();
          }
          const send = compact.items.find((tool) => tool.id.endsWith(".emails.send"));
          if (!send) return yield* Effect.die("compact-search omitted the emails.send hit");
          for (const field of ["body", "from", "to", "subject", "text"]) {
            expect(send.arguments, `compact-search summarizes the ${field} argument`).toMatch(
              new RegExp(`\\b${field}\\b`),
            );
          }
          const subject = `fork-compact-${randomBytes(8).toString("hex")}`;
          const email = {
            from: "sender@example.com",
            to: ["recipient@example.com"],
            subject,
            text: "Sent using the compact-search argument summary",
          };
          const invoked = yield* session.call("invoke", {
            tool: send.id,
            arguments: { body: email },
          });
          expect(invoked.ok, invoked.text).toBe(true);
          const ledger = yield* Effect.promise(() => upstream.ledger.list());
          const sends = ledger.filter(
            (entry) =>
              entry.operationId === "emails.send" &&
              Option.exists(
                decodeEmailSubject(entry.request.body),
                (body) => body.subject === subject,
              ),
          );
          expect(
            sends,
            "compact-search sends exactly one email with the unique subject",
          ).toHaveLength(1);
          expect(
            sends[0]?.request.body,
            "compact-search sends the summarized arguments",
          ).toMatchObject(email);
          expect(sends[0]?.response.status, "compact-search invoke authenticates upstream").toBe(
            200,
          );
          const invalid = yield* session.call("invoke", {
            tool: send.id,
            arguments: { body: { wrong: 1 } },
          });
          expect(invalid.ok, "compact-search refuses invalid invoke arguments").toBe(false);
          expect(invalid.text, "compact-search returns the schema after invalid invoke").toContain(
            "Expected inputSchema",
          );
          expect(
            decodeInputSchema(invalid.text.split("Expected inputSchema:")[1]),
            "compact-search schema names the subject field",
          ).toHaveProperty("properties.body.properties.subject");
          expect(
            (yield* Effect.promise(() => upstream.ledger.list())).length,
            "compact-search invalid invoke does not reach upstream",
          ).toBe(ledger.length);
          const full = decodeToolSearch(
            (yield* session.call("search", { ...query, detail: "full" })).raw,
          ).structuredContent;
          expect(
            JSON.stringify(full.items.find((tool) => tool.id === send.id)?.inputSchema),
            "compact-search restores the schema for detail full",
          ).toContain("subject");
          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the integration list for the recording", async () => {
              await visit(page, "/integrations");
              await page.getByText(slug, { exact: true }).first().waitFor();
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
              yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
            }),
          ),
        );
      }),
    ),
  ),
);

scenario(
  "Fork lean-guidance · the search guide recommends a scoped three-hit search",
  {},
  withForkFeatures(
    ["lean-guidance"],
    Effect.scoped(
      Effect.gen(function* () {
        const mcp = yield* Mcp;
        const browser = yield* Browser;
        const identity = yield* freshForkIdentity;
        const session = mcp.session(identity, { mode: "passthrough", artifacts: false });
        const guide = yield* session.call("skills", { name: "search-invoke" });
        expect(guide.text, "lean-guidance recommends a small integration-scoped search").toContain(
          "prefer `limit: 3` with an `integration` filter",
        );
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the MCP connection page for the recording", async () => {
            await visit(page, "/");
            await page.getByRole("button", { name: "Advanced" }).waitFor();
          });
        });
      }),
    ),
  ),
);
