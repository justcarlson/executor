import type { ForkFeatures } from "@executor-js/sdk/core";
import type { Skill } from "./skills";

export const EXECUTE_WORKFLOW_START_ANCHOR = /1\. `const \{ items: matches \}/;
export const EXECUTE_RULES_ANCHOR = "## Rules";
export const EXECUTE_WORKFLOW_ANCHOR = new RegExp(
  `${EXECUTE_WORKFLOW_START_ANCHOR.source}[\\s\\S]*?(?=${EXECUTE_RULES_ANCHOR})`,
);

export const LEAN_EXECUTE_SKILL_NAME = "execute";

export const forkExecuteSkill = (skill: Skill, features: ForkFeatures): Skill =>
  skill.name !== LEAN_EXECUTE_SKILL_NAME
    ? skill
    : {
        ...skill,
        body: skill.body.replace(
          EXECUTE_WORKFLOW_ANCHOR,
          [
            '1. `const { items: matches } = await tools.search({ query: "<intent + key nouns>", namespace: "<integration slug or alias>", limit: 3 });` — omit `namespace` when the integration is unknown.',
            '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
            "3. Only when the argument shape is unknown: `const details = await tools.describe.tool({ path });` and use `details.inputTypeScript` / `details.outputTypeScript` and `details.typeScriptDefinitions` for compact shapes.",
            "4. For live saved-connection inventory, call `tools.executor.coreTools.connections.list({})`; after checking `result.ok`, read `result.data.connections`.",
            "5. Call the tool: `const result = await tools[path](input);`",
            "",
          ]
            .join("\n")
            .replace(
              "integration slug or alias",
              features.has("integration-aliases")
                ? "integration slug or alias"
                : "integration slug",
            ) + "\n",
        ),
      };
