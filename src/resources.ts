import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { Workspace } from './tools/workspace.js';

export interface Skill { name: string; description: string; path: string }
export class ProjectResources {
  private skills = new Map<string, Skill>();
  private constructor(private workspace: Workspace, readonly instructions: string) {}
  static async load(workspace: Workspace): Promise<ProjectResources> {
    let instructions = '';
    try {
      const target = await workspace.path('AGENTS.md'); const info = await stat(target);
      if (info.size > 64 * 1024) throw new Error('AGENTS.md exceeds 64 KiB');
      instructions = await readFile(target, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const resource = new ProjectResources(workspace, instructions);
    for (const directory of ['.agents/skills', 'skills']) {
      let children;
      try { children = await readdir(await workspace.path(directory), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        const path = await workspace.path(resolve(workspace.root, directory, child.name, 'SKILL.md'));
        let source: string;
        try { if ((await stat(path)).size > 128 * 1024) throw new Error('Skill exceeds 128 KiB'); source = await readFile(path, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
        if (!frontmatter) throw new Error(`Skill ${child.name} requires frontmatter`);
        const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(frontmatter)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
        const name = field('name'); const description = field('description');
        if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !description) throw new Error(`Invalid skill metadata: ${child.name}`);
        if (resource.skills.has(name)) throw new Error(`Duplicate skill: ${name}`);
        resource.skills.set(name, { name, description, path });
      }
    }
    return resource;
  }
  list(): Skill[] { return [...this.skills.values()].map(s => ({ ...s })); }
  prompt(): string {
    const skills = this.list().map(s => `- ${s.name}: ${s.description} (read ${s.path} when needed)`).join('\n');
    return `${this.instructions ? `\nProject instructions:\n${this.instructions}` : ''}${skills ? `\nAvailable skills:\n${skills}` : ''}`;
  }
  async readSkill(name: string): Promise<string> {
    const skill = this.skills.get(name); if (!skill) throw new Error('Unknown skill');
    const path = await this.workspace.path(skill.path); const canonical = await realpath(path);
    const rel = relative(this.workspace.root, canonical);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('Skill escapes workspace');
    return readFile(canonical, 'utf8');
  }
}
