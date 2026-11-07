import { randomUUID } from "node:crypto";
import { AgentPausedError, type AgentStatus } from "./errors.js";
import { NonceCache, verifySignature } from "./signature.js";
import { extractTokens } from "./tokens.js";
import { clampFull, clampSummary, extractText } from "./content.js";

export type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type CreateClientOptions = {
  url: string;
  apiKey: string;
  agentId: string;
  webhookSecret: string;
  /** Previous secret during rotation (optional). */
  webhookSecretPrev?: string | null;
  heartbeatMs?: number;
  flushMs?: number;
  /** Max runs buffered before forced flush. Default 50. */
  flushAt?: number;
  /** Absolute buffer cap; excess dropped. Default 200. */
  maxBuffer?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  disableControl?: boolean;
  /**
   * DEV ONLY. Allow a plain `http:` control-panel URL for a non-loopback host.
   * The API key is sent on every request, so never enable this in production.
   * Loopback hosts (localhost, 127.0.0.1, ::1) are always allowed over http.
   */
  allowInsecureHttp?: boolean;
  /**
   * Send run content (user input, full input, the answer text) with each run. Default true: quality reviews,
   * Test Lab and error explanations need it. `false` sends metadata only (status, tokens, timings, model,
   * errors), whatever `reportRun` or `wrapAgentRun` is given.
   */
  captureContent?: boolean;
  /**
   * After `start()`, the first `wrapAgentRun` waits up to this long (ms) for ACP's first heartbeat reply, so a
   * pause or stop set in ACP holds across restarts and deploys. Default 3000. If ACP does not answer in time the
   * run goes ahead (fail-open), and later runs never wait. 0 turns the wait off.
   */
  startupWaitMs?: number;
};

const DEFAULT_STARTUP_WAIT_MS = 3_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Throws unless `url` is https, or http to a loopback host, or http with the explicit dev opt-out. */
export function assertSecureUrl(url: string, allowInsecureHttp = false): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`createClient: url is not a valid URL: ${url}`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol !== "http:") {
    throw new Error(`createClient: url must use https: (got ${parsed.protocol})`);
  }
  if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return;
  if (allowInsecureHttp) return;
  throw new Error(
    `createClient: refusing insecure http:// url for host "${parsed.hostname}" — the API key would be sent in cleartext. ` +
      "Use https://, or set allowInsecureHttp: true for local development only.",
  );
}

export type ReportRunInput = {
  status: "success" | "error" | string;
  inputSummary?: string;
  outputSummary?: string;
  errorMessage?: string | null;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  executionTimeMs?: number;
  modelUsed?: string;
  promptVersion?: number;
  compositionHash?: string;
  trigger?: string;
  userInput?: string;
  fullInput?: unknown;
  fullOutput?: unknown;
  dedupeKey?: string;
};

type BufferedRun = ReportRunInput & {
  dedupe_key: string;
  agent_id: string;
  fullInputTruncated?: boolean;
  fullOutputTruncated?: boolean;
};

const DEFAULT_FLUSH_MS = 5000;
const DEFAULT_FLUSH_AT = 50;
const DEFAULT_MAX_BUFFER = 200;
const MAX_RETRIES = 4;
/** Keep each report request well under the ingest body limit (10 MB) by splitting large batches. */
const MAX_BATCH_BYTES = 4_000_000;

