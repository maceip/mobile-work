/** Provider port (plan 8.3): one request attempt = one engine-visible step input. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

export interface ModelResponse {
  /** Provider-reported model identity for receipts ("deterministic-test" for doubles). */
  modelId: string;
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** True when the stream ended without a complete, valid response. Tool calls must not run. */
  interrupted?: boolean;
}

export interface ProviderPort {
  readonly id: string;
  /** True only for explicitly labeled test doubles. Receipts must carry the label. */
  readonly isTestDouble: boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
