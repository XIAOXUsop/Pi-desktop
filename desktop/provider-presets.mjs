// Independent configuration templates; no CC Switch runtime or login integration.
// Sources and review date: docs/provider-presets.md.
import {readFileSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('./model-catalog.json',import.meta.url),'utf8'));
const model = (id, name, contextWindow, maxOutputTokens, limitsUrl, outputNote = '') => ({ id, name, contextWindow, maxOutputTokens, limitsUrl, outputNote, reviewedAt: '2026-10-04' });
const chat = (id, baseUrl, apiKeyEnv, options = {}) => ({ id, protocol: 'openai-chat', baseUrl, apiKeyEnv, tokenLimitField: 'max_tokens', streamUsage: true, timeoutMs: 120000, ...options });
const goModel = (id, name, context, output) => model(id, name, context, output, 'https://models.opencode.ai/api.json');
const goatModel = (id, name, context) => ({...model(id, name, context, 32768, 'https://commandcode.ai/docs/provider', '官方目录提供上下文长度，未公开输出上限；先填官方 Pi 插件默认的 32,768，可按账号能力调整。'),limitsVerified:false});
const presets = [
  { id: 'deepseek', name: 'DeepSeek', category: '国内官方', description: '沿用现有 DeepSeek 配置，默认关闭思考。',
    keyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/',
    provider: chat('deepseek', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY', { thinking: 'disabled' }),
    models: [model('deepseek-flash', 'DeepSeek Flash', 1048576, 393216, 'https://api-docs.deepseek.com/api/list-models/'), model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1048576, 393216, 'https://api-docs.deepseek.com/api/list-models/')] },
  { id: 'zhipu', name: '智谱 GLM', category: '国内官方', description: '智谱开放平台按量 API；沿用模型默认思考设置。',
    keyUrl: 'https://open.bigmodel.cn/', docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview',
    provider: chat('zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'ZHIPU_API_KEY'),
    models: [model('glm-5.3', 'GLM-5.3', 1000000, 131072, 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3'), model('glm-4.7', 'GLM-4.7', 204800, 131072, 'https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7')] },
  { id: 'moonshot', name: 'Kimi / Moonshot', category: '国内官方', description: '中国区开放平台 API；K2.5 已下线，提供当前模型。',
    keyUrl: 'https://platform.kimi.com/', docsUrl: 'https://platform.kimi.com/docs/get-api-key',
    provider: chat('moonshot', 'https://api.moonshot.cn/v1', 'MOONSHOT_API_KEY', { tokenLimitField: 'max_completion_tokens' }),
    models: [model('kimi-k3', 'Kimi K3', 1048576, 1048576, 'https://platform.kimi.com/docs/api/chat')] },
  { id: 'dashscope', name: '通义千问 / 百炼', category: '国内官方', description: '北京地域按量 API，可在高级设置填写业务空间专属地址。',
    keyUrl: 'https://bailian.console.aliyun.com/', docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    provider: chat('dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY'),
    models: [model('qwen3-coder-plus', 'Qwen3 Coder Plus', 1000000, 65536, 'https://help.aliyun.com/zh/model-studio/qwen3-coder-plus'), model('qwen3-coder-flash', 'Qwen3 Coder Flash', 1000000, 65536, 'https://help.aliyun.com/zh/model-studio/qwen3-coder-flash')] },
  { id: 'minimax', name: 'MiniMax', category: '国际官方', description: 'MiniMax 国际平台 API；国内账号请核对地址后另设服务标识。',
    keyUrl: 'https://platform.minimax.io/', docsUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
    provider: chat('minimax', 'https://api.minimax.io/v1', 'MINIMAX_API_KEY', { tokenLimitField: 'max_completion_tokens' }),
    models: [model('MiniMax-M2.7', 'MiniMax M2.7', 204800, 204800, 'https://platform.minimax.io/docs/api-reference/text-chat-openai'), model('MiniMax-M2.5', 'MiniMax M2.5', 204800, 204800, 'https://platform.minimax.io/docs/api-reference/text-chat-openai')] },
  { id: 'openai', name: 'OpenAI', category: '国际官方', description: '使用 OpenAI API 密钥，默认采用 Responses 接口。',
    keyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://developers.openai.com/api/docs/models/gpt-4.1',
    provider: { id: 'openai', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', timeoutMs: 120000 },
    models: [model('gpt-4.1', 'GPT-4.1', 1047576, 32768, 'https://developers.openai.com/api/docs/models/gpt-4.1')] },
  { id: 'anthropic', name: 'Anthropic / Claude', category: '国际官方', description: '使用 Anthropic API 密钥，不启用扩展思考。',
    keyUrl: 'https://platform.claude.com/', docsUrl: 'https://platform.claude.com/docs/en/models/overview',
    provider: { id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 120000 },
    models: [model('claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, 128000, 'https://platform.claude.com/docs/en/models/overview'), model('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 64000, 'https://platform.claude.com/docs/en/models/overview')] },
  { id: 'siliconflow', name: '硅基流动', category: '聚合平台', description: '使用硅基流动自己的密钥和模型标识。',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak', docsUrl: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
    provider: chat('siliconflow', 'https://api.siliconflow.cn/v1', 'SILICONFLOW_API_KEY'),
    models: [model('deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash', 1048576, 393216, 'https://siliconflow.cn/models')] },
  { id: 'openrouter', name: 'OpenRouter', category: '聚合平台', description: '使用 OpenRouter 密钥，模型名称包含厂商前缀。',
    keyUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs/quickstart',
    provider: chat('openrouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY'),
    models: [model('deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash', 1048576, 943718, 'https://openrouter.ai/api/v1/models', '按 OpenRouter 模型目录的 top_provider 上限；路由提供方可能有更低限制。')] },
  { id: 'opencode-go', name: 'OpenCode Go', category: '编程订阅', description: '使用 Go / Go Plus 密钥，选择模型后自动匹配其官方接口。',
    keyUrl: 'https://opencode.ai/auth', docsUrl: 'https://opencode.ai/docs/go/',
    provider: chat('opencode-go', 'https://opencode.ai/zen/go/v1', 'OPENCODE_API_KEY'),
    models: [goModel('deepseek-v4.1-flash','DeepSeek V4.1 Flash',1000000,384000),goModel('deepseek-v4-flash','DeepSeek V4 Flash',1000000,384000),goModel('deepseek-v4-pro','DeepSeek V4 Pro',1000000,384000),goModel('glm-5.3','GLM-5.3',1000000,131072),goModel('glm-5.3-flash','GLM-5.3-Flash',1000000,131072),goModel('kimi-k3','Kimi K3',1048576,131072),goModel('kimi-k2.7-code','Kimi K2.7 Code',262144,262144),goModel('mimo-v2.6-pro','MiMo V2.6 Pro',1048576,131072)] },
  { id: 'command-code-goat', name: 'Command Code GOAT', category: '编程订阅', description: '使用 GOAT 或其他含 API 权限套餐的密钥，选择模型后自动匹配其官方接口。',
    keyUrl: 'https://commandcode.ai/studio/', docsUrl: 'https://commandcode.ai/docs/plans/goat',
    provider: chat('command-code-goat', 'https://api.commandcode.ai/provider/v1', 'CMD_API_KEY'),
    models: [goatModel('deepseek/deepseek-v4.1-flash','DeepSeek V4.1 Flash',1000000),goatModel('deepseek/deepseek-v4-flash','DeepSeek V4 Flash',1000000),goatModel('deepseek/deepseek-v4-pro','DeepSeek V4 Pro',1000000),goatModel('moonshotai/Kimi-K3','Kimi K3',1000000),goatModel('zai-org/GLM-5.3','GLM-5.3',1000000),goatModel('z-ai/glm-5.3-flash','GLM-5.3 Flash',1048576),goatModel('MiniMaxAI/MiniMax-M3','MiniMax M3',1000000),goatModel('MiniMaxAI/MiniMax-M2.7','MiniMax M2.7',200000)] },
];
for(const preset of presets) {
  const directory=catalog.providers[preset.id]||[];
  const preferred=preset.models.map(model=>({...model,...directory.find(m=>m.id===model.id)}));
  preset.models=[...preferred,...directory.filter(model=>!preferred.some(m=>m.id===model.id))];
  preset.catalogReviewedAt=catalog.reviewedAt;
}
export function presetModelProvider(preset,model) {
  const provider={...preset.provider,...model?.provider};
  if(provider.protocol!==preset.provider.protocol)provider.id=preset.provider.id+(provider.protocol==='anthropic'?'-messages':'-responses');
  if(provider.protocol!=='openai-chat')for(const field of ['tokenLimitField','streamUsage','thinking'])delete provider[field];
  return provider;
}
export const normalizeBaseUrl = url => new URL(url).href.replace(/\/+$/, '');
export function providerPresets() { return structuredClone(presets); }
export function officialModelLimits(provider, modelId) {
  for(const preset of presets){const model=preset.models.find(m=>m.id===modelId&&m.limitsVerified!==false);if(!model)continue;const expected=presetModelProvider(preset,model);if(expected.protocol===provider.protocol&&normalizeBaseUrl(expected.baseUrl)===normalizeBaseUrl(provider.baseUrl))return model;}
}
export function desktopProviderHeaders(provider, sessionId) {
  const headers = {...provider.headers};
  if (['https://opencode.ai/zen/go/v1','https://opencode.ai/zen/go'].includes(normalizeBaseUrl(provider.baseUrl))) {
    headers['User-Agent'] = 'pi-desktop/0.1.0'; headers['x-opencode-session'] = sessionId;
  }
  return headers;
}
export function providerName(provider) { return presets.find(preset => preset.models.some(model=>{const expected=presetModelProvider(preset,model);return expected.id===provider.id&&normalizeBaseUrl(expected.baseUrl)===normalizeBaseUrl(provider.baseUrl);}))?.name ?? provider.id; }
