export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonSchema = Record<string, unknown>;
export interface Usage { input: number; output: number; cacheRead?: number; cacheWrite?: number }
export interface ToolCall { id: string; name: string; arguments: string }
export type StopReason = 'stop' | 'tool_use' | 'length';
export interface UserMessage { role: 'user'; text: string; timestamp: number }
export interface AssistantMessage {
  role: 'assistant'; text: string; toolCalls: ToolCall[]; provider: string; model: string;
  stopReason: StopReason; usage: Usage; timestamp: number;
  reasoning?: { index: number; text: string; redacted?: boolean }[];
  executionStatus?: 'completed' | 'cancelled' | 'failed' | 'limit';
  finishReason?: string;
  phase?: 'commentary' | 'final_answer';
  providerState?: { protocol: 'openai-responses'; output: Json[] } | { protocol: 'openai-chat'; reasoningContent: string };
}
export interface ToolMessage {
  role: 'tool'; callId: string; name: string; text: string; isError: boolean; timestamp: number;
  details?: Json;
}
export interface FileSnapshot { exists: boolean; hash: string | null; snapshot: string | null }
export interface FileChange {
  id: string; callId: string; path: string; operation: 'create' | 'update'; timestamp: number;
  before: FileSnapshot; after: FileSnapshot; patch: string; patchTruncated: boolean; addedLines: number; removedLines: number;
}
export type Message = UserMessage | AssistantMessage | ToolMessage;
export interface Model {
  provider: string; id: string; contextWindow: number; maxOutputTokens: number;
  tools: boolean; reasoningEffort?: 'low' | 'medium' | 'high';
}
export interface ToolDeclaration { name: string; description: string; parameters: JsonSchema }
export interface ModelRequest {
  model: Model; system: string; messages: Message[]; tools: ToolDeclaration[]; signal: AbortSignal;
}
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'done'; message: AssistantMessage };
export interface Provider { readonly id: string; stream(request: ModelRequest): AsyncIterable<ModelEvent> }
export interface ToolContext {
  workspace: string; signal: AbortSignal; callId: string;
  update(text: string): void;
}
export interface ToolResult { text: string; isError?: boolean; details?: Json; change?: FileChange }
export interface Tool extends ToolDeclaration {
  kind: 'read' | 'write' | 'execute';
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
export type RunStatus = 'completed' | 'cancelled' | 'failed' | 'limit';
export interface RunResult { status: RunStatus; text: string; turns: number; error?: string }
export type AgentEventData =
  | { type: 'run_start'; runId: string }
  | { type: 'turn_start'; turn: number; model: Model }
  | { type: 'message'; entryId: string; message: Message }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_update'; callId: string; text: string }
  | { type: 'tool_end'; call: ToolCall; result: ToolMessage }
  | { type: 'file_change'; change: FileChange }
  | { type: 'queue_changed'; steering: number; followUp: number }
  | { type: 'model_changed'; model: Model }
  | { type: 'compaction_start'; before: number }
  | { type: 'compaction_end'; before: number; after: number }
  | { type: 'run_end'; result: RunResult };
export type AgentEvent = AgentEventData & { sessionId: string; sequence: number; timestamp: number };
export interface HookContext { workspace: string; signal: AbortSignal; call: ToolCall; tool: Tool }
export interface Extension {
  name: string;
  beforeTool?(args: Record<string, unknown>, context: HookContext): Promise<void | { block: string }>;
  afterTool?(result: ToolResult, context: HookContext): Promise<ToolResult | void>;
  transformContext?(messages: Message[], signal: AbortSignal): Promise<Message[]>;
}
