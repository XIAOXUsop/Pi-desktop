import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { ModelRegistry } from './models.js';
import { OpenAIChatProvider } from './providers/openai-chat.js';
import { OpenAIResponsesProvider } from './providers/openai-responses.js';
import { AnthropicProvider } from './providers/anthropic.js';
import type { Model } from './types.js';

export interface ProviderConfig {
  id: string; protocol: 'openai-chat' | 'openai-responses' | 'anthropic'; baseUrl: string;
  apiKeyEnv?: string; timeoutMs?: number;
  tokenLimitField?: 'max_completion_tokens' | 'max_tokens'; streamUsage?: boolean;
  thinking?: 'enabled' | 'disabled';
}
export interface Config { defaultModel: string; providers: ProviderConfig[]; models: Model[] }
const configSchema = {
  type: 'object', additionalProperties: false, required: ['defaultModel', 'providers', 'models'], properties: {
    defaultModel: { type: 'string', minLength: 1 },
    providers: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'protocol', 'baseUrl'], properties: {
      id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' }, protocol: { enum: ['openai-chat', 'openai-responses', 'anthropic'] },
      baseUrl: { type: 'string', minLength: 1 }, apiKeyEnv: { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 },
      tokenLimitField: { enum: ['max_completion_tokens', 'max_tokens'] }, streamUsage: { type: 'boolean' },
      thinking: { enum: ['enabled', 'disabled'] },
    } } },
    models: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['provider', 'id', 'contextWindow', 'maxOutputTokens', 'tools'], properties: {
        provider: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 },
        contextWindow: { type: 'integer', minimum: 1 }, maxOutputTokens: { type: 'integer', minimum: 1 },
        tools: { type: 'boolean' }, reasoningEffort: { enum: ['low', 'medium', 'high'] },
      } } },
  },
};
export async function loadConfig(path: string): Promise<{ config: Config; registry: ModelRegistry }> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parseConfig(raw);
}
export function parseConfig(raw: unknown): { config: Config; registry: ModelRegistry } {
  const ajv = new Ajv({ strict: true });
  if (!ajv.validate(configSchema, raw)) throw new Error(`Invalid config: ${ajv.errorsText()}`);
  const config = raw as Config; const registry = new ModelRegistry();
  for (const p of config.providers) {
    if (p.protocol !== 'openai-chat' && (p.tokenLimitField !== undefined || p.streamUsage !== undefined || p.thinking !== undefined)) throw new Error('Chat compatibility settings require openai-chat');
    const options = { id: p.id, baseUrl: p.baseUrl, timeoutMs: p.timeoutMs, tokenLimitField: p.tokenLimitField, streamUsage: p.streamUsage, thinking: p.thinking,
      apiKey: () => {
        if (!p.apiKeyEnv) return undefined;
        const key = process.env[p.apiKeyEnv]; if (!key) throw new Error(`Set environment variable ${p.apiKeyEnv}`); return key;
      } };
    registry.registerProvider(p.protocol === 'openai-chat' ? new OpenAIChatProvider(options) : p.protocol === 'openai-responses' ? new OpenAIResponsesProvider(options) : new AnthropicProvider(options));
  }
  for (const model of config.models) {
    if (model.reasoningEffort && config.providers.find(p => p.id === model.provider)?.protocol === 'anthropic') throw new Error('Anthropic thinking is not supported in this version');
    registry.registerModel(model);
  }
  registry.getModel(config.defaultModel); return { config, registry };
}
