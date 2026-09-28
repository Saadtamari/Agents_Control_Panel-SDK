# Changelog

All notable changes to the SDK. Versions stay `0.x` until the wire contract is proven with real customers;
after the first public release, contract changes are additive only (clients live inside customer apps).

## 0.2.0 — 2026-09-28

- **Published as `agent-control-panel`** (was the unpublished placeholder `@acp/sdk`), licensed Apache-2.0.
- **Durable pause.** Heartbeat replies carry the status ACP holds; the client adopts a pause/stop set in ACP
  and releases it on resume, so control survives restarts, replicas and missed webhooks. A pause set
  locally with `applyCommand` is never lifted by ACP; replies older than the last applied command are ignored.
- **Model swaps without a webhook.** Heartbeat replies may carry `model`, the model ACP wants this agent to
  run; the client adopts it (unless the app set its own with `applyCommand`) and sends `model` in its next
  heartbeat, which confirms the swap in ACP. A missing `model` changes nothing.
- **More LLM clients for token counts.** `extractTokens` / `wrapAgentRun` read the OpenAI Responses API,
  Google Gemini (`usageMetadata`) and the Vercel AI SDK (v4 and v5); Anthropic prompt-cache tokens are now
  counted as input (they were missed).
- **Never keeps your process alive.** Heartbeat and flush timers are `unref`'d, so a script or cron job
  that forgets `stop()` still exits; pending runs are flushed on `beforeExit`.
- **No lost counts or runs.** Runs reported while a heartbeat is in flight are counted in the next one (they
  were reset to zero); `stop()` waits for an in-flight flush and then sends what was reported meanwhile.
- **Pushed prompts keep their skills.** A prompt pushed by webhook no longer replaces the composed prompt
  (base + skills) for up to a minute: the next `fetchPrompt()` pulls the composed one, and the version is
  ACP's instead of a local guess.
- **Clearer prompt-fetch errors; trimmed agent id.** A rejected key during prompt fetch is logged (the cache
  is still used); whitespace around `agentId` is trimmed like the key and secrets.
- **Wrong-agent commands rejected.** A signed command whose `agent_id` is not this client's `agentId` is
  refused (`reason: "wrong_agent"`, HTTP 409 from `expressWebhookHandler`) and changes nothing.
- **Credentials trimmed.** Whitespace or a newline pasted around `apiKey` / `webhookSecret` no longer breaks
  authentication.
- **Clearer logs.** A 401 explains that the API key was rejected and how to fix it; a rejected agent id is
  sanitised before logging.
- Prompt fetch works with the keys the dashboard creates (server-side fix: those keys lacked the `prompt`
  scope).

## 0.1.1

- Fail-open buffered reporting with retries and a capped buffer; `wrapAgentRun`, `reportRun`,
  `fetchPrompt`, `getEffectiveModel`.
- Signed webhook commands (HMAC-SHA256 over timestamp + nonce, 5-minute window, replay protection),
  previous-secret support during rotation, `ACP_DISABLE_CONTROL` kill switch.
