import { readFileSync } from "node:fs";
import type { ModelRequest, ModelResponse, ModelToolCall, ProviderPort } from "@zfacade/contracts";
import { ZfacadeError } from "@zfacade/contracts";

interface SseToolAccum { id: string; name: string; argsText: string }

/**
 * Real OpenAI-compatible streaming provider (local endpoint; D2).
 * Live acceptance is pending (S4): no test in this repo claims a live pass.
 * Tool calls are assembled from streamed fragments and JSON-parsed only when
 * complete; a truncated stream yields interrupted=true and no runnable calls.
 */
export class OpenAICompatibleProvider implements ProviderPort {
  readonly isTestDouble = false;
  readonly id: string;
  constructor(
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly apiKey: string | undefined,
  ) { this.id = `openai-compatible:${modelId}`; }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.modelId, stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxTokens,
      messages: request.messages.map((m) => {
        if (m.role === "assistant" && m.toolCalls) {
          return {
            role: "assistant", content: m.content || null,
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id, type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.arguments) },
            })),
          };
        }
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        return { role: m.role, content: m.content };
      }),
      tools: request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!res.ok || !res.body) {
      throw new ZfacadeError("ProviderError", `provider HTTP ${res.status} from ${url}`);
    }
    let text = "";
    let finishReason = "";
    let usage: ModelResponse["usage"];
    let sawDone = false;
    const tools = new Map<number, SseToolAccum>();
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") { sawDone = true; continue; }
          let chunk: Record<string, unknown>;
          try { chunk = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          const u = chunk.usage as Record<string, number> | undefined;
          if (u) usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens };
          const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
          const delta = (choice.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            request.onTextDelta?.(delta.content);
          }
          const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          for (const tc of tcs ?? []) {
            const index = typeof tc.index === "number" ? tc.index : 0;
            const acc = tools.get(index) ?? { id: "", name: "", argsText: "" };
            if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
            const fn = (tc.function ?? {}) as Record<string, unknown>;
            if (typeof fn.name === "string" && fn.name) acc.name = fn.name;
            if (typeof fn.arguments === "string") acc.argsText += fn.arguments;
            tools.set(index, acc);
          }
        }
      }
    } catch (e) {
      if (request.signal?.aborted) throw new ZfacadeError("ProviderCancelled", "provider request cancelled");
      // Transport failure mid-stream: incomplete response, never runnable.
      return { modelId: this.modelId, text, toolCalls: [], finishReason: "interrupted", interrupted: true, usage };
    }
    const toolCalls: ModelToolCall[] = [];
    let interrupted = !sawDone && finishReason === "";
    for (const [index, acc] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
      try {
        toolCalls.push({ id: acc.id || `call_${index}`, name: acc.name, arguments: JSON.parse(acc.argsText || "{}") as unknown });
      } catch {
        interrupted = true; // truncated tool JSON: execute nothing (A4)
      }
    }
    if (interrupted) return { modelId: this.modelId, text, toolCalls: [], finishReason: finishReason || "interrupted", interrupted: true, usage };
    return { modelId: this.modelId, text, toolCalls, finishReason: finishReason || "stop", usage };
  }
}

interface DeterministicStep {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  finishReason?: string;
}

/** Explicit test double. Never a default; receipts label it deterministic-test. */
export class DeterministicProvider implements ProviderPort {
  readonly isTestDouble = true;
  readonly id = "deterministic-test";
  private idx = 0;
  constructor(private readonly steps: DeterministicStep[]) {}
  static fromFile(path: string): DeterministicProvider {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { steps: DeterministicStep[] };
    if (!Array.isArray(parsed.steps)) throw new ZfacadeError("ConfigInvalid", "deterministic script needs a steps array");
    return new DeterministicProvider(parsed.steps);
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new ZfacadeError("ProviderCancelled", "cancelled");
    const step = this.steps[this.idx++];
    if (!step) throw new ZfacadeError("ProviderError", "deterministic script exhausted");
    const text = step.text ?? "";
    if (text) request.onTextDelta?.(text);
    return {
      modelId: "deterministic-test", text,
      toolCalls: (step.toolCalls ?? []).map((t, i) => ({ id: `det_${this.idx}_${i}`, name: t.name, arguments: t.arguments })),
      finishReason: step.finishReason ?? (step.toolCalls?.length ? "tool_calls" : "stop"),
    };
  }
}
