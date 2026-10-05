import type { ChatRequest, ChatResponse, LlmProvider, ToolCall } from "./provider.ts";

export type ScriptedTurn = { content?: string | null; toolCalls?: ToolCall[] } | ((req: ChatRequest) => { content?: string | null; toolCalls?: ToolCall[] });

/** Test double: replays scripted turns in order and records every request. Never touches the network. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.turns = [...turns];
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    const next = this.turns.shift();
    if (next === undefined) return Promise.reject(new Error("ScriptedProvider: no more scripted turns"));
    const t = typeof next === "function" ? next(req) : next;
    return Promise.resolve({
      content: t.content ?? null,
      toolCalls: t.toolCalls ?? [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      model: req.model,
      finishReason: t.toolCalls && t.toolCalls.length > 0 ? "tool_calls" : "stop",
      cached: false,
    });
  }
}
