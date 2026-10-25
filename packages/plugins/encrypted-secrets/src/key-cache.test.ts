import { strict as assert } from "node:assert";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: Vitest hoists vi.mock only with a direct vitest import
import { vi } from "vitest";
import { scryptSync } from "node:crypto";
import { ProviderItemId, createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import {
  deriveKey,
  decryptSecret,
  encryptSecret,
  encryptedSecretsPlugin,
  type EncryptedSecretsPluginConfig,
} from "./index";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, scryptSync: vi.fn(actual.scryptSync) };
});
afterEach(() => vi.mocked(scryptSync).mockClear());
type ProviderFactory = Extract<
  NonNullable<ReturnType<typeof encryptedSecretsPlugin>["credentialProviders"]>,
  (...args: never[]) => unknown
>;
const bindProvider = (
  plugin: ReturnType<typeof encryptedSecretsPlugin>,
  ctx: Parameters<ProviderFactory>[0],
) => {
  const source = plugin.credentialProviders;
  const resolved = typeof source === "function" ? source(ctx) : (source ?? []);
  return (Effect.isEffect(resolved) ? resolved : Effect.succeed(resolved)).pipe(
    Effect.map((providers) => {
      const provider = providers[0];
      assert.ok(provider);
      return provider;
    }),
  );
};
const boundPlugin = (options: EncryptedSecretsPluginConfig) => {
  const base = encryptedSecretsPlugin(options);
  return definePlugin(() => ({
    ...base,
    extension: (ctx) => ({
      provider: () => bindProvider(base, ctx),
      providerFor: (key: string) =>
        bindProvider(
          encryptedSecretsPlugin({ key, reuseDerivedKey: options.reuseDerivedKey }),
          ctx,
        ),
    }),
  }))();
};

describe("selected key derivation cache", () => {
  it("derives once and replaces the entry on every key change", () => {
    for (const key of ["cache-a", "cache-a"])
      encryptedSecretsPlugin({ key, reuseDerivedKey: true });
    expect(scryptSync).toHaveBeenCalledTimes(1);
    for (const key of ["cache-b", "cache-b"])
      encryptedSecretsPlugin({ key, reuseDerivedKey: true });
    expect(scryptSync).toHaveBeenCalledTimes(2);
    encryptedSecretsPlugin({ key: "cache-a", reuseDerivedKey: true });
    expect(scryptSync).toHaveBeenCalledTimes(3);
    expect(() => encryptedSecretsPlugin({ key: "", reuseDerivedKey: true })).toThrow(/non-empty/);
    expect(scryptSync).toHaveBeenCalledTimes(3);
  });
  it("preserves per-factory derivation when disabled or omitted", () => {
    encryptedSecretsPlugin({ key: "off-key" });
    encryptedSecretsPlugin({ key: "off-key", reuseDerivedKey: false });
    expect(scryptSync).toHaveBeenCalledTimes(2);
  });
  it.effect("binds fresh providers to separate executor storage and owners", () =>
    Effect.gen(function* () {
      const a = yield* createExecutor(
        makeTestConfig({
          tenant: "scope-a",
          subject: "alice",
          plugins: [boundPlugin({ key: "scope-key", reuseDerivedKey: true })] as const,
        }),
      );
      const b = yield* createExecutor(
        makeTestConfig({
          tenant: "scope-b",
          subject: null,
          plugins: [boundPlugin({ key: "scope-key", reuseDerivedKey: true })] as const,
        }),
      );
      yield* Effect.addFinalizer(() => a.close().pipe(Effect.andThen(b.close()), Effect.ignore));
      expect(scryptSync).toHaveBeenCalledTimes(1);
      const left = yield* a.encryptedSecrets.provider();
      const right = yield* b.encryptedSecrets.provider();
      expect(left).not.toBe(right);
      const id = ProviderItemId.make("shared-id");
      yield* left.set!(id, "alice-value");
      expect(yield* right.get(id)).toBeNull();
      yield* right.set!(id, "org-value");
      expect(yield* left.get(id)).toBe("alice-value");
      expect(yield* right.get(id)).toBe("org-value");
    }).pipe(Effect.scoped),
  );
  it.effect("keeps existing providers valid after key rotation", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [boundPlugin({ key: "rotation-old", reuseDerivedKey: true })] as const,
        }),
      );
      yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));
      const old = yield* executor.encryptedSecrets.provider();
      const next = yield* executor.encryptedSecrets.providerFor("rotation-new");
      const id = ProviderItemId.make("rotation");
      yield* old.set!(id, "old-value");
      expect(yield* old.get(id)).toBe("old-value");
      expect(Exit.isFailure(yield* Effect.exit(next.get(id)))).toBe(true);
      yield* next.set!(id, "new-value");
      expect(yield* next.get(id)).toBe("new-value");
      expect(Exit.isFailure(yield* Effect.exit(old.get(id)))).toBe(true);
      const payload = yield* encryptSecret(deriveKey("rotation-old"), "legacy");
      expect(yield* decryptSecret(deriveKey("rotation-old"), payload)).toBe("legacy");
    }).pipe(Effect.scoped),
  );
});
