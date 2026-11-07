# Changelog

All notable changes to the SDK. Versions stay `0.x` until the wire contract is proven with real customers;
after the first public release, contract changes are additive only (clients live inside customer apps).

## 0.3.3 — 2026-11-07

- **A pause now holds across restarts.** A restarted process starts `idle` until ACP's first heartbeat reply, and
  `wrapAgentRun` used to run straight away: a paused agent ran once after every restart or deploy (seen on our
  own demo agent). After `start()`, the first `wrapAgentRun` now waits for that reply, at most `startupWaitMs`
  (new option, default 3000; 0 turns it off). Fail-open: if ACP does not answer in time the run goes ahead, and
  later runs never wait. No wait with `disableControl`, or when `start()` was not called.

## 0.3.2 — 2026-11-03

- **Package metadata only; no code changes.** The website moved to https://agentcontrolpanel.si: the npm page
  (`homepage`) and the README now link https://agentcontrolpanel.si/docs. The old links redirect there. The API
  host your app reports to is unchanged.

## 0.3.1 — 2026-10-03

- **Package metadata only; no code changes.** The npm page links the documentation (`homepage`:
  https://acp.skaigroup.tech/docs), the description says what the SDK does, more search keywords, and the README
  links the docs and the quickstart.

## 0.3.0 — 2026-09-29

- **Runs now include their content.** `wrapAgentRun` reports the answer text (read from OpenAI, Anthropic,
  Gemini and Vercel AI SDK results by the new `extractText`) and accepts `userInput` and `fullInput`. Until now it
  sent no output at all, so ACP's quality reviews and Test Lab had nothing to judge for SDK-wrapped runs.
- **`captureContent: false`** sends metadata only (status, tokens, timings, model, errors), from `wrapAgentRun`
  and `reportRun` alike. Default `true`.
- **Content is cut to what ACP stores** (100,000 characters per full field, flagged as truncated) and a large
  flush is split into requests under 4 MB, so a batch of long runs is never rejected as a whole.
- **Redirects are never followed.** Requests carry the API key; a 3xx is logged with its target and fails open.

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
