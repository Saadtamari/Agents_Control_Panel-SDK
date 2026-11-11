import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  AgentPausedError,
  extractTokens,
  extractText,
  MAX_FULL_CHARS,
  signPayload,
  verifySignature,
  NonceCache,
  MAX_SKEW_SECONDS,
} from "../src/index.js";

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; json?: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json ?? {},
    } as Response;
  });
}

describe("createClient construction", () => {
  it("throws when webhookSecret is missing", () => {
    expect(() =>
      createClient({
        url: "http://localhost",
        apiKey: "acp_x",
        agentId: "a1",
        webhookSecret: "",
      }),
    ).toThrow(/webhookSecret/);
  });

  const base = { apiKey: "acp_x", agentId: "a1", webhookSecret: "whsec_x" };

  it("rejects plain http for a non-loopback host", () => {
    expect(() => createClient({ ...base, url: "http://panel.example.com" })).toThrow(/insecure http/);
  });

  it("rejects non-http(s) schemes and invalid urls", () => {
    expect(() => createClient({ ...base, url: "ftp://panel.example.com" })).toThrow(/https/);
    expect(() => createClient({ ...base, url: "not a url" })).toThrow(/valid URL/);
  });

  it("allows https and loopback http", () => {
    expect(() => createClient({ ...base, url: "https://panel.example.com" })).not.toThrow();
    expect(() => createClient({ ...base, url: "http://localhost:5000" })).not.toThrow();
    expect(() => createClient({ ...base, url: "http://127.0.0.1:5000" })).not.toThrow();
    expect(() => createClient({ ...base, url: "http://[::1]:5000" })).not.toThrow();
  });

  it("allows http for other hosts only with the explicit dev opt-out", () => {
    expect(() =>
      createClient({ ...base, url: "http://panel.internal", allowInsecureHttp: true }),
    ).not.toThrow();
  });
});

describe("buffered flush", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches N runs into one request and flushes on stop", async () => {
    const fetchMock = mockFetchSequence([{ ok: true }, { ok: true }]);
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: "whsec_test",
      fetch: fetchMock as any,
      flushMs: 60_000,
      flushAt: 50,
    });

    acp.reportRun({ status: "success", tokensTotal: 1, dedupeKey: "k1xxxxxxxx" });
    acp.reportRun({ status: "success", tokensTotal: 2, dedupeKey: "k2xxxxxxxx" });
    acp.reportRun({ status: "success", tokensTotal: 3, dedupeKey: "k3xxxxxxxx" });

    await acp.stop();

    const reportCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/report"));
    expect(reportCalls.length).toBe(1);
    const body = JSON.parse(String(reportCalls[0][1]?.body));
    expect(body.runs).toHaveLength(3);
    expect(body.runs[0].dedupe_key).toBe("k1xxxxxxxx");
  });

  it("retries with backoff then drops; buffer is capped", async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
    ]);
    const warns: unknown[][] = [];
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: "whsec_test",
      fetch: fetchMock as any,
      maxBuffer: 3,
      flushAt: 100,
      logger: { warn: (...a) => warns.push(a) },
    });

    acp.reportRun({ status: "success", dedupeKey: "a1xxxxxxx1" });
    acp.reportRun({ status: "success", dedupeKey: "a1xxxxxxx2" });
    acp.reportRun({ status: "success", dedupeKey: "a1xxxxxxx3" });
    acp.reportRun({ status: "success", dedupeKey: "a1xxxxxxx4" }); // drops oldest

    expect(warns.some((w) => String(w[0]).includes("buffer full"))).toBe(true);

    await acp.stop();
    expect(warns.some((w) => String(w[0]).includes("dropping"))).toBe(true);
  });

  it("API unreachable never throws into caller code", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: "whsec_test",
      fetch: fetchMock as any,
    });
    expect(() => acp.reportRun({ status: "success", dedupeKey: "n1xxxxxxx1" })).not.toThrow();
    await expect(acp.stop()).resolves.toBeUndefined();
  });
});

