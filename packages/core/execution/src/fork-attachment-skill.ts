import type { Skill } from "./skills";

export const ATTACHMENT_FILE_ANCHOR = "- File-returning tools";

export const ATTACHMENT_RETURN_ANCHOR = "- `return` is only";

export const ATTACHMENT_PROVIDER_ANCHOR = "- Some providers";

export const ATTACHMENT_EXECUTE_SKILL_NAME = "execute";

export const withAttachmentInstructions = (skill: Skill): Skill =>
  skill.name !== ATTACHMENT_EXECUTE_SKILL_NAME
    ? skill
    : {
        ...skill,
        body: skill.body
          .split("\n")
          .map((line) => {
            if (line.startsWith(ATTACHMENT_FILE_ANCHOR))
              return '- File-returning tools may return `ToolFile` values: `{ _tag: "ToolFile", name?, mimeType, encoding: "base64", data, byteLength }`. A "file-returning tool" includes APIs that return file bytes inside a JSON field, such as Base64-encoded `content`; wrap those payloads in a `ToolFile` and `emit()` them. Attachments are delivered automatically; no download or `emit()` is needed.';
            if (line.startsWith(ATTACHMENT_RETURN_ANCHOR))
              return "- Successful tool results containing `ToolFile` values or native MCP image, audio, or embedded binary resources are delivered automatically. Returned previews contain compact metadata instead of file bytes. Explicit `emit()` remains supported and attachments are deduplicated. A bare base64 string is ordinary data.";
            if (line.startsWith(ATTACHMENT_PROVIDER_ANCHOR))
              return "- Some providers, including Gmail, return attachment bytes as a `ToolFile` with no public URL to hand off — the bytes themselves are the payload. Executor delivers the attachment automatically; pass its base64 `data` as another tool's `bodyBase64` to forward it.";
            return line;
          })
          .join("\n"),
      };
