import { describe, expect, it } from "vitest";
import { AnthropicProvider, CachedProvider, MemoryCache, OpenRouterProvider, ScriptedProvider, aiConfigFromEnv, providerSchema, type ChatRequest } from "../src/index.ts";

type Captured = { url: string; init: RequestInit };

function fakeFetch(responses: { status: number; body: unknown }[], seen: Captured[]): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { status: 500, body: {} };
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
}

const req: ChatRequest = {
  model: "anthropic/claude-sonnet-5.5",
  temperature: 0,
  maxTokens: 100,
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "get_contract", arguments: '{"chain":"x"}' }] },
    { role: "tool", toolCallId: "c1", name: "get_contract", content: "{}" },
  ],
  tools: [{ name: "get_contract", description: "d", parameters: { type: "object", properties: {} } }],
};

describe("providers", () => {
  it("OpenRouter: OpenAI-format messages, tools, usage accounting, bearer auth", async () => {
    const seen: Captured[] = [];
    const p = new OpenRouterProvider("sk-or-test", { fetch: fakeFetch([{ status: 200, body: { model: "m", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "t", function: { name: "get_contract", arguments: "{}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } } }], seen) });
    const r = await p.chat(req);
    expect(r.toolCalls).toEqual([{ id: "t", name: "get_contract", arguments: "{}" }]);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.0001 });
    const body = JSON.parse(seen[0]?.init.body as string) as Record<string, unknown>;
    expect(body.temperature).toBe(0);
    expect((body.messages as { role: string }[]).map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-test");
  });

  it("OpenRouter: retries once without temperature when the model rejects it; sends json_schema with strict-safe schema", async () => {
    const seen: Captured[] = [];
    const p = new OpenRouterProvider("k", { fetch: fakeFetch([{ status: 400, body: { error: { message: "temperature is not supported" } } }, { status: 200, body: { choices: [{ message: { content: "{}" } }] } }], seen) });
    await p.chat({ ...req, tools: [], responseSchema: { name: "s", schema: { type: "object", properties: { pattern: { type: "string", pattern: "^a$" } } } } });
    const second = JSON.parse(seen[1]?.init.body as string) as Record<string, unknown>;
    expect(second.temperature).toBeUndefined();
    expect(second.response_format).toEqual({ type: "json_schema", json_schema: { name: "s", strict: true, schema: { type: "object", properties: { pattern: { type: "string" } } } } });
  });

  it("Anthropic: structured output through a forced respond tool, tool_use and tool_result blocks", async () => {
    const seen: Captured[] = [];
    const p = new AnthropicProvider("sk-ant", { fetch: fakeFetch([{ status: 200, body: { content: [{ type: "tool_use", id: "r", name: "respond", input: { ok: true } }], usage: { input_tokens: 3, output_tokens: 2 } } }], seen) });
    const r = await p.chat({ ...req, responseSchema: { name: "s", schema: { type: "object" } } });
    expect(r.content).toBe('{"ok":true}');
    const body = JSON.parse(seen[0]?.init.body as string) as { system: string; tool_choice: unknown; messages: { role: string; content: { type: string }[] }[] };
    expect(body.system).toBe("sys");
    expect(body.tool_choice).toEqual({ type: "tool", name: "respond" });
    expect(body.messages.map((m) => m.content.map((c) => c.type).join("+"))).toEqual(["text", "tool_use", "tool_result"]);
  });

  it("errors carry status but never the key", async () => {
    const p = new OpenRouterProvider("sk-or-secret", { fetch: fakeFetch([{ status: 401, body: { error: { message: "bad key" } } }], []) });
    await expect(p.chat(req)).rejects.toThrow(/openrouter: bad key/);
    await p.chat(req).catch((e: unknown) => { expect(String(e)).not.toContain("sk-or-secret"); });
  });

  it("cache: identical requests are served once from the provider and then from the cache", async () => {
    const inner = new ScriptedProvider([{ content: "a" }]);
    const p = new CachedProvider(inner, new MemoryCache());
    expect((await p.chat(req)).cached).toBe(false);
    expect((await p.chat(req)).cached).toBe(true);
    expect(inner.requests).toHaveLength(1);
  });

  it("env selection: OpenRouter preferred, Anthropic direct when only its key is set, none otherwise", () => {
    expect(aiConfigFromEnv({ OPENROUTER_API_KEY: "a", OPENROUTER_MODEL: "x/y" }).provider?.name).toBe("openrouter");
    expect(aiConfigFromEnv({ ANTHROPIC_API_KEY: "b" }).provider?.name).toBe("anthropic");
    expect(aiConfigFromEnv({}).provider).toBeNull();
  });

  it("providerSchema keeps property names that look like keywords", () => {
    expect(providerSchema({ properties: { format: { type: "string", format: "date" } }, minItems: 1 })).toEqual({ properties: { format: { type: "string" } } });
  });
});