describe("wrapAgentRun", () => {
  it("re-throws the user's error unchanged after recording", async () => {
    const fetchMock = mockFetchSequence([{ ok: true }]);
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: "whsec_test",
      fetch: fetchMock as any,
    });
    const err = new Error("llm exploded");
    await expect(
      acp.wrapAgentRun(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    await acp.stop();
    const reportCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/report"));
    expect(reportCalls.length).toBe(1);
    const body = JSON.parse(String(reportCalls[0][1]?.body));
    expect(body.runs[0].status).toBe("error");
  });

  it("paused agent skips execution", async () => {
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: "whsec_test",
      fetch: mockFetchSequence([]) as any,
    });
    acp.applyCommand("pause");
    const fn = vi.fn(async () => "ok");
    await expect(acp.wrapAgentRun(fn)).rejects.toBeInstanceOf(AgentPausedError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("token extraction", () => {
  it("reads OpenAI and Anthropic shapes", () => {
    expect(
      extractTokens({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ).toEqual({ tokensInput: 10, tokensOutput: 5, tokensTotal: 15 });
    expect(extractTokens({ usage: { input_tokens: 3, output_tokens: 7 } })).toEqual({
      tokensInput: 3,
      tokensOutput: 7,
      tokensTotal: 10,
    });
  });
});

describe("agent framework results (wrapped as they are, no adapter)", () => {
  // OpenAI Agents SDK: run() resolves to a RunResult; finalOutput is the answer, runContext.usage adds up the run.
  const agentsRun = {
    finalOutput: "Order 42 ships tomorrow.",
    runContext: { usage: { requests: 2, inputTokens: 50, outputTokens: 13, totalTokens: 63 } },
    newItems: [],
  };
  // LangGraph: graph.invoke() returns the state; AI messages carry usage_metadata; tool messages do not.
  const graphState = {
    messages: [
      { type: "human", content: "Where is order 42?" },
      { type: "ai", content: "", tool_calls: [{ name: "order_status" }], usage_metadata: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } },
      { type: "tool", content: "Order 42 ships tomorrow.", tool_call_id: "c1" },
      { type: "ai", content: "Order 42 ships tomorrow.", usage_metadata: { input_tokens: 30, output_tokens: 8, total_tokens: 38 } },
    ],
  };

  it("OpenAI Agents SDK run result: text and the whole run's tokens", () => {
    expect(extractText(agentsRun)).toBe("Order 42 ships tomorrow.");
    expect(extractTokens(agentsRun)).toEqual({ tokensInput: 50, tokensOutput: 13, tokensTotal: 63 });
    expect(extractText({ finalOutput: { orderId: "42", eta: "tomorrow" }, runContext: {} })).toBe('{"orderId":"42","eta":"tomorrow"}');
  });

  it("LangGraph state: the last AI message's text and the sum over every model call", () => {
    expect(extractText(graphState)).toBe("Order 42 ships tomorrow.");
    expect(extractTokens(graphState)).toEqual({ tokensInput: 50, tokensOutput: 13, tokensTotal: 63 });
  });

  it("a single LangChain message, and content given as parts", () => {
    const msg = { content: [{ type: "text", text: "Hi " }, { type: "text", text: "there" }], usage_metadata: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } };
    expect(extractText({ messages: [msg] })).toBe("Hi there");
    expect(extractText({ content: "plain", usage_metadata: { input_tokens: 1, output_tokens: 1 } })).toBe("plain");
    expect(extractTokens(msg)).toEqual({ tokensInput: 4, tokensOutput: 2, tokensTotal: 6 });
  });

  it("does not misread unrelated objects", () => {
    expect(extractText({ messages: [] })).toBeNull();
    expect(extractTokens({ messages: [{ type: "human", content: "x" }] })).toBeNull();
    expect(extractText({ content: "no usage metadata here" })).toBeNull();
  });
});

describe("webhook verification", () => {
  const secret = "whsec_current";
  const prev = "whsec_prev";

  it("valid passes; replayed nonce rejected; skew rejected; bad sig rejected; previous secret accepted", () => {
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: secret,
      webhookSecretPrev: prev,
      fetch: mockFetchSequence([]) as any,
    });

    const body = JSON.stringify({ command: "pause", agent_id: "agent-1", payload: {} });
    const signed = signPayload(secret, body);
    const ok = acp.handleWebhook(signed.headers, body);
    expect(ok.ok).toBe(true);

    const replay = acp.handleWebhook(signed.headers, body);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("replayed_nonce");

    const stale = signPayload(secret, body, {
      timestamp: Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 10,
    });
    const skew = acp.handleWebhook(stale.headers, body);
    expect(skew.ok).toBe(false);

    const bad = signPayload("wrong", body);
    const badSig = acp.handleWebhook(bad.headers, body);
    expect(badSig.ok).toBe(false);

    const acp2 = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: secret,
      webhookSecretPrev: prev,
      fetch: mockFetchSequence([]) as any,
    });
    const withPrev = signPayload(prev, body);
    expect(acp2.handleWebhook(withPrev.headers, body).ok).toBe(true);
  });

  it("a validly signed command for another agent (or with no agent_id) never changes this agent", () => {
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: secret,
      fetch: mockFetchSequence([]) as any,
      logger: {},
    });

    for (const body of [
      JSON.stringify({ command: "pause", agent_id: "agent-2", payload: {} }),
      JSON.stringify({ command: "stop", payload: {} }),
      JSON.stringify({ command: "update_model", agent_id: "agent-2", payload: { model: "other-model" } }),
    ]) {
      const out = acp.handleWebhook(signPayload(secret, body).headers, body);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("wrong_agent");
    }
    expect(acp.status).toBe("idle");

    // The express handler answers 409 so ACP records the command as failed, not applied.
    const handler = acp.expressWebhookHandler();
    const body = JSON.stringify({ command: "pause", agent_id: "agent-2", payload: {} });
    let code = 0;
    handler(
      { headers: signPayload(secret, body).headers, rawBody: body },
      { status: (c: number) => { code = c; return { json: () => {} }; }, json: () => { code = 200; } },
    );
    expect(code).toBe(409);
    expect(acp.status).toBe("idle");

    const mine = JSON.stringify({ command: "pause", agent_id: "agent-1", payload: {} });
    expect(acp.handleWebhook(signPayload(secret, mine).headers, mine)).toMatchObject({ ok: true, status: "paused" });
  });

  it("verifySignature unit: NonceCache + timing path", () => {
    const cache = new NonceCache();
    const body = "{}";
    const signed = signPayload("s", body, { nonce: "n1" });
    const first = verifySignature({
      secrets: ["s"],
      rawBody: body,
      headers: signed.headers,
      seenNonce: (n) => cache.has(n),
    });
    expect(first.ok).toBe(true);
    cache.add(signed.nonce);
    const second = verifySignature({
      secrets: ["s"],
      rawBody: body,
      headers: signed.headers,
      seenNonce: (n) => cache.has(n),
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("replayed_nonce");
  });
});

