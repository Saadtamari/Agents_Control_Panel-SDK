export type TokenUsage = {
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const has = (o: Record<string, unknown>, ...keys: string[]) => keys.some((k) => typeof o[k] === "number");

function usage(tokensInput: number, tokensOutput: number, total?: unknown): TokenUsage {
  return { tokensInput, tokensOutput, tokensTotal: num(total) || tokensInput + tokensOutput };
}

/**
 * Extract token counts from the response shapes of common LLM clients. Returns null when the result carries
 * no recognisable usage (then report tokens yourself with reportRun).
 *
 * - OpenAI Chat Completions: usage.prompt_tokens / completion_tokens / total_tokens
 * - OpenAI Responses API and Anthropic Messages: usage.input_tokens / output_tokens; Anthropic's prompt-cache
 *   tokens (cache_creation_input_tokens, cache_read_input_tokens) are counted as input, because
 *   input_tokens excludes them
 * - Google Gemini: usageMetadata (or response.usageMetadata) promptTokenCount / candidatesTokenCount
 * - Vercel AI SDK: usage.inputTokens / outputTokens (v5) or usage.promptTokens / completionTokens (v4)
 */
export function extractTokens(result: unknown): TokenUsage | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  const u = r.usage as Record<string, unknown> | undefined;
  if (u && typeof u === "object") {
    if (has(u, "prompt_tokens", "completion_tokens")) {
      return usage(num(u.prompt_tokens), num(u.completion_tokens), u.total_tokens);
    }
    if (has(u, "input_tokens", "output_tokens")) {
      const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
      return usage(input, num(u.output_tokens), u.total_tokens);
    }
    if (has(u, "inputTokens", "outputTokens")) {
      return usage(num(u.inputTokens), num(u.outputTokens), u.totalTokens);
    }
    if (has(u, "promptTokens", "completionTokens")) {
      return usage(num(u.promptTokens), num(u.completionTokens), u.totalTokens);
    }
  }

  const response = r.response as Record<string, unknown> | undefined;
  const meta = (r.usageMetadata ?? (response && typeof response === "object" ? response.usageMetadata : undefined)) as
    | Record<string, unknown>
    | undefined;
  if (meta && typeof meta === "object" && has(meta, "promptTokenCount", "candidatesTokenCount")) {
    return usage(num(meta.promptTokenCount), num(meta.candidatesTokenCount), meta.totalTokenCount);
  }

  return null;
}
