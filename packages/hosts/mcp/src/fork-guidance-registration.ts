import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getObjectShape } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { forkFeaturesOff, type ForkFeatures } from "@executor-js/sdk/core";
import { z } from "zod/v4";
import { mcpGuidanceText } from "./fork-guidance";
import { isGuidanceKey, type GuidanceMode } from "./fork-guidance-types";

export const mcpGuidanceRegistrar = (
  server: McpServer,
  mode: GuidanceMode,
  features: ForkFeatures = forkFeaturesOff,
): Pick<McpServer, "registerTool"> => {
  if (mode === "codemode") return server;
  const registerTool: McpServer["registerTool"] = (name, config, callback) => {
    const tool = server.registerTool(name, config, callback);
    if (
      config.inputSchema !== undefined &&
      !Object.values(config.inputSchema).every((schema) => schema instanceof z.ZodType)
    )
      return tool;
    const descriptionKey = `${name}.description`;
    if (isGuidanceKey(descriptionKey) && tool.description !== undefined) {
      const description = mcpGuidanceText(features, descriptionKey, tool.description);
      if (description !== tool.description) tool.update({ description });
    }
    const shape = getObjectShape(tool.inputSchema);
    if (shape !== undefined) {
      const entries = Object.entries(shape).map(([field, schema]) => {
        const key = `${name}.${field}`;
        if (
          !isGuidanceKey(key) ||
          !(schema instanceof z.ZodType) ||
          schema.description === undefined
        )
          return [field, schema] as const;
        const description = mcpGuidanceText(features, key, schema.description);
        return [
          field,
          description === schema.description ? schema : schema.describe(description),
        ] as const;
      });
      if (entries.some(([field, schema]) => schema !== shape[field])) {
        tool.update({ paramsSchema: Object.fromEntries(entries) });
      }
    }
    return tool;
  };
  return { registerTool };
};