describe("kill switch", () => {
  it("ACP_DISABLE_CONTROL ignores commands but still reports", async () => {
    const prev = process.env.ACP_DISABLE_CONTROL;
    process.env.ACP_DISABLE_CONTROL = "1";
    try {
      const fetchMock = mockFetchSequence([{ ok: true }]);
      const acp = createClient({
        url: "https://panel.test",
        apiKey: "acp_test",
        agentId: "agent-1",
        webhookSecret: "whsec_test",
        fetch: fetchMock as any,
      });
      expect(acp.applyCommand("pause")).toBe("ignored");
      expect(acp.status).toBe("idle");
      acp.reportRun({ status: "success", dedupeKey: "killswxxxx1" });
      await acp.stop();
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/report"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ACP_DISABLE_CONTROL;
      else process.env.ACP_DISABLE_CONTROL = prev;
    }
  });
});

describe("applyCommand ping", () => {
  it("returns pong without mutating status", () => {
    const client = createClient({
      url: "http://localhost",
      apiKey: "acp_x",
      agentId: "a1",
      webhookSecret: "secret",
    });
    client.applyCommand("pause");
    expect(client.status).toBe("paused");
    expect(client.applyCommand("ping")).toBe("pong");
    expect(client.status).toBe("paused");
  });
});

