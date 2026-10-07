const registry = 'https://registry.npmjs.org/';
const validName = name => typeof name === 'string' && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name) && name.length <= 214;
const clip = (value, size = 4000) => typeof value === 'string' ? value.slice(0,size) : '';
export class ResourceMarket {
  constructor(fetcher = globalThis.fetch) { this.fetcher = fetcher; }
  async read(path) {
    const response = await this.fetcher(registry + path, {signal:AbortSignal.timeout(15000),redirect:'error',headers:{accept:'application/json'}});
    if (!response.ok) throw new Error(`市场暂时无法读取（${response.status}），请稍后重试`);
    if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('市场返回内容过大');
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try { while(true) {const {done,value} = await reader.read();if(done) break;bytes += value.byteLength;if(bytes > 4 * 1024 * 1024) throw new Error('市场返回内容过大');chunks.push(Buffer.from(value));} }
    finally {await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async search({query = ''} = {}) {
    if(typeof query !== 'string' || query.length > 200) throw new Error('搜索文字不能超过 200 字');
    const result = await this.read('-/v1/search?' + new URLSearchParams({text:`keywords:pi-package ${query.trim()}`,size:'20'}));
    return {items:(result.objects || []).filter(({package:p}) => p?.keywords?.includes('pi-package')).map(({package:p}) => ({name:p?.name,version:clip(p?.version,100),description:clip(p?.description),publisher:clip(p?.publisher?.username || p?.maintainers?.[0]?.username,200)})).filter(p => validName(p.name)),total:result.total || 0};
  }
  async detail({name,version}) {
    if(!validName(name) || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version) || version.length > 100) throw new Error('无效包名称或版本');
    const p = await this.read(encodeURIComponent(name) + '/' + encodeURIComponent(version));
    if(p.name !== name || p.version !== version) throw new Error('市场返回的包版本不一致');
    const safeLink = value => {try {const url = new URL(value);return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';} catch {return '';}};
    return {name,version,source:`npm:${name}@${version}`,description:clip(p.description),license:clip(p.license,200),homepage:safeLink(p.homepage),
      registryUrl:`https://www.npmjs.com/package/${name}/v/${version}`,types:['extensions','skills','prompts','themes'].filter(type => Array.isArray(p.pi?.[type]) && p.pi[type].some(path => typeof path === 'string' && !path.startsWith('!'))),
      peers:p.peerDependencies && typeof p.peerDependencies === 'object' ? Object.entries(p.peerDependencies).slice(0,20).map(([key,value]) => `${clip(key,214)} ${clip(value,200)}`) : []};
  }
}
