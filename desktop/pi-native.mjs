// The package's terminal modules are not public subpath exports. Resolve them from
// the fixed SDK version so the desktop uses the same command catalogue and helpers.
export const piModule = path => import(new URL(path, import.meta.resolve('@earendil-works/pi-coding-agent')));
export const {BUILTIN_SLASH_COMMANDS} = await piModule('core/slash-commands.js');
export const {serializeSessionBranch} = await piModule('core/session-export.js');
export const commandDescriptions = {
  settings:'模型与密钥设置',model:'选择模型',tree:'浏览会话历史',thinking:'选择思考强度',
  'scoped-models':'选择模型切换范围',export:'导出会话为 HTML 或 JSONL',import:'导入 Pi JSONL 会话',
  share:'分享当前会话',bug:'生成 Pi 问题报告',copy:'复制最近一条回答',name:'重命名当前会话',
  session:'查看会话统计',changelog:'查看 Pi 更新记录',hotkeys:'查看快捷键',fork:'从历史任务创建新会话',
  clone:'复制当前会话',trust:'管理项目资源信任',login:'配置提供方认证',logout:'移除保存的提供方认证',
  new:'新建会话',compact:'压缩上下文',resume:'恢复已有会话',reload:'重新加载 Pi 资源',quit:'退出客户端',
};
export const piBuiltinCommands = BUILTIN_SLASH_COMMANDS.map(c=>({...c,command:'/'+c.name,source:'builtin',description:commandDescriptions[c.name] || c.description}));