describe("durable pause: heartbeat control state", () => {
  const secret = "whsec_sync";
  const hb = (status: string, agentId = "agent-1") => ({
    ok: true,
    json: { success: true, timestamp: new Date().toISOString(), control: { agents: { [agentId]: { status } } } },
  });
  const make = (fetchImpl: any, extra: Record<string, unknown> = {}) =>
    createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: secret,
      heartbeatMs: 60_000,
      fetch: fetchImpl,
      logger: {},
      ...extra,
    });
  const signed = (acp: ReturnType<typeof createClient>, command: string) => {
    const body = JSON.stringify({ command, agent_id: "agent-1", payload: {} });
    return acp.handleWebhook(signPayload(secret, body).headers, body);
  };

  it("a fresh process adopts a pause ACP holds, and runs are refused", async () => {
    const acp = make(mockFetchSequence([hb("paused")]));
    acp.start();
    await vi.waitFor(() => expect(acp.status).toBe("paused"));
    const fn = vi.fn(async () => "ok");
    await expect(acp.wrapAgentRun(fn)).rejects.toBeInstanceOf(AgentPausedError);
    expect(fn).not.toHaveBeenCalled();
    await acp.stop();
  });

  // 2026-11-03: a paused agent ran once right after a deploy, because the first run started before the first
  // heartbeat reply arrived. A pause must hold across restarts.
  describe("pause holds across a restart (first run waits for the first heartbeat)", () => {
    const delayed = (reply: ReturnType<typeof hb>, ms: number) =>
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/heartbeat")) await new Promise((r) => setTimeout(r, ms));
        return { ok: reply.ok, status: 200, json: async () => reply.json } as Response;
      });

    it("a run started right after start() is refused when ACP holds a pause", async () => {
      const acp = make(delayed(hb("paused"), 80));
      acp.start();
      const fn = vi.fn(async () => "ok");
      await expect(acp.wrapAgentRun(fn)).rejects.toBeInstanceOf(AgentPausedError);
      expect(fn).not.toHaveBeenCalled();
      await acp.stop();
    });

    it("also holds a stop, for several runs started at once", async () => {
      const acp = make(delayed(hb("stopped"), 50));
      acp.start();
      const fn = vi.fn(async () => "ok");
      const results = await Promise.allSettled([acp.wrapAgentRun(fn), acp.wrapAgentRun(fn), acp.wrapAgentRun(fn)]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect(fn).not.toHaveBeenCalled();
      await acp.stop();
    });

    it("fails open: if ACP does not answer within startupWaitMs the run goes ahead, and later runs do not wait", async () => {
      const never = vi.fn((url: string) =>
        String(url).includes("/api/heartbeat")
          ? new Promise<Response>(() => {})
          : Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response),
      );
      const acp = make(never, { startupWaitMs: 100 });
      acp.start();
      const t0 = Date.now();
      await expect(acp.wrapAgentRun(async () => "first")).resolves.toBe("first");
      const firstWait = Date.now() - t0;
      expect(firstWait).toBeGreaterThanOrEqual(90);
      expect(firstWait).toBeLessThan(1000);
      const t1 = Date.now();
      await expect(acp.wrapAgentRun(async () => "second")).resolves.toBe("second");
      expect(Date.now() - t1).toBeLessThan(50);
      await acp.stop();
    });

    it("does not wait when startupWaitMs is 0, when control is disabled, or when start() was never called", async () => {
      for (const extra of [{ startupWaitMs: 0 }, { disableControl: true }]) {
        const acp = make(delayed(hb("paused"), 300), extra);
        acp.start();
        const t0 = Date.now();
        await expect(acp.wrapAgentRun(async () => "ran")).resolves.toBe("ran");
        expect(Date.now() - t0).toBeLessThan(150);
        await acp.stop();
      }
      const notStarted = make(delayed(hb("paused"), 300));
      await expect(notStarted.wrapAgentRun(async () => "ran")).resolves.toBe("ran");
    });

    it("a running agent is not held up longer than the heartbeat round trip", async () => {
      const acp = make(delayed(hb("running"), 30));
      acp.start();
      const t0 = Date.now();
      await expect(acp.wrapAgentRun(async () => "ok")).resolves.toBe("ok");
      expect(Date.now() - t0).toBeLessThan(500);
      await acp.stop();
    });
  });

  it("adopts stopped, and releases an ACP hold once ACP no longer holds it (resume with no webhook)", async () => {
    const replies = [hb("stopped"), hb("running")];
    let i = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const r = String(url).includes("/api/heartbeat") ? replies[Math.min(i++, replies.length - 1)] : { ok: true, json: {} };
      return { ok: r.ok, status: 200, json: async () => r.json } as Response;
    });
    const acp = make(fetchImpl, { heartbeatMs: 300 });
    // waitFor polls every 50 ms; the second heartbeat (300 ms later) brings the release.
    acp.start();
    await vi.waitFor(() => expect(acp.status).toBe("stopped"));
    await vi.waitFor(() => expect(acp.status).toBe("idle"), { timeout: 2000 });
    await acp.stop();
  });

  it("ignores the reply of a heartbeat sent before a command was applied", async () => {
    let release!: (v: Response) => void;
    const pending = new Promise<Response>((r) => (release = r));
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/api/heartbeat") ? pending : ({ ok: true, status: 200, json: async () => ({}) } as Response),
    );
    const acp = make(fetchImpl);
    signed(acp, "pause");
    acp.start(); // heartbeat in flight; the server computed "paused" before the resume below
    expect(signed(acp, "resume")).toMatchObject({ ok: true, status: "idle" });
    release({ ok: true, status: 200, json: async () => hb("paused").json } as Response);
    await new Promise((r) => setTimeout(r, 20));
    expect(acp.status).toBe("idle");
    await acp.stop();
  });

  it("never releases a pause the app set locally with applyCommand", async () => {
    const acp = make(mockFetchSequence([hb("running")]));
    acp.applyCommand("pause");
    acp.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(acp.status).toBe("paused");
    await acp.stop();
  });

  it("ignores control state when control is disabled, for other agents, and for malformed or failed replies", async () => {
    for (const [reply, extra] of [
      [hb("paused"), { disableControl: true }],
      [hb("paused", "agent-2"), {}],
      [{ ok: true, json: { control: { agents: { "agent-1": { status: 7 } } } } }, {}],
      [{ ok: true, json: "not json" }, {}],
      [{ ok: false, status: 500, json: hb("paused").json }, {}],
    ] as const) {
      const acp = make(mockFetchSequence([reply as any]), extra as any);
      acp.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(acp.status).toBe("idle");
      await acp.stop();
    }
  });
});

