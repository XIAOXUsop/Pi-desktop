# Pi-desktop

基于官方 Pi 的本地编程助手桌面应用。打开本机项目，选择模型，通过对话阅读代码、修改文件、运行命令并查看改动。

桌面使用 Electron，Pi 执行层在独立进程中运行。支持多家模型服务、Pi 扩展与 skill，以及独立的 `/plan` 和 `/goal` 工作流。

## 主要功能

- **项目与会话**：展开各项目的会话、搜索、重命名、置顶、归档和删除；切换项目不自动新建会话。
- **对话与执行过程**：最终回答独立显示，支持流式输出；中间说明、思考与工具调用整体折叠，可展开查看。
- **中断与诊断**：执行进程意外退出后，可查看未完成输出、核实待确认工具并继续任务；已确认的工具不会由恢复程序自动重放。默认诊断仅包含状态与用量，可在保存前预览。
- **文件撤销**：保存任务开始时的原始文件字节，支持新建、更新、删除文件的预览撤销和撤回撤销；任务后的人工改动会显示冲突，阻止覆盖。命令与插件造成的改动需手动选择。
- **文件与改动**：浏览项目文件、用 `@` 添加文件上下文、查看统一或双栏差异、复制消息与代码。
- **模型接入**：内置 11 家提供方预设，可搜索模型、配置密钥，也可接入自定义兼容服务。
- **Pi 资源**：按扩展、技能、提示模板和主题管理资源；支持本地、npm 和 Git 来源，以及市场浏览、启停和移除。
- **工作流与指令**：输入 `/` 补全 Pi 指令、插件命令和技能；使用 `/plan` 规划任务，使用 `/goal` 管理持续目标与预算。
- **桌面交互**：浅蓝色阅读界面、明暗主题、可调节侧栏与改动面板、命令面板和本地会话恢复。

## 使用 Windows 应用

安装版和免安装版均内置运行时，无需额外安装 Node.js 或 npm，打开时也不再编译源码。

| 发行文件 | 使用方式 |
| --- | --- |
| `Pi-desktop-Setup-0.1.4-x64.exe` | 双击安装，再从桌面或开始菜单打开 **Pi-desktop** |
| `Pi-desktop-0.1.4-Windows-x64.zip` | 完整解压后运行其中的 `Pi-desktop.exe` |

免安装版需要保留解压后的完整目录，不能只复制 exe。项目所需的 Git、Python、Java 等工具由项目环境提供。

