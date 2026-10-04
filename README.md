# Agent Control Panel SDK

Connect an AI agent that already runs in your app to [Agent Control Panel](https://acp.skaigroup.tech)
(ACP): report every run (tokens, model, latency, errors) and let your team **pause, resume, stop, restart,
swap the model or push an approved prompt** without redeploying.

**Docs:** [acp.skaigroup.tech/docs](https://acp.skaigroup.tech/docs) · [Quickstart](https://acp.skaigroup.tech/docs/get-started/quickstart) · [What is an AI agent control panel?](https://acp.skaigroup.tech/guides/ai-agent-control-panel)

- **Fail-open.** If ACP is slow or down, your agent keeps working. Reporting is buffered and retried in the
  background; nothing the SDK does throws into your code.
- **Signed control.** Commands are HMAC-SHA256 signed with a timestamp and a single-use nonce; unsigned,
  replayed, stale or wrong-agent commands are rejected.
- **Durable pause and model swaps.** A pause or a model swap set in ACP survives restarts, extra replicas and
  missed webhooks: every heartbeat reply carries the state ACP holds, and the client adopts it. The client
  reports its model on the next heartbeat, which is how ACP confirms the swap.
- **Zero runtime dependencies.** Node 18+, ESM and CommonJS, TypeScript types included.

## Quickstart

```ts
import { createClient } from "agent-control-panel";

const acp = createClient({
  url: process.env.ACP_URL!,               // your control panel URL
  apiKey: process.env.ACP_API_KEY!,        // shown once when the key is created
  agentId: process.env.ACP_AGENT_ID!,      // from the app page in ACP
  webhookSecret: process.env.ACP_WEBHOOK_SECRET!,
});
acp.start(); // heartbeats every 30 s

const answer = await acp.wrapAgentRun(() => llm.chat(messages), {
  userInput: userQuestion,   // what the end user asked
  fullInput: messages,       // everything sent to the model
  modelUsed: acp.getEffectiveModel("gpt-4o-mini") ?? "gpt-4o-mini",
});
```

`wrapAgentRun` records duration, success/error, token usage and the answer text, read automatically from OpenAI
(Chat Completions and Responses), Anthropic (including prompt-cache tokens), Google Gemini and Vercel AI SDK
results; for anything else pass tokens and `fullOutput` to `reportRun` yourself. ACP's quality reviews, Test Lab
and error explanations read the user input, full input and output, so pass them for accurate results (each field
is kept up to 100,000 characters). To send metadata only, create the client with `captureContent: false`. While the agent is paused or stopped it throws `AgentPausedError` **without calling your
function**, so a pause really stops model calls.

### Receive control commands (Express)

Mount the handler **before** any global `express.json()`: signatures are checked on the raw body.

```ts
app.post("/api/acp/webhook", acp.expressWebhookHandler());
```

Set your app's **Deployed URL** in ACP; commands are sent to `<Deployed URL>/api/acp/webhook`. Other frameworks:
read the raw body yourself and call `acp.handleWebhook(headers, rawBody)`, answering 200 when `ok` is true, 409
for `reason: "wrong_agent"`, and 401 otherwise.

No public URL (local dev, a worker, a cron job)? Control still works: pause/stop/resume and model swaps
arrive with the next heartbeat (within 30 s); prompt changes are fetched before each run.

## API

| Member | What it does |
|---|---|
| `createClient(options)` | `url`, `apiKey`, `agentId`, `webhookSecret` (required); `webhookSecretPrev` during rotation; `heartbeatMs` (30000), `flushMs` (5000), `flushAt` (50), `maxBuffer` (200); `logger`; `disableControl`; `captureContent` (default `true`; `false` = metadata only); `fetch` (for tests). `url` must be https (or http to localhost). |
| `start()` / `stop()` | Start heartbeats and background flushing / flush everything and stop. The timers never keep your process alive on their own, and pending runs are flushed when Node is about to exit; call `stop()` on shutdown to be sure every run is sent. |
| `wrapAgentRun(fn, { userInput?, fullInput?, inputSummary?, modelUsed? })` | Run `fn`, report it (with the answer text from the result), rethrow its error unchanged. Throws `AgentPausedError` while paused or stopped. |
| `extractText(result)` | The answer text of an OpenAI, Anthropic, Gemini or Vercel AI SDK result, or `null`. |
| `reportRun(input)` | Report a run yourself (status, tokens, model, timings, summaries, `userInput`, `fullInput`, `fullOutput`, optional `dedupeKey`). Buffered, never throws. |
| `fetchPrompt()` | The agent's current prompt from ACP (composed with its skills), cached; falls back to the cache on any error. |
| `getEffectiveModel(fallback)` | The model ACP asked for (after a model swap), else `fallback`. |
| `status` | `idle`, `running`, `paused`, `stopped`, … |
| `handleWebhook(headers, rawBody)` / `expressWebhookHandler()` | Verify and apply a signed command. |
| `applyCommand(command)` | Apply a command locally (e.g. your own kill switch). A pause set this way is never lifted by ACP. |

## Security

- Never commit `ACP_API_KEY` or `ACP_WEBHOOK_SECRET`; keep them in your platform's secrets.
- `ACP_DISABLE_CONTROL=1` (or `disableControl: true`) ignores every control command while reporting keeps
  working: a local kill switch that does not depend on ACP.
- Rotate the webhook secret in ACP, then set the old one as `webhookSecretPrev` until every instance has the
  new one.
- Commands are accepted only within 5 minutes of their timestamp and only once (nonce cache).
- Run content (user input, full input, the answer) is sent to ACP by default, cut to 100,000 characters per
  field. Leave out anything you must not share, or use `captureContent: false` for metadata only.
- Redirects are never followed: requests carry the API key, so a redirect is logged (with its target) and
  the request fails open. Update `url` if ACP moves.

## Troubleshooting

| Log line | Meaning | Fix |
|---|---|---|
| `-> 401: ACP rejected the API key` | The key is wrong, revoked or expired. The dashboard shows only the key's first characters, never the full key. | Rotate the key on the app page, copy the full key from the dialog, set `ACP_API_KEY`. |
| `webhook REJECTED: bad_signature` | `ACP_WEBHOOK_SECRET` differs from the app's secret in ACP. | Reveal the secret on the app page and set it again. |
| `control rejected: command for agent … reached agent …` | Several agents share one webhook URL but this client is configured for another agent. | One client (and `agentId`) per agent. |

## Development

```bash
npm ci
npm test
npm run build
```

The SDK is developed in the Agent Control Panel repository, next to the server it talks to, so contract
changes are tested on both sides together. This public repository receives one commit per release. Issues and
pull requests are welcome here; accepted changes are applied upstream and ship in the next release.

## License

[Apache License 2.0](LICENSE). It includes an explicit patent grant from contributors, and ends that grant for
anyone who sues over patents in the SDK.
