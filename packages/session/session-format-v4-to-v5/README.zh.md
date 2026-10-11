---
description: "通过 Session V4 到 V5 迁移恢复不透明的 Responses 检查点，并保留历史代际。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

[English](README.md) | 中文

## 概述

将受支持的 V4 Session 恢复为 V5，并保留后续模型请求所需的不透明 Responses 检查点。该相邻迁移保留事件身份与坐标，提升已审查的历史检查点扩展，并验证原生加密条目。它从不读取或改写文件；JSONL 持久化层会发布独立的当前代际后继文件。

## 目录

- [使用本包](#use-this-package)
- [V4 到 V5 规范](#v4-to-v5-specification)
- [原生 V5 接纳](#native-v5-admission)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

通过[静态 catalog](../session-format-catalog/README.zh.md) 完成恢复。直接导出供 catalog 组装和测试使用；本包没有 Cordis 挂载配置。仅 header 迁移将 `version: 4` 改为 `5`，保留其他所有已验证元数据。该操作不检查事件正文，也不发布文件。

完整恢复将每行流式传入独立 stage，并调用 `finish()`。部分输出不代表迁移成功。JSONL 只读访问可以直接返回转换后的产物而不发布文件；写访问则验证并独占创建当前后继文件，原有前驱保持不变。

<a id="v4-to-v5-specification"></a>
## V4 到 V5 规范

本迁移边保留获准事件的名称、id、顺序、时间戳、引用、surface 操作及继承截点，不添加事件。更早的格式先经过其现有相邻迁移边；V3 到 V4 仍按已接受的规则，将无法识别的 `compaction` 块命名为 `plugin:compaction`。

唯一的内容转换将 `plugin:compaction` 改为 `compaction`，前提是块只含 `type` 与 `item`，且条目类型为 `compaction` 或 `compaction_summary`，并含非空字符串 `encrypted_content`。条目的所有字段，包括未知嵌套元数据，都原样保留。不匹配的带前缀扩展仍保持不透明；格式错误的原生 `compaction` 块会被拒绝，而非被赋予猜测的含义。已有效的原生检查点保持不变。

只访问下列声明的内容位置：

- `user/message.data.content`
- `system/message`、`developer/message`、`assistant/message`、`tool/result` 与 `team/message/queued` 中的 `data.message.content`
- `agent/inbox/spliced.data.inserted` 与 `session/title-llm-request.data.messages` 中各条消息的 content
- `compaction/summary.data.summary` 及可选的 `rawOutput`
- `tool/ptc-dispatch.data.content`
- 内嵌 assistant message/attempt 流中的完整 `block-end` 值；匹配的 `block-start` 标签同步变更

不遍历工具参数、回放元数据、工具 schema、嵌套扩展值或无关事件载荷。目标恢复会拒绝未知必需事件；未知可忽略事件保留其载荷。转换期间不会执行插件或请求提供方。

源事件必须连续。seeded 产物中最终的 inherited `session/end-seed` marker 决定继承截点，且必须与传入的源截点一致；unseeded 产物不得包含该 marker。独立 stage 不共享计数器或可变状态。

源 V4 delivery marker 保留其代际，除非位于继承的父级前缀内，否则必须指向所属 Session。源 V4 marker 若声明目标代际 V5，则拒绝转换，防止 header 变化激活未经审查的 watermark。原生 V5 所有权检查只适用于 V5 marker；更早的 marker 保持为历史记录。

<a id="native-v5-admission"></a>
## 原生 V5 接纳

V5 codec 将未变更的行分帧和原生正文限制交由 V4 codec 处理。它在可恢复尾部处理之前验证已知的不透明检查点载荷，因此空密文或未知原生条目标签不能作为中断尾部被丢弃。与 V4 一样，可忽略的 developer 载荷会延后到已知已安装读取方的事件词汇后处理。

完整恢复保留 V4 的生命周期、来源、工具角色、系统消息、catalog 与引用验证，但 delivery 所有权绑定到 V5 header。已安装的当前 Session 验证负责普通信封与消息检查。原生读取方不提升带前缀扩展；该操作仅属于相邻迁移。

V4 读取方会拒绝 V5 header。保留的前驱可在明确隔离的旧运行时副本中作为回退材料，但不意味着可以忽略所选的更高代际或降级当前文件。新的 V5 写入不在这些前驱文件中。所选代际格式错误或来自未来时，绝不会回退。

<a id="understand-the-implementation"></a>
## 理解实现

迁移仅复制发生变化的检查点 wrapper。不透明条目及无关值保留其身份。[源码](src/index.ts)分别负责 header、codec、内容与 stage 验证；共享 V4 正文检查时不改变其原始代际的解释。

<a id="further-exploration"></a>
## 进一步探索

- [Session 格式协议](../session-format/README.zh.md)定义流式 stage 与失败传播。
- [V3 到 V4 迁移](../session-format-v3-to-v4/README.zh.md)负责工具角色和生产者来源转换。
- [JSONL 持久化](../session-persistence-jsonl/README.zh.md)负责不可变后继发布与代际选择。
- [LLM 流式处理](../../../docs/subsystems/llm-streaming.zh.md#native-responses-compaction)定义不透明检查点条目。

<a id="model-experience"></a>
## 模型体验

### 检查点回放

#### 模型看到的内容

受支持的 Responses 路由会接收原始 `compaction` 或 `compaction_summary` 条目（包括 `encrypted_content`），而非文本检查点包裹。迁移不提供提示词文本，也不解释加密内容。

#### Token 影响

迁移不会调用模型。回放保留的不透明条目时，由提供方决定其输入成本。

#### KV Cache 影响

迁移保留提供方条目及会话顺序，不生成或修改 cache 凭据。提供方实际的 cache 复用仍取决于路由。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅提升文档所述的检查点表示；无关的不透明扩展仍不作解释。
- 本库不提供降级路径或解密；不支持的模型路由仍会拒绝原生 Responses 检查点。

<a id="dev-note"></a>
### 开发备注

无。
