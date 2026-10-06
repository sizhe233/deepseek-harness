# Workbench 宿主分支

[English](README.md) | 中文

此公开 fork 保留官方 Git 历史。`workbench` 是维护分支；`upstream` 指向 deepseek-ai/deepseek-harness。初始导入基线为 dsh-v0.1.5-rc.1。精确导入版本和变化文件记录在 [compatibility.json](compatibility.json)；当前候选的审查记录位于 [upstream-compatibility.json](upstream-compatibility.json)。新的上游版本只是候选，不会自动升级生产。

## Agent 规则

创建 codex/<task> 分支，每个 PR 只处理一个明确范围。阅读 AGENTS.md 和两个 DSH 测试技能。在依赖命令、Git hooks 或 runner 之前确认它们可用。普通 Git/PR 工作流不需要 gh-stack。遵循上游最小本地检查策略；缺少 hooks 时显式执行 typecheck。禁止强推共享分支、为解决冲突丢弃本地功能，或削弱测试让同步通过。

每次同步均把本地补丁分类为保留、被等效上游实现替代、已适配或受阻。移除补丁前提供行为证据。依赖版本、Session 格式、认证、生命周期、公共 API 和补丁作用范围的变化需要明确的兼容审查。公开仓库不得包含私有插件、用户会话、凭据或本地部署记录。

构建后补丁步骤是对两个历史编译产物补丁的临时、受版本管理的兼容桥：可选的重启准入和图片中继。它只操作此检出的构建文件，拒绝未知结构，不修改已安装运行时。Agent 在升级时必须保留并测试这些行为；迁移至有类型的源码 API 属于单独审查的变更。

## CI 和同步

完整的构建后单元测试清单使用上游共享 runner 的 90 秒默认预算，并行 worker 数为两个；测试及产品显式指定的期限保持不变。macOS 还单独要求执行提供方的默认 shell 选择和真实交互式 zsh 会话通过验收，包括隔离启动文件、配置参数及退出清理。POSIX Agent 的 shell 仍为 Bash；PowerShell 检查覆盖可选 shell。

Fork CI 在 GitHub 托管的 Ubuntu 24.04 上完整构建项目，检查 Host 与 Client 类型、lint、包规范和文档，运行单元测试，执行上游覆盖率检查，并回放已录制的 Session/SDK 快照、构建后 CLI/进程预期，以及使用工作区固定版本 Chromium 的设置与计划浏览器验收。原生文件监听、子进程、终端和 V5 持久化检查分别在 macOS 15 与 Windows 2025 上运行；Linux、macOS 和 Windows 还必须执行专用的真实 PowerShell PTY 检查，`pwsh` 不可用时会失败；任何平台任务未成功，必需结果都会拒绝通过。CI 检出精确候选头部，使用可信基线修订校验归档笔记，并按该候选命名产物。它测试并应用两个可选运行时补丁，打包带精确哈希的 Host 与 Web 文件及[已核验的原生依赖记录](native-dependencies.json)；已核验原生源码或运行时文件变化、缺失时，打包会拒绝。这些任务定义所需证据，不代表某个候选已经通过。上游企业工作流在官方仓库条件保护下保留原有事件条件；不能假设个人账号拥有它们的 runner。任务不发布 npm，也不部署生产宿主。

Upstream sync 每天 UTC 02:23（Asia/Shanghai 10:23）运行，也可手动触发。可信脚本查询官方 master，创建唯一候选分支，通过 GitHub merge API 合并该精确上游 SHA。无冲突时创建草稿 PR 并显式触发 Fork CI；有冲突时创建去重的 Agent 任务 Issue，不发布强制重置或冲突标记提交，不覆盖既有候选。持有写 token 的任务不会执行候选代码。

目前尚未配置外部 Agent 执行器。Issue/PR 是交接契约，不代表 AI 已修复变更。选定执行器后，可用限定仓库的凭据领取任务并遵循这些规则。明确批准自动合并策略前，由所有者审查合并。

按 GitHub 策略，GITHUB_TOKEN 触发的 PR 检查可能需要批准。显式 workflow_dispatch 提供测试反馈，但不能替代必要的 PR 检查。合并前核对 PR 当前版本的检查。

<a id="acceptance-and-release"></a>
## 验收与发布

宿主 CI 通过不等于全部插件兼容。私有插件仓库必须测试同一候选提交，并在兼容 PR 审查通过前保留固定依赖基线。核验 Host/Client 加载、UI 入口、Session、附件和各个版本敏感补丁，明确记录缺少的证据。此 fork 的新构建是候选，不声明其整套产物与已安装运行时逐字节相同。

候选清单包含全部源码依赖补丁配方，记录原始 registry 完整性、补丁哈希与应用补丁后的精确文件哈希。消费方应用已安装依赖图中的每个配方并校验所有已安装副本；已打包进产物和仅构建使用的配方仍保留 registry 来源标识与缺席证据。未打补丁的 registry 依赖不等同于其已修补的源码版本。

生产服务、Profile、签名材料、已保存会话和模型路由不属于 Actions 的操作范围。部署需要单独批准和回滚计划。
