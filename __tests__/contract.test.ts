import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClient, extractTokens, NonceCache, signPayload, verifySignature, type AcpClient } from "../src/index.js";

/**
 * Wire-contract vectors shared with the server and the Python SDK. They are generated from the server's real
 * signing code (server/__tests__/sdk-vectors.ts in the main repository); do not edit contract/vectors.json by hand.
 */
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, any>;

const vectors = JSON.parse(readFileSync(new URL("./contract/vectors.json", import.meta.url), "utf8")) as Obj;

describe("contract: webhook signature v2", () => {
  const { now, cases } = vectors.webhooks as { now: number; cases: Obj[] };

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const cache = new NonceCache();
    const secrets: string[] = c.secrets ?? [vectors.secret, vectors.secret_prev];
    for (const req of c.requests as Obj[]) {
      const out = verifySignature({
        secrets,
        rawBody: req.raw_body,
        headers: req.headers,
        now,
        seenNonce: (n) => cache.has(n),
      });
      if (out.ok && out.nonce) cache.add(out.nonce);
      expect(out.reason ? { ok: out.ok, reason: out.reason } : { ok: out.ok }).toEqual(req.expect);
    }
  });
});

describe("contract: client scenarios", () => {
  it.each((vectors.scenarios as Obj[]).map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const sent: Obj[] = [];
    let reply: { status: number; body: string; whileInFlight: string[] } | null = null;
    const sign = (raw: string) => signPayload(vectors.secret, raw).headers as unknown as Record<string, string>;

    let acp: AcpClient;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/heartbeat")) {
        sent.push(JSON.parse(String(init?.body)).agents[0]);
        const r = reply!;
        for (const raw of r.whileInFlight) acp.handleWebhook(sign(raw), raw);
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    };
    acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: vectors.agent_id,
      webhookSecret: vectors.secret,
      webhookSecretPrev: vectors.secret_prev,
      disableControl: scenario.client?.disable_control === true,
      heartbeatMs: 3_600_000,
      fetch: fetchImpl as typeof fetch,
      logger: {},
    });

    for (const step of scenario.steps as Obj[]) {
      if (step.webhook) {
        const raw: string = step.webhook.raw_body;
        expect(acp.handleWebhook(sign(raw), raw)).toEqual(step.expect);
      } else if (step.apply) {
        expect(acp.applyCommand(step.apply.command, step.apply.payload)).toBe(step.expect.result);
      } else if (step.report) {
        const r = step.report;
        acp.reportRun({ status: r.status, tokensInput: r.tokens_input, tokensOutput: r.tokens_output, tokensTotal: r.tokens_total });
      } else if (step.heartbeat) {
        const hb = step.heartbeat;
        reply = {
          status: hb.http_status,
          body: hb.reply_raw ?? JSON.stringify(hb.reply as Json),
          whileInFlight: hb.while_in_flight ?? [],
        };
        await (acp as unknown as { heartbeat(): Promise<void> }).heartbeat();
        expect(sent.at(-1)).toEqual(hb.sent);
      } else {
        throw new Error(`unknown step: ${JSON.stringify(step)}`);
      }
      expect({
        status: acp.status,
        model: acp.getEffectiveModel(),
        prompt_version: acp.getCachedPromptVersion() ?? null,
      }).toEqual(step.state);
    }
    await acp.stop();
  });
});

/** Replace every `{"$repeat": [text, n]}` with `text` repeated n times. */
function expandRepeats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandRepeats);
  if (value && typeof value === "object") {
    const rep = (value as { $repeat?: unknown }).$repeat;
    if (Array.isArray(rep) && Object.keys(value).length === 1) return String(rep[0]).repeat(Number(rep[1]));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandRepeats(v)]));
  }
  return value;
}

describe("contract: run reporting", () => {
  it.each((vectors.report as Obj[]).map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const bodies: Obj[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/report")) bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    };
    const acp = createClient({
      url: "https://panel.test",
      apiKey: "acp_test",
      agentId: vectors.agent_id,
      webhookSecret: vectors.secret,
      captureContent: c.client?.capture_content !== false,
      fetch: fetchImpl as typeof fetch,
      logger: {},
    });
    const call = expandRepeats(c.call) as Obj;
    if (call.wrap) {
      const w = call.wrap;
      const run = acp.wrapAgentRun(
        async () => {
          if (w.raises) throw new Error(w.raises);
          return w.result;
        },
        { inputSummary: w.input_summary, userInput: w.user_input, fullInput: w.full_input, modelUsed: w.model_used },
      );
      if (w.raises) await expect(run).rejects.toThrow(w.raises);
      else await run;
    } else {
      const r = call.report;
      acp.reportRun({
        status: r.status,
        inputSummary: r.input_summary,
        outputSummary: r.output_summary,
        userInput: r.user_input,
        fullInput: r.full_input,
        fullOutput: r.full_output,
        errorMessage: r.error_message,
        trigger: r.trigger,
      });
    }
    await acp.stop();
    const { agent_id, dedupe_key, execution_time_ms, ...row } = bodies[0].runs[0];
    expect(agent_id).toBe(vectors.agent_id);
    expect(typeof dedupe_key).toBe("string");
    expect(execution_time_ms === undefined || typeof execution_time_ms === "number").toBe(true);
    expect(row).toEqual(expandRepeats(c.row));
  });
});

describe("contract: token extraction", () => {
  it.each((vectors.tokens as Obj[]).map((t) => [t.name, t] as const))("%s", (_name, t) => {
    const out = extractTokens(t.input);
    expect(out && { tokens_input: out.tokensInput, tokens_output: out.tokensOutput, tokens_total: out.tokensTotal }).toEqual(t.expect);
  });
});