仓库只保存源码和必要文件，安装包不放入 Git。下载 [0.1.4 预发布版本](https://github.com/XIAOXUsop/Pi-desktop/releases/tag/v0.1.4)，在 Assets 中选择安装版 exe 或免安装版 ZIP，并可使用同页 SHA256 校验文件。**Code → Download ZIP 下载的是源码，不能直接安装。** Windows x64 发行文件也可按下方步骤自行构建。

### 模型与密钥

在“模型与密钥”中选择提供方和模型，填写 API key。预设包括 DeepSeek、OpenAI、Anthropic、智谱 GLM、Kimi、通义千问、MiniMax、硅基流动、OpenRouter、OpenCode Go 和 Command Code GOAT。

“自定义接入”支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 协议。预设模型采用目录中的官方长度配置；未公布的输出上限与自定义型号可按实际服务能力设置。模型目录是随版本维护的快照，实际可用型号以服务商和账号权限为准。

Windows 用户或系统环境变量中的 `DEEPSEEK_API_KEY` 会自动读取。也可在设置中输入并加密保存密钥；已有密钥不会在界面回显。

### 开始任务

1. 打开本地项目，选择或新建会话。
2. 选择模型，输入任务。Enter 发送，Shift + Enter 换行。
3. 需要编辑文件时启用“修改文件”，需要执行构建或测试时启用“运行命令”。
4. 在执行过程中查看步骤，在改动面板审阅文件差异；可停止任务或发送插话。

新配置默认只读。工具权限开关控制模型的文件与命令工具；Pi 扩展本身运行本机代码，不受这些开关隔离。

### 文件撤销与中断恢复

打开右侧“改动”，选择最近一次修改任务并点击“撤销文件修改”，核对文件后确认。仅可直接撤销当前分支最近一次有修改的任务。默认单文件 16 MiB、单任务 128 MiB、总容量 512 MiB，保留 20 个任务；可在面板的“保存设置”中调整或保留某个检查点。密钥、依赖与未跟踪的构建产物默认排除；范围不完整时会显示原因。

检查点保存在项目 `.agent/checkpoints/`，不会提交到 Git。它覆盖已记录的文件范围，不能恢复数据库、联网操作等外部副作用。

中断后不会自动发送模型请求。点击“继续任务”前，应核实结果待确认的工具与命令。目标存在未知用量时会暂停预算恢复；不会把未知用量清零。

撤销过程中退出应用时，重新打开原会话，在“改动”中选择继续撤销或恢复到撤销前。处理完成前会阻止新任务。

### 规划与持续目标

```text
/plan 分析这个项目并制定重构计划
/goal 修复登录问题并通过相关测试 --tokens 50k
```

`/plan` 先进行只读规划，确认后执行。`/goal` 跟踪目标、累计预算和完成证据，支持状态查询、暂停与恢复；重新载入会话后需显式恢复目标。这两项以内置 Pi 扩展提供，可分别停用。

| 快捷键 | 操作 |
| --- | --- |
| Ctrl+K | 打开命令面板 |
| Ctrl+O | 打开项目 |
| Ctrl+N | 新建会话 |
| Ctrl+P | 添加项目文件上下文 |
| Ctrl+B | 显示或隐藏侧栏 |
| Ctrl+L | 聚焦输入框 |
| Ctrl+. | 停止任务 |

## 从源码开发

需要 Node.js **22.19.0 或更新版本**、npm，以及 Git。当前桌面打包和安装验收使用 Windows x64 环境。

```powershell
git clone https://github.com/XIAOXUsop/Pi-desktop.git
cd Pi-desktop
npm ci
npm run desktop
```

不调用外部模型的桌面演示：

```powershell
npm run desktop:demo
```

独立 TypeScript 核心和 CLI 也保留在仓库中，可运行 `npm run demo` 验证真实文件工具的离线闭环。

### 检查启动耗时

```powershell
npm run desktop:benchmark -- --development
# 构建安装包后，测量真实打包程序：
npm run desktop:benchmark
```

基准使用隐藏窗口和隔离配置，复制当前会话进行恢复，不操作原项目、不发送模型请求。结果位于本地 `.agent/verification/startup/`，分别记录窗口加载、环境密钥读取、会话恢复和对话就绪时间。支持 `--runs=5`、`--empty`、`--missing-project`、`--interrupted` 和 `--many-checkpoints`；后两项需要当前项目已有保存的会话。

## 构建 Windows 安装包

在 Windows 开发环境执行：

```powershell
npm ci
npm run package:win
```

此命令构建核心、生成应用图标、准备内置 Node/npm、生成独立应用并进行运行检查，检查通过后创建安装程序和 ZIP。发行文件位于 `release/`；该目录不会提交到 Git。

打包使用开发环境中的 Node/npm 发行目录，并下载对应 Node 版本的许可文件；首次安装依赖和获取构建工具需要网络。

```powershell
# 单独验证已构建的应用
npm run package:verify

# 安装到当前用户目录；首次安装可复制本工作区的开发配置
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop.ps1
```

当前未配置 Windows 代码签名证书，也未实现自动更新。

安装升级验收脚本 `scripts/verify-installation.ps1` 使用测试生成的配置副本，验证旧版安装、升级、密钥解密、会话与扩展状态保留、卸载保留数据。默认要求没有注册 Pi-desktop 安装的 Windows 测试账号；使用 `-IsolateExistingRegistration` 可临时改名备份这款应用的两项当前用户登记，测试后恢复登记和同名快捷方式，保留原安装目录。系统级安装仍会被拒绝。使用 `-FixtureProfile <桌面测试配置目录>` 指定全量桌面测试创建的配置。

## 测试

```powershell
npm run check        # TypeScript 类型检查
npm test             # TypeScript 核心测试
npm run test:desktop # 桌面相关模块测试
npm run test:all     # 完整离线测试、覆盖率和真实 Electron 窗口验收
```

完整桌面验收在 Windows 环境运行，默认不需要模型密钥。`npm run test:all:live` 另发送真实 DeepSeek 请求，需要可用密钥并会消耗 API 额度。

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 安装版配置、加密密钥和 Pi 资源 | `%APPDATA%\Pi-desktop` |
| 开发版配置 | 项目根目录下的 `.agent/desktop-profile` |
| 各项目的会话、改动记录和快照 | 对应项目的 `.agent` 目录 |
| 构建产物 | `release/` |
| 本地测试报告与截图 | `.agent/verification` |

卸载保留用户数据。密钥、本机配置、会话、依赖和构建产物均排除在版本管理之外。

## 源码结构

| 路径 | 内容 |
| --- | --- |
| `desktop/` | Electron 主进程、Pi 执行桥接、设置与资源管理 |
| `desktop/ui/` | 对话界面、模型选择、命令补全、改动审阅和主题 |
| `packages/pi-workflows/` | `/plan` 与 `/goal` Pi 扩展 |
| `src/` | 独立 TypeScript 编程助手核心、CLI、模型协议和文件工具 |
| `test/` | 单元、集成及回归测试 |
| `scripts/` | 开发启动、测试、打包与安装脚本 |
| `configs/` | 不含密钥的默认模型配置 |

## 第三方资源

官方 Pi 依赖通过 npm 安装。提供方图标的许可与来源保留在 [provider-logos.LICENSE](desktop/ui/provider-logos.LICENSE) 和 [provider-logos.NOTICE.md](desktop/ui/provider-logos.NOTICE.md)。

## 测试与评测

`npm run test:all` 运行离线回归、真实 Electron 界面与中断恢复/撤销检查，不发送模型请求。Windows CI 使用锁文件安装并执行同一套检查；候选发行包额外验证官方 Pi 插件、内置运行时、恢复、撤销与命令清理。

`npm run eval:offline` 检查 20 个公开生成任务的初始失败。配置 Python 路径 `EVAL_PYTHON` 后可执行 Python 任务；Java 任务需要 JDK。`npm run eval:live -- --pilot` 先运行三个任务；完整评测使用 DeepSeek，支持 `--baseline=<源码目录>` 比较基线，默认重复三次，单次执行预算上限 300 万 token。需配置 `DEEPSEEK_API_KEY`；未知用量保留预算预留，不作为零消耗处理。使用 `EVAL_TOKEN_BUDGET` 设置本次可用额度，跨多次执行时应扣除之前用量；`--resume=<评测目录>` 仅补跑缺失任务，必须沿用该目录的原预算。`--only=<任务ID>` 可进行针对性补测。报告和轨迹仅保存在本地 `.agent/evals/`，`scripts/summarize-evals.mjs <ledger.json>` 可离线核对验收、回答延迟、工具耗时和有效文件哈希。

当前 Windows 发行包未进行代码签名。卸载保留本机配置和项目会话；删除会话不删除项目文件。
