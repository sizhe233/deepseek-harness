---
description: "dsh Web 客户端的「内置插件」设置分区：设置导航项与供功能插件注册标签页的标签行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugins

[English](README.md) | 中文

## 概述

使用**内置插件**设置分区查看本部署随附的插件。该分区只是一个壳：它拥有导航项和标签行，通过 `settings.plugins.tab` 接收功能插件的页面。宿主提供配置 Remote 时，本包贡献可编辑的 MCP 标签页；只读清单贡献另一个标签页。配置内置插件在侧栏的插件页上进行，每个官方插件自己的伴生包把页面注册到那里。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在设置里打开**内置插件**。[ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.zh.md) 贡献清单标签页。`remote.mcpConfiguration` 可用时，MCP 标签页支持编辑已配置的桥接条目。只有一个标签页时直接显示页面，多个标签页时显示标签行。组合里没有任何标签页贡献的部署会显示分区的空提示。

要贡献一个标签页，带 `id`、`order` 和本地化的 `label` 注册进 `settings.plugins.tab`；分区按序渲染条目，标签页在首次被选中时挂载。功能文案留在注册方自己的字典里。

### MCP 配置

展开 MCP 分组并选择条目，可编辑传输方式、服务名称、命令和参数或 HTTP 接口、工具调用超时、启用状态与重连策略。**保存**只提交修改的字段并重载该连接；**放弃修改**恢复最近的宿主投影。保存失败会保留草稿。已有环境变量和请求头的值只写不读：留空保留原值，移除一行才会清除它。只读部署会禁用编辑。

控制器在重新连接时保留最近加载的条目，并在读取失败后提供重试。更新按序执行并携带当前配置修订号，由宿主决定是否接受。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

分区声明 `settings.plugins.tab`，一个根级 list slot，其标签成为有序的标签页；只有一个贡献时直接渲染为页面本身，标签页在首次被选中后保持挂载，搜索词和清单快照因此在切换间不丢失。分区的 `inject` 把 slot 账本投影成按序排列、标签随当前语言的行，在账本版本或语言修订变化前保持缓存。宿主半侧是一个空的 `apply`，只为让本包占一条 Loader 行，客户端模块系统据此送出浏览器半侧。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.zh.md)——只读清单标签页。
- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.section` 的领域基座。
- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——配置官方插件的插件页。
- [ui-settings-shell](../ui-settings-shell/README.zh.md)、[ui-settings-agent-loop](../ui-settings-agent-loop/README.zh.md)、[ui-settings-subagent](../ui-settings-subagent/README.zh.md)、[ui-settings-web-search](../ui-settings-web-search/README.zh.md)——官方配置页，每个一个伴生包。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的设置界面，不注册任何模型面。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅编辑已有条目**——MCP 编辑器更新已配置的桥接条目；新增或删除 Loader 条目仍需修改 profile 配置。未提供 MCP 配置 Remote 的部署不显示该标签页。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
