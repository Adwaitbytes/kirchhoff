/**
 * Model access for the AI layer. Two backends: OpenRouter (OpenAI-compatible chat completions)
 * and the Anthropic Messages API, chosen from env. Nothing here is reachable from the veto path
 * (scripts/no-ai-in-veto-path.sh enforces that engine/, judge/, contracts/ and workflows/ never import it).
 */

export type JsonSchema = Record<string, unknown>;

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolDef = { name: string; description: string; parameters: JsonSchema };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Structured output: the reply must be JSON matching this schema (no tools in the same call). */
  responseSchema?: { name: string; schema: JsonSchema };
  maxTokens: number;
  temperature: number;
};

export type Usage = { inputTokens: number; outputTokens: number; costUsd: number };

export type ChatResponse = {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  finishReason: string;
  /** True when served from the input-hash cache (no spend). */
  cached: boolean;
};

export interface LlmProvider {
  readonly name: string;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

const LOCAL_ONLY_KEYWORDS = new Set(["pattern", "maxLength", "minLength", "minItems", "maxItems", "format", "minimum", "maximum"]);

/**
 * Strict structured-output modes accept a subset of JSON Schema. Constraints the provider may reject
 * are removed here and enforced locally (guard.validateJson) on the reply instead.
 */
export function providerSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(providerSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  // Nullable unions inflate the compiled grammar past some providers' limits: send the non-null branch.
  // Callers then treat an empty value as absent (see copilot/agent.ts normalizeAbsent).
  const any = (schema as { anyOf?: unknown[] }).anyOf;
  if (Array.isArray(any) && any.length === 2 && any.some((x) => typeof x === "object" && x !== null && (x as { type?: unknown }).type === "null")) {
    return providerSchema(any.find((x) => (x as { type?: unknown }).type !== "null"));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "properties" && typeof v === "object" && v !== null) {
      // Property names are data, not keywords: keep every one.
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, providerSchema(sub)]));
    } else if (!LOCAL_ONLY_KEYWORDS.has(k)) {
      out[k] = providerSchema(v);
    }
  }
  return out;
}

/** USD per token, from the OpenRouter model list (checked 2026-10-04). Used only when the provider omits cost. */
const PRICES: Readonly<Record<string, { in: number; out: number }>> = {
  "anthropic/claude-sonnet-5.5": { in: 2e-6, out: 10e-6 },
  "anthropic/claude-haiku-4.5": { in: 1e-6, out: 5e-6 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(PRICES).find((k) => model.endsWith(k.split("/")[1] ?? k)) ?? model;
  const p = PRICES[key] ?? { in: 3e-6, out: 15e-6 };
  return inputTokens * p.in + outputTokens * p.out;
}

/* ---------------------------------------------------------------------------------------------- OpenRouter */

type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAi(m: ChatMessage): OpenAiMessage {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant") {
    return m.toolCalls && m.toolCalls.length > 0
      ? { role: "assistant", content: m.content, tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) }
      : { role: "assistant", content: m.content ?? "" };
  }
  return { role: m.role, content: m.content };
}

type OpenAiResponse = {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; metadata?: { raw?: unknown; provider_name?: string } };
};

export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private omitTemperature = false;
  private readonly reasoningEffort: "low" | "medium" | "high" | null;

  constructor(apiKey: string, options: { fetch?: typeof fetch; baseUrl?: string; reasoningEffort?: "low" | "medium" | "high" | null } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.reasoningEffort = options.reasoningEffort ?? null;
  }

  /** Retries transient upstream failures (429, 5xx, "Provider returned error") twice with backoff. */
  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(req, signal);
      } catch (e) {
        const transient = e instanceof ProviderError && (e.status === 429 || (e.status !== null && e.status >= 500) || /provider returned error/i.test(e.message));
        if (!transient || attempt >= 2 || signal?.aborted === true) throw e;
        await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
      }
    }
  }

  private async once(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOpenAi),
      max_tokens: req.maxTokens,
      usage: { include: true },
    };
    if (!this.omitTemperature) body.temperature = req.temperature;
    // Hidden reasoning tokens count against max_tokens and cost; keep them small and out of the reply.
    if (this.reasoningEffort) body.reasoning = { effort: this.reasoningEffort, exclude: true };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
    if (req.responseSchema) {
      body.response_format = { type: "json_schema", json_schema: { name: req.responseSchema.name, strict: true, schema: providerSchema(req.responseSchema.schema) } };
    }
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "x-title": "KIRCHHOFF",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as OpenAiResponse;
    if (!res.ok) {
      const raw = json.error?.metadata?.raw;
      const detail = raw === undefined ? "" : ` (${json.error?.metadata?.provider_name ?? "upstream"}: ${(typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 300)})`;
      const msg = `${json.error?.message ?? `HTTP ${res.status}`}${detail}`;
      // Some models reject sampling parameters; retry once without temperature.
      if (res.status === 400 && !this.omitTemperature && /temperature/i.test(msg)) {
        this.omitTemperature = true;
        return this.once(req, signal);
      }
      throw new ProviderError(`openrouter: ${msg.slice(0, 300)}`, res.status);
    }
    const choice = json.choices?.[0];
    const msg = choice?.message;
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    return {
      content: msg?.content ?? null,
      toolCalls: (msg?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
      usage: { inputTokens, outputTokens, costUsd: json.usage?.cost ?? estimateCost(req.model, inputTokens, outputTokens) },
      model: json.model ?? req.model,
      finishReason: choice?.finish_reason ?? "unknown",
      cached: false,
    };
  }
}

