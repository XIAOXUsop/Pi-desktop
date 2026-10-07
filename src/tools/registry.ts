import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { Tool, ToolDeclaration } from '../types.js';
import { clone, record } from '../util.js';

export class ToolRegistry {
  private ajv = new Ajv({ allErrors: true, strict: true });
  private tools = new Map<string, { tool: Tool; validate: ValidateFunction }>();
  register(tool: Tool): this {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || this.tools.has(tool.name)) throw new Error(`Invalid/duplicate tool name: ${tool.name}`);
    const validate = this.ajv.compile(tool.parameters);
    this.tools.set(tool.name, { tool: { ...tool, parameters: clone(tool.parameters) }, validate }); return this;
  }
  get(name: string): Tool {
    const registered = this.tools.get(name); if (!registered) throw new Error(`Unknown tool: ${name}`);
    return registered.tool;
  }
  validate(name: string, raw: string): Record<string, unknown> {
    const entry = this.tools.get(name); if (!entry) throw new Error(`Unknown tool: ${name}`);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('Tool arguments are not complete JSON'); }
    if (!entry.validate(value)) throw new Error(`Invalid arguments for ${name}: ${this.ajv.errorsText(entry.validate.errors)}`);
    return record(value);
  }
  declarations(names: string[]): ToolDeclaration[] {
    return names.map(name => { const tool = this.get(name); return { name, description: tool.description, parameters: clone(tool.parameters) }; });
  }
  names(): string[] { return [...this.tools.keys()]; }
}
