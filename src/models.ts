import type { Model, Provider } from './types.js';
import { clone, positiveInteger } from './util.js';

export class ModelRegistry {
  private providers = new Map<string, Provider>();
  private models = new Map<string, Model>();
  registerProvider(provider: Provider): this {
    if (!provider.id || this.providers.has(provider.id)) throw new Error(`Duplicate/empty provider: ${provider.id}`);
    this.providers.set(provider.id, provider); return this;
  }
  registerModel(model: Model): this {
    positiveInteger(model.contextWindow, 'contextWindow'); positiveInteger(model.maxOutputTokens, 'maxOutputTokens');
    if (!model.id || !this.providers.has(model.provider)) throw new Error('Model requires a registered provider and id');
    if (model.maxOutputTokens > model.contextWindow) throw new Error('Output limit cannot exceed context window');
    const key = `${model.provider}/${model.id}`;
    if (this.models.has(key)) throw new Error(`Duplicate model: ${key}`);
    this.models.set(key, clone(model)); return this;
  }
  getModel(key: string): Model {
    const model = this.models.get(key); if (!model) throw new Error(`Unknown model: ${key}`); return clone(model);
  }
  getProvider(model: Model): Provider {
    const provider = this.providers.get(model.provider);
    if (!provider) throw new Error(`Unknown provider: ${model.provider}`); return provider;
  }
  list(): Model[] { return [...this.models.values()].map(clone); }
}
