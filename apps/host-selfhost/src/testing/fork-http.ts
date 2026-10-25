import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@effect/vitest";
import { createEmulator } from "@executor-js/emulate";
import type { ForkFeatures } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";

const decodePort = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));
const decodeToken = Schema.decodeUnknownSync(Schema.String);
export const decodeExecution = Schema.decodeUnknownSync(
  Schema.Struct({
    status: Schema.String,
    text: Schema.String,
    structured: Schema.Struct({
      status: Schema.String,
      result: Schema.Unknown,
      toolName: Schema.optional(Schema.String),
      toolCalls: Schema.optional(
        Schema.Array(Schema.Struct({ path: Schema.String, status: Schema.String })),
      ),
      toolPaths: Schema.optional(Schema.Array(Schema.String)),
      emitted: Schema.optional(Schema.Number),
      logs: Schema.Array(Schema.String),
    }),
    isError: Schema.Boolean,
    output: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
);

export const httpImageExecution = (forkFeatures: ForkFeatures) =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "executor-http-fork-"));
    const environment = {
      EXECUTOR_DATA_DIR: directory,
      BETTER_AUTH_SECRET: "http-execution-test-secret-0123456789-abcdefghij",
      EXECUTOR_BOOTSTRAP_ADMIN_EMAIL: "admin@http-execution.test",
      EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD: "http-execution-test-password",
      EXECUTOR_ALLOW_LOCAL_NETWORK: "true",
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Object.entries(environment).map(([key, value]) => {
          const saved = process.env[key];
          process.env[key] = value;
          return { key, saved };
        });
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          for (const { key, saved } of previous) {
            if (saved === undefined) delete process.env[key];
            else process.env[key] = saved;
          }
        }),
    );
    const port = yield* Effect.promise(async () => {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = decodePort(reservation.address());
      await promisify(reservation.close.bind(reservation))();
      return address.port;
    });
    const emulator = yield* Effect.acquireRelease(
      Effect.promise(() => createEmulator({ service: "mcp", port })),
      (instance) => Effect.promise(() => instance.close()),
    );
    const providerBaseUrl = emulator.url;
    yield* Effect.promise(() => emulator.seed({ auth: "bearer" }));
    const credential = yield* Effect.promise(() =>
      emulator.credentials.mint({ type: "bearer-token" }),
    );
    const { makeSelfHostApp } = yield* Effect.promise(() => import("../app"));
    const app = yield* Effect.acquireRelease(
      Effect.promise(() =>
        makeSelfHostApp({ forkFeatures, dbPath: join(directory, "executor.db") }),
      ),
      (app) => Effect.promise(() => app.closeDb()),
    );
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => app.toWebHandler()),
      (web) => Effect.promise(() => web.dispose()),
    );
    const request = (path: string, body: unknown, token?: string) =>
      Effect.promise(() =>
        web.handler(
          new Request(`http://localhost:4788/api/${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
          }),
        ),
      );
    const signIn = yield* request("auth/sign-in/email", {
      email: "admin@http-execution.test",
      password: "http-execution-test-password",
    });
    expect(signIn.status).toBe(200);
    const token = decodeToken(signIn.headers.get("set-auth-token"));
    expect(token).toBeTruthy();
    const added = yield* request(
      "mcp/servers",
      {
        transport: "remote",
        name: "HTTP image fixture",
        slug: "http_images",
        endpoint: `${providerBaseUrl}/mcp`,
        remoteTransport: "streamable-http",
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
      token,
    );
    expect(added.status, yield* Effect.promise(() => added.text())).toBe(200);
    const connected = yield* request(
      "connections",
      {
        owner: "org",
        integration: "http_images",
        name: "main",
        template: "apiKey",
        value: credential.token,
      },
      token,
    );
    expect(connected.status, yield* Effect.promise(() => connected.text())).toBe(200);
    const executed = yield* request(
      "executions",
      { code: "return await tools.http_images.org.main.get_test_image({});" },
      token,
    );
    expect(executed.status).toBe(200);
    return decodeExecution(yield* Effect.promise(() => executed.json()));
  }).pipe(Effect.scoped);