describe("model swap through the heartbeat", () => {
  const secret = "whsec_model";
  const hbModel = (model?: unknown) => ({
    ok: true,
    json: { success: true, control: { agents: { "agent-1": { status: "running", ...(model === undefined ? {} : { model }) } } } },
  });
  const make = (fetchImpl: any, extra: Record<string, unknown> = {}) =>
    createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: "agent-1",
      webhookSecret: secret,
      heartbeatMs: 300,
      fetch: fetchImpl,
      logger: {},
      ...extra,
    });
  const heartbeatBodies = (fetchImpl: any) =>
    fetchImpl.mock.calls
      .filter((c: any[]) => String(c[0]).includes("/api/heartbeat"))
      .map((c: any[]) => JSON.parse(c[1].body).agents[0]);

  it("adopts the model ACP holds (no webhook needed) and reports it back to confirm", async () => {
    const fetchImpl = mockFetchSequence([hbModel("gpt-4o-mini"), hbModel("gpt-4o-mini")]);
    const acp = make(fetchImpl);
    acp.start();
    await vi.waitFor(() => expect(acp.getEffectiveModel("gpt-4o")).toBe("gpt-4o-mini"));
    await vi.waitFor(() => expect(heartbeatBodies(fetchImpl).some((b: any) => b.model === "gpt-4o-mini")).toBe(true), { timeout: 2000 });
    expect(heartbeatBodies(fetchImpl)[0].model).toBeUndefined(); // nothing to report before adopting
    await acp.stop();
  });

  it("a missing or malformed model is no instruction and never clears an override", async () => {
    for (const reply of [hbModel(), hbModel(null), hbModel(42), hbModel(""), hbModel("x".repeat(121))]) {
      const acp = make(mockFetchSequence([reply as any]));
      const body = JSON.stringify({ command: "update_model", agent_id: "agent-1", payload: { model: "claude-sonnet" } });
      acp.handleWebhook(signPayload(secret, body).headers, body);
      acp.start();
      await new Promise((r) => setTimeout(r, 30));
      expect(acp.getEffectiveModel("gpt-4o")).toBe("claude-sonnet");
      await acp.stop();
    }
  });

  it("never replaces a model the app set locally, and ignores the model when control is disabled", async () => {
    const local = make(mockFetchSequence([hbModel("gpt-4o-mini")]));
    local.applyCommand("update_model", { model: "my-own-model" });
    local.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(local.getEffectiveModel()).toBe("my-own-model");
    await local.stop();

    const disabled = make(mockFetchSequence([hbModel("gpt-4o-mini")]), { disableControl: true });
    disabled.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(disabled.getEffectiveModel("gpt-4o")).toBe("gpt-4o");
    await disabled.stop();
  });
});