/** Split rows into consecutive groups whose JSON stays under `maxBytes` (a single larger row goes alone). */
function chunkBySize<T>(rows: T[], maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitterBackoff(attempt: number): number {
  const base = Math.min(8000, 250 * 2 ** attempt);
  return base + Math.floor(Math.random() * base * 0.5);
}

export class AcpClient {
  readonly url: string;
  readonly apiKey: string;
  readonly agentId: string;
  readonly webhookSecret: string;
  readonly webhookSecretPrev: string | null;
  readonly disableControl: boolean;
  readonly captureContent: boolean;

  private heartbeatMs: number;
  private flushMs: number;
  private flushAt: number;
  private maxBuffer: number;
  private fetchImpl: typeof fetch;
  private logger: Logger;

  private _status: AgentStatus = "idle";
  /** Who set the current pause/stop: ACP (webhook or heartbeat) or this app calling applyCommand. */
  private holdOrigin: "acp" | "local" | null = null;
  /** Bumped on every applied control command; heartbeat replies older than the last command are ignored. */
  private commandSeq = 0;
  private modelOverride: string | null = null;
  /** Who set the model override: ACP (webhook or heartbeat) or this app calling applyCommand. */
  private modelOrigin: "acp" | "local" | null = null;
  private cachedPrompt: { prompt: string; version: number; compositionHash?: string } | null = null;
  private promptCacheAt = 0;

  private buffer: BufferedRun[] = [];
  private dropped = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private started = false;
  private startupWaitMs: number;
  /** The first heartbeat sent by start(); runs wait for it (bounded) once, then it is cleared. */
  private firstHeartbeat: Promise<void> | null = null;
  private nonceCache = new NonceCache();
  private runsSinceLast = 0;
  private tokensSinceLast = 0;
  private errorsSinceLast = 0;
  private beforeExitHandler: (() => void) | null = null;

  constructor(opts: CreateClientOptions) {
    if (!opts.url) throw new Error("createClient: url is required");
    assertSecureUrl(opts.url, opts.allowInsecureHttp === true);
    if (!opts.apiKey) throw new Error("createClient: apiKey is required");
    if (!opts.agentId) throw new Error("createClient: agentId is required");
    if (!opts.webhookSecret) {
      throw new Error(
        "createClient: webhookSecret is required (refusing to accept unsigned control commands)",
      );
    }

    this.url = opts.url.replace(/\/$/, "");
    // Credentials never contain whitespace; trim what env files and dashboards often add.
    this.apiKey = opts.apiKey.trim();
    this.agentId = opts.agentId.trim();
    this.webhookSecret = opts.webhookSecret.trim();
    this.webhookSecretPrev = opts.webhookSecretPrev?.trim() || null;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    this.flushAt = opts.flushAt ?? DEFAULT_FLUSH_AT;
    this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger ?? {
      warn: (...a) => console.warn("[acp]", ...a),
      error: (...a) => console.error("[acp]", ...a),
    };
    this.disableControl =
      opts.disableControl === true || process.env.ACP_DISABLE_CONTROL === "1";
    this.captureContent = opts.captureContent !== false;
    this.startupWaitMs = Math.max(0, opts.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS);
  }

  get status(): AgentStatus {
    return this._status;
  }

  getEffectiveModel(fallback?: string): string | null {
    return this.modelOverride ?? fallback ?? null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.firstHeartbeat = this.heartbeat();
    // unref(): the client's timers must never keep a script, cron job or worker alive on their own;
    // pending runs are still flushed on "beforeExit" (and by stop()).
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushMs);
    this.flushTimer.unref?.();
    this.beforeExitHandler = () => {
      void this.flush();
    };
    process.once("beforeExit", this.beforeExitHandler);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.heartbeatTimer = null;
    this.flushTimer = null;
    if (this.beforeExitHandler) {
      process.off("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = null;
    }
    this.started = false;
    // A flush already in flight took only the runs buffered when it began; flush the rest after it.
    if (this.flushing) await this.flushing;
    await this.flush();
  }

  /** Fail-open POST. Never throws. */
  private async post(path: string, body: unknown): Promise<boolean> {
    return (await this.postWithResponse(path, body)).ok;
  }

  /**
   * A redirect is never followed: the request carries the API key (in the body or a header), and a 307/308
   * would resend it to wherever the redirect points. Log where ACP moved so the url can be updated.
   */
  private redirectWarning(what: string, res: Response): string | null {
    const redirected = (res.status >= 300 && res.status < 400) || res.type === "opaqueredirect";
    if (!redirected) return null;
    const location = typeof res.headers?.get === "function" ? res.headers.get("location") : null;
    return `${what} -> ${res.status} redirect${location ? ` to ${location}` : ""}: not followed (the API key is never sent to another address). Update the ACP url.`;
  }

  /** Fail-open POST that also returns the parsed JSON body (null if absent or invalid). Never throws. */
  private async postWithResponse(path: string, body: unknown): Promise<{ ok: boolean; json: unknown }> {
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.logger.warn?.(
          this.redirectWarning(path, res) ??
            (res.status === 401
              ? `${path} -> 401: ACP rejected the API key. Check ACP_API_KEY is the full key shown once when it was created (not revoked); create a new key on the app page if unsure.`
              : `${path} -> ${res.status}`),
        );
        return { ok: false, json: null };
      }
      let json: unknown = null;
      try {
        json = typeof res.json === "function" ? await res.json() : null;
      } catch {
        json = null;
      }
      return { ok: true, json };
    } catch (err) {
      this.logger.warn?.(
        `${path} failed (continuing anyway):`,
        err instanceof Error ? err.message : err,
      );
      return { ok: false, json: null };
    }
  }

  /**
   * Converge on the status ACP holds for this agent (from the heartbeat reply), so a pause survives a
   * process restart, another replica, or a webhook that never arrived. Only paused/stopped holds move:
   * ACP's hold is adopted, and a hold that ACP set is released once ACP no longer holds it (a resume).
   * A hold set locally through applyCommand is never released by the server.
   * `model` (when present) is the model ACP wants: adopted unless this app set its own through
   * applyCommand, and reported back on the next heartbeat, which confirms the swap in ACP. A missing
   * model is "no instruction" and never clears an override.
   */
  private adoptControlState(json: unknown, seqAtSend: number): void {
    if (this.disableControl || seqAtSend !== this.commandSeq) return;
    const entry = (json as { control?: { agents?: Record<string, unknown> } } | null)?.control?.agents?.[this.agentId];
    const model = (entry as { model?: unknown } | undefined)?.model;
    if (typeof model === "string" && model && model.length <= 120 && this.modelOrigin !== "local" && model !== this.modelOverride) {
      this.modelOverride = model;
      this.modelOrigin = "acp";
      this.logger.info?.(`model from ACP: ${model}`);
    }
    const status = (entry as { status?: unknown } | undefined)?.status;
    if (typeof status !== "string") return;
    const serverHolds = status === "paused" || status === "stopped";
    if (serverHolds) {
      if (this.holdOrigin === "local" || this._status === status) return;
      this._status = status;
      this.holdOrigin = "acp";
      this.logger.info?.(`control state from ACP: ${status}`);
    } else if (this.holdOrigin === "acp") {
      this._status = "idle";
      this.holdOrigin = null;
      this.logger.info?.("control state from ACP: released");
    }
  }

  /**
   * A process that restarts starts "idle" until ACP's first heartbeat reply says otherwise, so without this a
   * paused agent ran once after every restart. Bounded by startupWaitMs and fail-open (the heartbeat never
   * throws); only the first run(s) after start() wait.
   */
  private async awaitStartupControlState(): Promise<void> {
    const first = this.firstHeartbeat;
    if (!first || this.disableControl || this.startupWaitMs === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.startupWaitMs);
      timer.unref?.();
    });
    await Promise.race([first, timeout]);
    clearTimeout(timer);
    this.firstHeartbeat = null;
  }

  private async heartbeat(): Promise<void> {
    const seqAtSend = this.commandSeq;
    // Counters sent in this heartbeat; runs reported while it is in flight stay for the next one.
    const sent = { runs: this.runsSinceLast, tokens: this.tokensSinceLast, errors: this.errorsSinceLast };
    const { ok, json } = await this.postWithResponse("/api/heartbeat", {
      api_key: this.apiKey,
      agents: [
        {
          agent_id: this.agentId,
          status: this._status,
          runs_since_last: sent.runs,
          tokens_since_last: sent.tokens,
          errors_since_last: sent.errors,
          // The model override in effect, so ACP can confirm a model swap; omitted when there is none.
          ...(this.modelOverride ? { model: this.modelOverride } : {}),
        },
      ],
    });
    if (ok) {
      this.runsSinceLast -= sent.runs;
      this.tokensSinceLast -= sent.tokens;
      this.errorsSinceLast -= sent.errors;
      this.adoptControlState(json, seqAtSend);
    }
  }

  reportRun(input: ReportRunInput): void {
    try {
      const dedupe_key = input.dedupeKey || randomUUID().replace(/-/g, "").slice(0, 32);
      if (this.buffer.length >= this.maxBuffer) {
        this.buffer.shift();
        this.dropped += 1;
        this.logger.warn?.(`report buffer full; dropped oldest (total dropped=${this.dropped})`);
      }
      // Content is cut to what ACP stores (and flagged) now, so the buffer and each request stay bounded.
      const fullIn = this.captureContent ? clampFull(input.fullInput) : { value: undefined, truncated: false };
      const fullOut = this.captureContent ? clampFull(input.fullOutput) : { value: undefined, truncated: false };
      this.buffer.push({
        ...input,
        userInput: this.captureContent ? input.userInput : undefined,
        inputSummary: this.captureContent ? input.inputSummary : undefined,
        outputSummary: this.captureContent ? input.outputSummary : undefined,
        fullInput: fullIn.value,
        fullOutput: fullOut.value,
        fullInputTruncated: fullIn.truncated,
        fullOutputTruncated: fullOut.truncated,
        promptVersion: input.promptVersion ?? this.cachedPrompt?.version,
        compositionHash: input.compositionHash ?? this.cachedPrompt?.compositionHash,
        agent_id: this.agentId,
        dedupe_key,
      });
      this.runsSinceLast += 1;
      this.tokensSinceLast += input.tokensTotal || (input.tokensInput || 0) + (input.tokensOutput || 0);
      if (input.status === "error") this.errorsSinceLast += 1;
      if (this.buffer.length >= this.flushAt) void this.flush();
    } catch (err) {
      this.logger.warn?.("reportRun failed (fail-open):", err);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = this.sendBuffered().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async sendBuffered(): Promise<void> {
    const batch = this.buffer.splice(0, this.buffer.length);
    let pending = batch.length;
    try {
      const rows = batch.map((r) => ({
        agent_id: r.agent_id,
        dedupe_key: r.dedupe_key,
        status: r.status,
        input_summary: r.inputSummary,
        output_summary: r.outputSummary,
        error_message: r.errorMessage,
        tokens_input: r.tokensInput || 0,
        tokens_output: r.tokensOutput || 0,
        tokens_total: r.tokensTotal || (r.tokensInput || 0) + (r.tokensOutput || 0),
        execution_time_ms: r.executionTimeMs,
        model_used: r.modelUsed,
        prompt_version: r.promptVersion,
        composition_hash: r.compositionHash,
        trigger: r.trigger,
        user_input: r.userInput,
        full_input: r.fullInput,
        full_output: r.fullOutput,
        ...(r.fullInputTruncated ? { full_input_truncated: true } : {}),
        ...(r.fullOutputTruncated ? { full_output_truncated: true } : {}),
      }));
      for (const chunk of chunkBySize(rows, MAX_BATCH_BYTES)) {
        await this.sendChunk(chunk);
        pending -= chunk.length;
      }
    } catch (err) {
      this.dropped += pending;
      this.logger.warn?.("flush error (fail-open, dropped batch):", err);
    }
  }

  /** One report request with retries; a chunk that still fails is dropped (fail-open). */
  private async sendChunk(runs: unknown[]): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (await this.post("/api/report", { api_key: this.apiKey, runs })) return;
      if (attempt < MAX_RETRIES) await sleep(jitterBackoff(attempt));
    }
    this.dropped += runs.length;
    this.logger.warn?.(`flush failed after retries; dropping ${runs.length} runs (total dropped=${this.dropped})`);
  }

  /**
   * Fetch the composed system prompt (+ compositionHash). Returns the prompt string
   * for backward compatibility; use getCachedCompositionHash() for the hash.
   */
  async fetchPrompt(): Promise<string> {
    const now = Date.now();
    if (this.cachedPrompt && now - this.promptCacheAt < 60_000) {
      return this.cachedPrompt.prompt;
    }
    try {
      const res = await this.fetchImpl(`${this.url}/api/prompts/${this.agentId}`, {
        headers: { "x-api-key": this.apiKey },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        this.logger.warn?.(
          this.redirectWarning("prompt fetch", res) ??
            (res.status === 401
              ? "prompt fetch -> 401: ACP rejected the API key (using the cached prompt). Check ACP_API_KEY."
              : `prompt fetch -> ${res.status} (using the cached prompt)`),
        );
        return this.cachedPrompt?.prompt || "";
      }
      const data = (await res.json()) as {
        prompt?: string;
        version?: number;
        compositionHash?: string;
      };
      if (typeof data.prompt === "string") {
        this.cachedPrompt = {
          prompt: data.prompt,
          version: data.version || 1,
          compositionHash: data.compositionHash,
        };
        this.promptCacheAt = now;
        return data.prompt;
      }
    } catch (err) {
      this.logger.warn?.("fetchPrompt failed (using cache):", err);
    }
    return this.cachedPrompt?.prompt || "";
  }

  getCachedCompositionHash(): string | undefined {
    return this.cachedPrompt?.compositionHash;
  }

  getCachedPromptVersion(): number | undefined {
    return this.cachedPrompt?.version;
  }

  /**
   * Run `fn`, report it, and return its result (or rethrow its error unchanged). The answer text is read from
   * common LLM client responses (see `extractText`) and reported as the run's output, so quality reviews and
   * Test Lab can judge it. Pass `userInput` (the end user's request) and `fullInput` (what was sent to the
   * model, e.g. the messages array) for complete context. Nothing is reported as content when the client was
   * created with `captureContent: false`.
   */
  async wrapAgentRun<T>(
    fn: () => Promise<T>,
    opts?: { inputSummary?: string; userInput?: string; fullInput?: unknown; modelUsed?: string },
  ): Promise<T> {
    await this.awaitStartupControlState();
    if (this._status === "paused" || this._status === "stopped") {
      throw new AgentPausedError(this._status);
    }

    const started = Date.now();
    const prev = this._status;
    this._status = "running";
    const common = {
      inputSummary: opts?.inputSummary,
      userInput: opts?.userInput,
      fullInput: opts?.fullInput,
    };
    try {
      const result = await fn();
      const tokens = extractTokens(result);
      const text = this.captureContent ? extractText(result) : null;
      this.reportRun({
        ...common,
        status: "success",
        outputSummary: clampSummary(text),
        fullOutput: text ?? undefined,
        tokensInput: tokens?.tokensInput,
        tokensOutput: tokens?.tokensOutput,
        tokensTotal: tokens?.tokensTotal,
        executionTimeMs: Date.now() - started,
        modelUsed: opts?.modelUsed || this.modelOverride || undefined,
      });
      if (this._status === "running") this._status = prev === "running" ? "idle" : prev;
      return result;
    } catch (err) {
      this.reportRun({
        ...common,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        executionTimeMs: Date.now() - started,
        modelUsed: opts?.modelUsed || this.modelOverride || undefined,
      });
      if (this._status === "running") this._status = prev === "running" ? "idle" : prev;
      throw err;
    }
  }

  /** Apply a control command locally. A pause/stop set this way is never released by heartbeat sync. */
  applyCommand(command: string, payload?: Record<string, unknown>): string | null {
    return this.applyCommandFrom(command, payload, "local");
  }

  private applyCommandFrom(
    command: string,
    payload: Record<string, unknown> | undefined,
    origin: "acp" | "local",
  ): string | null {
    if (this.disableControl) {
      this.logger.info?.(`control ignored (disableControl): ${command}`);
      return "ignored";
    }
    if (command !== "ping" && command !== "verify") this.commandSeq += 1;
    switch (command) {
      case "pause":
        this._status = "paused";
        this.holdOrigin = origin;
        return "paused";
      case "resume":
        this._status = "idle";
        this.holdOrigin = null;
        return "resumed";
      case "stop":
        this._status = "stopped";
        this.holdOrigin = origin;
        return "stopped";
      case "restart":
        this._status = "idle";
        this.holdOrigin = null;
        return "restarted";
      case "update_model":
        if (payload?.model && typeof payload.model === "string") {
          this.modelOverride = payload.model;
          this.modelOrigin = origin;
        }
        return `model now ${this.modelOverride}`;
      case "update_prompt":
        if (payload?.prompt && typeof payload.prompt === "string") {
          // The pushed text lacks the agent's skills (ACP composes them into GET /api/prompts), so it is
          // only the fallback: the cache is marked stale and the next fetchPrompt() pulls the composed
          // prompt. The version is ACP's when it sends one.
          this.cachedPrompt = {
            prompt: payload.prompt,
            version: typeof payload.version === "number" ? payload.version : (this.cachedPrompt?.version || 0) + 1,
          };
          this.promptCacheAt = 0;
        }
        return "prompt updated";
      case "ping":
      case "verify":
        // Handshake / no-op — never touch agent status (invariant 1).
        return "pong";
      default:
        return null;
    }
  }

  handleWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string | Buffer,
  ): { ok: true; result: string | null; status: AgentStatus } | { ok: false; reason: string } {
    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const verified = verifySignature({
      secrets: [this.webhookSecret, this.webhookSecretPrev],
      rawBody: body,
      headers,
      seenNonce: (n) => this.nonceCache.has(n),
    });
    if (!verified.ok) return { ok: false, reason: verified.reason || "bad_signature" };
    if (verified.nonce) this.nonceCache.add(verified.nonce);

    let parsed: { command?: string; agent_id?: unknown; payload?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: "bad_body" };
    }
    // One webhook URL can front several agents; a command addressed to another agent must never
    // change this one. ACP always signs `agent_id` into the body.
    if (parsed.agent_id !== this.agentId) {
      // eslint-disable-next-line no-control-regex
      const claimed = String(parsed.agent_id).replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 80);
      this.logger.warn?.(`control rejected: command for agent ${claimed} reached agent ${this.agentId}`);
      return { ok: false, reason: "wrong_agent" };
    }
    const result = this.applyCommandFrom(String(parsed.command || ""), parsed.payload, "acp");
    return { ok: true, result, status: this._status };
  }

  /**
   * Express middleware that verifies the raw body.
   * Mount WITHOUT express.json() in front — this reads the stream itself.
   * Or use: app.use('/api/acp/webhook', express.json({ verify: (req, _r, buf) => { (req as any).rawBody = buf } }))
   */
  expressWebhookHandler(): (
    req: {
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      rawBody?: Buffer | string;
      on?: (event: string, cb: (chunk: Buffer) => void) => void;
    },
    res: {
      status: (code: number) => { json: (body: unknown) => void };
      json: (body: unknown) => void;
    },
  ) => void {
    return (req, res) => {
      const finish = (raw: string) => {
        const out = this.handleWebhook(req.headers, raw);
        if (!out.ok) {
          res.status(out.reason === "wrong_agent" ? 409 : 401).json({ ok: false, reason: out.reason });
          return;
        }
        res.json({ ok: true, result: out.result, status: out.status });
      };

      if (req.rawBody != null) {
        finish(typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8"));
        return;
      }

      // Prefer raw stream if still available.
      if (typeof req.on === "function" && req.body === undefined) {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
        return;
      }

      // Last resort: re-serialize parsed body (may break if middleware mutated it).
      finish(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
    };
  }
}

export function createClient(opts: CreateClientOptions): AcpClient {
  return new AcpClient(opts);
}