/* ---------------------------------------------------------------------------------------------- Anthropic */

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicResponse = {
  model?: string;
  stop_reason?: string;
  content?: AnthropicBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

const RESPOND_TOOL = "respond";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, options: { fetch?: typeof fetch } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content).join("\n\n");
    const messages: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];
    const push = (role: "user" | "assistant", block: AnthropicBlock): void => {
      const last = messages[messages.length - 1];
      if (last?.role === role) last.content.push(block);
      else messages.push({ role, content: [block] });
    };
    for (const m of req.messages) {
      if (m.role === "system") continue;
      if (m.role === "user") push("user", { type: "text", text: m.content });
      else if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
      else {
        if (m.content) push("assistant", { type: "text", text: m.content });
        for (const t of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: t.id, name: t.name, input: JSON.parse(t.arguments || "{}") as unknown });
      }
    }
    const body: Record<string, unknown> = { model: req.model.replace(/^anthropic\//, "").replace(/\./g, "-"), system, messages, max_tokens: req.maxTokens, temperature: req.temperature };
    const tools = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    // Structured output through a forced tool call: the tool input is the JSON document.
    if (req.responseSchema) {
      tools.push({ name: RESPOND_TOOL, description: `Return the ${req.responseSchema.name} document.`, input_schema: providerSchema(req.responseSchema.schema) as JsonSchema });
      body.tool_choice = { type: "tool", name: RESPOND_TOOL };
    }
    if (tools.length > 0) body.tools = tools;
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as AnthropicResponse;
    if (!res.ok) throw new ProviderError(`anthropic: ${(json.error?.message ?? `HTTP ${res.status}`).slice(0, 300)}`, res.status);
    const blocks = json.content ?? [];
    const respond = blocks.find((b): b is Extract<AnthropicBlock, { type: "tool_use" }> => b.type === "tool_use" && b.name === RESPOND_TOOL);
    const text = blocks.filter((b): b is Extract<AnthropicBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    return {
      content: respond ? JSON.stringify(respond.input) : text || null,
      toolCalls: respond
        ? []
        : blocks
            .filter((b): b is Extract<AnthropicBlock, { type: "tool_use" }> => b.type === "tool_use")
            .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) })),
      usage: { inputTokens, outputTokens, costUsd: estimateCost(req.model, inputTokens, outputTokens) },
      model: json.model ?? req.model,
      finishReason: json.stop_reason ?? "unknown",
      cached: false,
    };
  }
}

/* ---------------------------------------------------------------------------------------------- env */

export type AiConfig = {
  provider: LlmProvider | null;
  /** Spec Copilot, Narrator, Ask. */
  model: string;
  /** Cheap tasks (Topology Scout ranking, injection suite smoke). */
  fastModel: string;
};

/**
 * OpenRouter when OPENROUTER_API_KEY is set (AI_PROVIDER=openrouter, the default), Anthropic when
 * ANTHROPIC_API_KEY is set (or AI_PROVIDER=anthropic). No key: provider null, and every feature
 * degrades to its deterministic path (the Narrator template, Copilot disabled with a clear error).
 */
function reasoningEffort(v: string | undefined): "low" | "medium" | "high" | null {
  if (v === "none") return null;
  return v === "medium" || v === "high" ? v : "low";
}

export function aiConfigFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): AiConfig {
  const pref = env.AI_PROVIDER ?? "openrouter";
  const or = env.OPENROUTER_API_KEY;
  const an = env.ANTHROPIC_API_KEY;
  const opts = fetchImpl ? { fetch: fetchImpl } : {};
  if ((pref === "openrouter" || !an) && or) {
    return {
      provider: new OpenRouterProvider(or, { ...opts, reasoningEffort: reasoningEffort(env.OPENROUTER_REASONING_EFFORT) }),
      model: env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5.5",
      fastModel: env.OPENROUTER_MODEL_FAST ?? "anthropic/claude-haiku-4.5",
    };
  }
  if (an) {
    return { provider: new AnthropicProvider(an, opts), model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", fastModel: env.ANTHROPIC_MODEL_FAST ?? "claude-haiku-4-5" };
  }
  return { provider: null, model: env.OPENROUTER_MODEL ?? env.ANTHROPIC_MODEL ?? "none", fastModel: env.OPENROUTER_MODEL_FAST ?? "none" };
}