describe("credentials with pasted whitespace", () => {
  it("trims the API key and webhook secrets", async () => {
    const fetchMock = mockFetchSequence([{ ok: true }]);
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "  acp_test\n",
      agentId: "agent-1",
      webhookSecret: "whsec_trim\n",
      webhookSecretPrev: "  ",
      fetch: fetchMock as any,
      logger: {},
    });
    expect(acp.apiKey).toBe("acp_test");
    expect(acp.webhookSecret).toBe("whsec_trim");
    expect(acp.webhookSecretPrev).toBeNull();
    const body = JSON.stringify({ command: "ping", agent_id: "agent-1", payload: {} });
    expect(acp.handleWebhook(signPayload("whsec_trim", body).headers, body).ok).toBe(true);
    await acp.stop();
  });
});

describe("token extraction across LLM clients", () => {
  it("counts Anthropic prompt-cache tokens as input (input_tokens excludes them)", () => {
    expect(
      extractTokens({ usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 5 } }),
    ).toEqual({ tokensInput: 1210, tokensOutput: 5, tokensTotal: 1215 });
  });

  it("reads the OpenAI Responses API, Gemini and the Vercel AI SDK (v4 and v5)", () => {
    expect(extractTokens({ usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } })).toEqual({ tokensInput: 4, tokensOutput: 6, tokensTotal: 10 });
    expect(extractTokens({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 12 } })).toEqual({ tokensInput: 8, tokensOutput: 2, tokensTotal: 12 });
    expect(extractTokens({ response: { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } } })).toEqual({ tokensInput: 3, tokensOutput: 1, tokensTotal: 4 });
    expect(extractTokens({ usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } })).toEqual({ tokensInput: 7, tokensOutput: 3, tokensTotal: 10 });
    expect(extractTokens({ usage: { promptTokens: 2, completionTokens: 2 } })).toEqual({ tokensInput: 2, tokensOutput: 2, tokensTotal: 4 });
  });

  it("returns null for unknown shapes and ignores junk values", () => {
    for (const v of [null, undefined, "text", 42, {}, { usage: {} }, { usage: "x" }, { usageMetadata: {} }]) {
      expect(extractTokens(v)).toBeNull();
    }
    expect(extractTokens({ usage: { prompt_tokens: -5, completion_tokens: Number.NaN } })).toEqual({ tokensInput: 0, tokensOutput: 0, tokensTotal: 0 });
  });
});

