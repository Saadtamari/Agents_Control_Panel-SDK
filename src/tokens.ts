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
 * - OpenAI Agents SDK run result: runContext.usage (every model call of the run)
 * - LangGraph state ({ messages }): the sum of each AI message's usage_metadata (every model call of the run);
 *   a single LangChain message: its usage_metadata
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

  // OpenAI Agents SDK: the run's usage adds up every model call (tool call turns included).
  const runContext = r.runContext as Record<string, unknown> | undefined;
  if (runContext && typeof runContext === "object" && runContext.usage && typeof runContext.usage === "object") {
    const found = extractTokens({ usage: runContext.usage });
    if (found) return found;
  }

  // LangChain: usage_metadata { input_tokens, output_tokens, total_tokens } on each AI message.
  const single = langchainUsage(r.usage_metadata);
  if (single) return single;
  if (Array.isArray(r.messages)) {
    let input = 0, output = 0, total = 0, seen = false;
    for (const m of r.messages) {
      const u = m && typeof m === "object" ? langchainUsage((m as Record<string, unknown>).usage_metadata) : null;
      if (!u) continue;
      seen = true;
      input += u.tokensInput;
      output += u.tokensOutput;
      total += u.tokensTotal;
    }
    if (seen) return { tokensInput: input, tokensOutput: output, tokensTotal: total };
  }

  return null;
}

function langchainUsage(meta: unknown): TokenUsage | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  return has(m, "input_tokens", "output_tokens") ? usage(num(m.input_tokens), num(m.output_tokens), m.total_tokens) : null;
}
