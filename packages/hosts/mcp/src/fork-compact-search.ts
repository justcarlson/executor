import type { Skill } from "@executor-js/execution";

export const COMPACT_DESCRIPTION_LIMIT = 200;
export const COMPACT_ARGUMENT_LIMIT = 12;
const COMPACT_ENUM_LIMIT = 6;
const COMPACT_NESTED_KEY_LIMIT = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const compactDescription = (description: string | undefined): string => {
  if (description === undefined) return "";
  const firstLine = description.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  const sentence = collapsed.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? collapsed;
  const kept = sentence.length >= 12 || sentence.length === collapsed.length ? sentence : collapsed;
  return kept.length <= COMPACT_DESCRIPTION_LIMIT
    ? kept
    : `${kept.slice(0, COMPACT_DESCRIPTION_LIMIT - 1).trimEnd()}…`;
};

const resolveRef = (
  node: Record<string, unknown>,
  defs: ReadonlyMap<string, unknown>,
): Record<string, unknown> => {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const name = ref.replace(/^#\/(\$defs|definitions)\//, "");
  const target = defs.get(name);
  return isRecord(target) ? target : node;
};

const typeLabel = (value: unknown, defs: ReadonlyMap<string, unknown>, depth = 0): string => {
  if (!isRecord(value)) return "any";
  const node = resolveRef(value, defs);
  if (Array.isArray(node.enum)) {
    const values = node.enum.map((item) => String(item));
    return values.length <= COMPACT_ENUM_LIMIT
      ? values.join("|")
      : `${values.slice(0, COMPACT_ENUM_LIMIT).join("|")}|…`;
  }
  if (node.const !== undefined) return JSON.stringify(node.const);
  const variants = [node.oneOf, node.anyOf].find(Array.isArray);
  if (variants && depth < 1) {
    const labels = [
      ...new Set(variants.map((variant: unknown) => typeLabel(variant, defs, depth + 1))),
    ];
    return labels.length <= 3 ? labels.join("|") : "any";
  }
  const type = Array.isArray(node.type)
    ? node.type.filter((item) => item !== "null").join("|")
    : typeof node.type === "string"
      ? node.type
      : undefined;
  if (type === "array") {
    const items = depth < 1 ? typeLabel(node.items, defs, depth + 1) : "any";
    return items.includes("|") ? `(${items})[]` : `${items}[]`;
  }
  if (type === "object" || (type === undefined && isRecord(node.properties)))
    return objectLabel(node, depth);
  return type ?? "any";
};

const objectLabel = (node: Record<string, unknown>, depth: number): string => {
  if (depth >= 1 || !isRecord(node.properties)) return "object";
  const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
  const names = Object.keys(node.properties);
  if (names.length === 0) return "object";
  const shown = names
    .slice(0, COMPACT_NESTED_KEY_LIMIT)
    .map((name) => (required.has(name) ? `${name}*` : name));
  const rest = names.length - shown.length;
  return `object{${shown.join(", ")}${rest > 0 ? `, +${rest}` : ""}}`;
};

export const compactArguments = (
  inputSchema: unknown,
  definitions?: Record<string, unknown>,
): string => {
  if (!isRecord(inputSchema)) return "none";
  const defs = new Map<string, unknown>([
    ...Object.entries(definitions ?? {}),
    ...Object.entries(isRecord(inputSchema.definitions) ? inputSchema.definitions : {}),
    ...Object.entries(isRecord(inputSchema.$defs) ? inputSchema.$defs : {}),
  ]);
  const schema = resolveRef(inputSchema, defs);
  const properties = schema.properties;
  if (!isRecord(properties)) {
    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf))
      return "see full schema";
    return "none";
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const names = Object.keys(properties);
  if (names.length === 0) return "none";
  const ordered = [
    ...names.filter((name) => required.has(name)),
    ...names.filter((name) => !required.has(name)),
  ];
  const shown = ordered.slice(0, COMPACT_ARGUMENT_LIMIT).map((name) => {
    const label = typeLabel(properties[name], defs);
    return required.has(name) ? `${name} (${label}, required)` : `${name} (${label})`;
  });
  const rest = ordered.length - shown.length;
  return rest > 0 ? `${shown.join("; ")}; +${rest} more` : shown.join("; ");
};

export const COMPACT_SEARCH_DESCRIPTION =
  "Search connected integration tools by action, integration, or account. Each hit has the tool ID, account details, a one-line description, and an argument summary (name, type, required). Pass the returned ID and arguments to invoke. Set detail to full for 1-3 hits when you need the complete JSON input schema. Use integrations to discover accounts, then pass exact integration, owner, and connection filters. Use nextOffset to page through matches.";

export const COMPACT_SEARCH_READ_ANCHOR = "3. Read";

export const compactSearchSkill = (skill: Skill): Skill => ({
  ...skill,
  body: skill.body
    .split("\n")
    .map((line) => {
      if (line.startsWith(COMPACT_SEARCH_READ_ANCHOR))
        return '3. Read the hit\'s `arguments` summary (`name (type, required); other (type)`). Call `invoke({ tool: <exact returned id>, arguments: <JSON object> })`. Do not guess tool IDs or arguments. When the summary is not enough, repeat the search with `detail: "full"` and `limit: 1` to get the complete `inputSchema`; an invoke rejected for invalid arguments also returns the schema.';
      return line;
    })
    .join("\n"),
});

export const COMPACT_SEARCH_DETAIL =
  "compact (default): one-line description plus an argument summary per hit. full: the complete JSON inputSchema per hit; use with a small limit.";