describe("release hardening", () => {
  const secret = "whsec_hard";
  const ok = (json: unknown = {}) => ({ ok: true, status: 200, json: async () => json }) as Response;

  it("timers never keep the process alive on their own", async () => {
    const acp = createClient({ url: "https://panel.test", apiKey: "acp_t", agentId: "a", webhookSecret: secret, fetch: vi.fn(async () => ok()) as any, logger: {} });
    acp.start();
    const timers = acp as unknown as { heartbeatTimer: { hasRef(): boolean }; flushTimer: { hasRef(): boolean } };
    expect(timers.heartbeatTimer.hasRef()).toBe(false);
    expect(timers.flushTimer.hasRef()).toBe(false);
    await acp.stop();
  });

  it("runs reported while a heartbeat is in flight are counted in the next heartbeat", async () => {
    let release!: (r: Response) => void;
    const bodies: any[] = [];
    let first = true;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (String(url).includes("/api/heartbeat")) {
        bodies.push(JSON.parse(init.body).agents[0]);
        if (first) {
          first = false;
          return new Promise<Response>((r) => (release = r));
        }
      }
      return ok();
    });
    const acp = createClient({ url: "https://panel.test", apiKey: "acp_t", agentId: "a", webhookSecret: secret, heartbeatMs: 60_000, flushAt: 1000, fetch: fetchImpl as any, logger: {} });
    acp.reportRun({ status: "success", tokensTotal: 10 });
    acp.start(); // heartbeat 1 carries 1 run / 10 tokens and hangs
    acp.reportRun({ status: "error", tokensTotal: 5 }); // reported during the in-flight heartbeat
    release(ok());
    await new Promise((r) => setTimeout(r, 10));
    await (acp as any).heartbeat();
    expect(bodies[0]).toMatchObject({ runs_since_last: 1, tokens_since_last: 10, errors_since_last: 0 });
    expect(bodies[1]).toMatchObject({ runs_since_last: 1, tokens_since_last: 5, errors_since_last: 1 });
    await acp.stop();
  });

  it("stop() also sends runs reported while a flush was already in flight", async () => {
    let release!: (r: Response) => void;
    const reported: string[] = [];
    let first = true;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (String(url).includes("/api/report")) {
        reported.push(...JSON.parse(init.body).runs.map((r: any) => r.dedupe_key));
        if (first) {
          first = false;
          return new Promise<Response>((r) => (release = r));
        }
      }
      return ok();
    });
    const acp = createClient({ url: "https://panel.test", apiKey: "acp_t", agentId: "a", webhookSecret: secret, fetch: fetchImpl as any, logger: {} });
    acp.reportRun({ status: "success", dedupeKey: "run-one-aaaa" });
    void acp.flush(); // in flight
    acp.reportRun({ status: "success", dedupeKey: "run-two-bbbb" });
    const stopping = acp.stop();
    release(ok());
    await stopping;
    expect(reported).toEqual(["run-one-aaaa", "run-two-bbbb"]);
  });

  it("a pushed prompt uses ACP's version and the next fetch pulls the composed prompt (with skills)", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/api/prompts/") ? ok({ prompt: "base + skills", version: 7, compositionHash: "h7" }) : ok(),
    );
    const acp = createClient({ url: "https://panel.test", apiKey: "acp_t", agentId: "a", webhookSecret: secret, fetch: fetchImpl as any, logger: {} });
    const body = JSON.stringify({ command: "update_prompt", agent_id: "a", payload: { prompt: "base", version: 7 } });
    expect(acp.handleWebhook(signPayload(secret, body).headers, body).ok).toBe(true);
    expect(acp.getCachedPromptVersion()).toBe(7);
    expect(await acp.fetchPrompt()).toBe("base + skills");
    expect(acp.getCachedCompositionHash()).toBe("h7");
    await acp.stop();
  });

  it("a rejected prompt fetch is logged and falls back to the cache; agent ids are trimmed", async () => {
    const warn = vi.fn();
    const acp = createClient({
      url: "https://panel.test", apiKey: "acp_t", agentId: " a \n", webhookSecret: secret,
      fetch: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response) as any, logger: { warn },
    });
    expect(acp.agentId).toBe("a");
    expect(await acp.fetchPrompt()).toBe("");
    expect(warn.mock.calls[0][0]).toMatch(/401/);
    await acp.stop();
  });
});

