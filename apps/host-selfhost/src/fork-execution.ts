import { forkFeaturesOff, type ForkFeatures } from "@executor-js/sdk/core";
import { Effect, Layer } from "effect";
import { withForkCodeExecutor } from "@executor-js/execution";
import {
  CodeExecutorProvider,
  EngineDecorator,
  type EngineDecoratorShape,
  HostConfig,
  PluginsProvider,
} from "@executor-js/api/server";
import executorConfig from "../executor.config";
import { selfHostAnalytics, SelfHostAnalyticsEngineDecorator } from "./analytics";
import { SelfHostDbProvider } from "./db/self-host-db";
import { loadConfig } from "./config";
import { SelfHostCodeExecutorProvider } from "./execution";
import { withForkInventoryDescription } from "./fork-inventory-decorator";
export const makeSelfHostPluginsProvider = (
  forkFeatures: ForkFeatures = forkFeaturesOff,
): Layer.Layer<PluginsProvider> =>
  Layer.succeed(PluginsProvider)({
    plugins: (context) =>
      executorConfig.plugins({
        forkFeatures,
        activeToolkitSlug:
          context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
      }),
  });

export const makeSelfHostHostConfig = (
  forkFeatures: ForkFeatures = forkFeaturesOff,
): Layer.Layer<HostConfig> =>
  Layer.sync(HostConfig, () => {
    const config = loadConfig();
    return {
      forkFeatures,
      allowLocalNetwork: config.allowLocalNetwork,
      webBaseUrl: config.webBaseUrl,
      oauthCallbackPath: "/api/oauth/callback",
      toolsSyncTtlMs: config.toolsSyncTtlMs,
      onIntegrationChange: (event) =>
        selfHostAnalytics.record(
          event.kind === "added" ? "integration_added" : "integration_removed",
          { plugin_key: event.pluginKey },
        ),
    };
  });

export const makeSelfHostEngineDecorator = (forkFeatures: ForkFeatures = forkFeaturesOff) =>
  Layer.effect(EngineDecorator)(
    Effect.map(
      EngineDecorator.asEffect(),
      ({ decorate }): EngineDecoratorShape => ({
        decorate: (engine, identity, context) =>
          decorate(withForkInventoryDescription(engine, context, forkFeatures), identity, context),
      }),
    ).pipe(Effect.provide(SelfHostAnalyticsEngineDecorator)),
  );

export const makeSelfHostCodeExecutorProvider = (forkFeatures: ForkFeatures = forkFeaturesOff) =>
  Layer.effect(CodeExecutorProvider)(
    Effect.map(CodeExecutorProvider.asEffect(), (codeExecutor) =>
      withForkCodeExecutor(codeExecutor, { forkFeatures }),
    ).pipe(Effect.provide(SelfHostCodeExecutorProvider)),
  );

export const makeSelfHostExecutionStackLayer = (forkFeatures: ForkFeatures = forkFeaturesOff) =>
  Layer.mergeAll(
    SelfHostDbProvider,
    makeSelfHostPluginsProvider(forkFeatures),
    makeSelfHostHostConfig(forkFeatures),
    makeSelfHostCodeExecutorProvider(forkFeatures),
    makeSelfHostEngineDecorator(forkFeatures),
  );
