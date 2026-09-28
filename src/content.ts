/** What ACP stores per full input/output field (server: ACP_MAX_FULL_CHARS). Longer values are cut and flagged. */
export const MAX_FULL_CHARS = 100_000;
/** What ACP stores per summary field (server: input_summary / output_summary). */
export const MAX_SUMMARY_CHARS = 2_000;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function joinText(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const texts = parts
    .map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? str((p as { text?: unknown }).text) : null))
    .filter((t): t is string => t !== null);
  return texts.length ? texts.join("") : null;
}

/**
 * The answer text of a common LLM client response, or null when the shape is not recognised (then pass
 * `fullOutput` yourself with reportRun). Only reads plain properties; never calls methods on the result.
 *
 * - a string result is the text itself
 * - OpenAI Chat Completions: choices[0].message.content (string or text parts)
 * - OpenAI Responses API: output_text
 * - Anthropic Messages: content[] text blocks
 * - Google Gemini: candidates[0].content.parts[].text (or response.candidates…)
 * - Vercel AI SDK: text
 */
export function extractText(result: unknown): string | null {
  if (typeof result === "string") return result.length > 0 ? result : null;
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  const outputText = str(r.output_text);
  if (outputText) return outputText;

  if (Array.isArray(r.choices) && r.choices.length > 0) {
    const message = (r.choices[0] as { message?: { content?: unknown } } | null)?.message;
    const content = message?.content;
    const text = str(content) ?? joinText(content);
    if (text) return text;
  }

  if (Array.isArray(r.content)) {
    const blocks = r.content.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text");
    const text = joinText(blocks);
    if (text) return text;
  }

  const response = r.response && typeof r.response === "object" ? (r.response as Record<string, unknown>) : null;
  const candidates = Array.isArray(r.candidates) ? r.candidates : Array.isArray(response?.candidates) ? response.candidates : null;
  if (candidates && candidates.length > 0) {
    const parts = (candidates[0] as { content?: { parts?: unknown } } | null)?.content?.parts;
    const text = joinText(parts);
    if (text) return text;
  }

  return str(r.text);
}

/** Serialize for a full-content field and cut it to ACP's limit. Unserializable values are left out. */
export function clampFull(value: unknown): { value: string | undefined; truncated: boolean } {
  if (value == null) return { value: undefined, truncated: false };
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return { value: undefined, truncated: false };
  }
  if (typeof text !== "string") return { value: undefined, truncated: false };
  return text.length > MAX_FULL_CHARS
    ? { value: text.slice(0, MAX_FULL_CHARS), truncated: true }
    : { value: text, truncated: false };
}

export function clampSummary(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  return value.length > MAX_SUMMARY_CHARS ? value.slice(0, MAX_SUMMARY_CHARS) : value;
}