describe("run content (0.3.0)", () => {
  const base = { url: "https://panel.test", apiKey: "acp_test", agentId: "agent-1", webhookSecret: "whsec_test" };
  const reportBodies = (fetchMock: ReturnType<typeof mockFetchSequence>) =>
    fetchMock.mock.calls
      .filter((c) => String(c[0]).includes("/api/report"))
      .map((c) => JSON.parse(String(c[1]?.body)) as { runs: Array<Record<string, unknown>> });

  it("wrapAgentRun reports the answer text, the user input and the full input", async () => {
    const fetchMock = mockFetchSequence([{ ok: true }]);
    const acp = createClient({ ...base, fetch: fetchMock as any });
    const messages = [{ role: "user", content: "What is 2+2?" }];
    await acp.wrapAgentRun(
      async () => ({
        choices: [{ message: { role: "assistant", content: "4" } }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
      { userInput: "What is 2+2?", fullInput: messages, modelUsed: "gpt-4o" },
    );
    await acp.stop();
    const run = reportBodies(fetchMock)[0].runs[0];
    expect(run).toMatchObject({
      status: "success",
      user_input: "What is 2+2?",
      full_input: JSON.stringify(messages),
      full_output: "4",
      output_summary: "4",
      tokens_total: 11,
      model_used: "gpt-4o",
    });
  });

  it("an error run keeps its input, and the error is rethrown unchanged", async () => {
    const fetchMock = mockFetchSequence([{ ok: true }]);
    const acp = createClient({ ...base, fetch: fetchMock as any });
    const err = new Error("boom");
    await expect(acp.wrapAgentRun(async () => { throw err; }, { userInput: "hi", fullInput: "prompt" })).rejects.toBe(err);
    await acp.stop();
    expect(reportBodies(fetchMock)[0].runs[0]).toMatchObject({ status: "error", user_input: "hi", full_input: "prompt", error_message: "boom" });
  });

  it("captureContent: false reports metadata only, even from reportRun", async () => {
    const fetchMock = mockFetchSequence([{ ok: true }]);
    const acp = createClient({ ...base, fetch: fetchMock as any, captureContent: false });
    await acp.wrapAgentRun(async () => "secret answer", { userInput: "secret question", fullInput: "secret prompt" });
    acp.reportRun({ status: "success", inputSummary: "s", outputSummary: "o", userInput: "u", fullInput: "i", fullOutput: "x", tokensTotal: 3 });
    await acp.stop();
    const runs = reportBodies(fetchMock)[0].runs;
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      for (const key of ["user_input", "input_summary", "output_summary", "full_input", "full_output"]) {
        expect(run[key]).toBeUndefined();
      }
    }
    expect(JSON.stringify(runs)).not.toContain("secret");
    expect(runs[1].tokens_total).toBe(3);
  });

  it("content longer than ACP stores is cut and flagged; a big flush is split under the body limit", async () => {
    const fetchMock = mockFetchSequence([{ ok: true }]);
    const acp = createClient({ ...base, fetch: fetchMock as any, flushAt: 1000, maxBuffer: 1000 });
    const long = "x".repeat(MAX_FULL_CHARS + 500);
    for (let i = 0; i < 30; i++) acp.reportRun({ status: "success", fullInput: long, fullOutput: long });
    await acp.stop();
    const bodies = reportBodies(fetchMock);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.reduce((n, b) => n + b.runs.length, 0)).toBe(30);
    for (const call of fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/report"))) {
      expect(Buffer.byteLength(String(call[1]?.body))).toBeLessThan(5_000_000);
    }
    const run = bodies[0].runs[0];
    expect(String(run.full_input)).toHaveLength(MAX_FULL_CHARS);
    expect(run.full_input_truncated).toBe(true);
    expect(run.full_output_truncated).toBe(true);
  });

  it("never follows a redirect and says where ACP moved", async () => {
    const warn = vi.fn();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 308,
      headers: new Headers({ location: "https://new.example/api/report" }),
      json: async () => ({}),
    }) as unknown as Response);
    const acp = createClient({ ...base, fetch: fetchMock as any, logger: { warn } });
    await acp.fetchPrompt();
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
    expect(String(warn.mock.calls[0][0])).toMatch(/308 redirect to https:\/\/new\.example\/api\/report: not followed.*Update the ACP url/);
  });
});

describe("extractText", () => {
  it("reads OpenAI (chat and Responses), Anthropic, Gemini and Vercel AI SDK results", () => {
    expect(extractText("plain")).toBe("plain");
    expect(extractText({ choices: [{ message: { content: "chat" } }] })).toBe("chat");
    expect(extractText({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] })).toBe("ab");
    expect(extractText({ output_text: "responses" })).toBe("responses");
    expect(extractText({ content: [{ type: "text", text: "claude" }, { type: "tool_use", name: "t" }] })).toBe("claude");
    expect(extractText({ response: { candidates: [{ content: { parts: [{ text: "gem" }, { text: "ini" }] } }] } })).toBe("gemini");
    expect(extractText({ candidates: [{ content: { parts: [{ text: "g2" }] } }] })).toBe("g2");
    expect(extractText({ text: "vercel" })).toBe("vercel");
  });

  it("returns null for unknown shapes and never calls methods on the result", () => {
    const text = vi.fn(() => "called");
    expect(extractText({ text })).toBeNull();
    expect(text).not.toHaveBeenCalled();
    for (const junk of [null, undefined, 42, "", {}, { choices: [] }, { content: "x" }]) expect(extractText(junk)).toBeNull();
  });
});
