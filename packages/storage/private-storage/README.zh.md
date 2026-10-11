---
description: "为 Host 库调用方提供私有字节存储：保留 Windows NTFS 句柄、严格的仅所有者访问策略、原子发布回执与进程持有的写入锁。"
kind: "package-library"
---

# @deepseek-ai/dsh-private-storage

[English](README.md) | 中文

<a id="summary"></a>
## 概述

`dsh-private-storage` 提供同步私有字节读取、整文件原子发布、私有目录创建和进程持有的写入锁。Host 库与外部扩展可使用其不透明目录能力，而无需依赖沙箱或 Session 包。它仅接纳 Windows x64 上的字面本地 NTFS 路径，并要求精确、受保护且仅授予 TokenUser 的 DACL。记录格式、文本解码和崩溃恢复由调用方负责。本包不注册 Cordis 服务、模型工具或应用启动器。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

选择平台后端前调用 `capabilities()`。可用状态与原生二进制摘要描述当前进程；它们不表示文件系统已被接纳，也不能代替产物验收证据。非 Windows 主机与未测试的架构会报告不可用，且不加载 Windows DLL。

<a id="directory-and-byte-operations"></a>
### 目录与字节操作

`openPrivateDirectory(path, { create })` 按字面路径分量从盘符根目录逐级打开，并保留祖先保护句柄。现有根目录必须已经具备精确的私有安全描述符；本库不会修复权限。`create` 为真时，每个缺失层级分别发布，并在 `publications` 中提供独立回执。调用方必须信任祖先目录的所有者，不能期望本库跟随主目录或工作区中的联接点。

`openPrivateChild` 与 `createPrivateChild` 返回可独立关闭的目录能力。相对名称必须是单个字面分量：分隔符、备用数据流、保留设备别名、非法 UTF-16、尾随点或空格、短文件名别名以及仅大小写不同的拼写都会被拒绝。不支持区分大小写的目录和任何重解析标签。

`readPrivateFile` 要求显式字节上限，最大为 64 MiB，并返回未经解释的字节。它禁止共享写入，在有界读取前后通过同一句柄检查身份、大小、变更标记和私密性。文件必须恰有一个硬链接。`createPrivateFileExclusive` 以不替换方式发布完整初始化的内容；`replacePrivateFile` 仅替换已接纳的私有普通文件，或创建不存在的条目。不存在原地覆盖或基于路径的降级操作。发布中的源对象允许兼容的只读检查，但拒绝独立的数据写入和 DELETE 访问打开；发布及未发布对象的清理由其自身保留句柄执行。

<a id="publication-and-recovery"></a>
### 发布与恢复

每个发布回执独立报告 `publication`（`not-published`、`published`、`indeterminate`）、`durability`（`synced`、`unconfirmed`、`unsupported`）、完整源与父目录身份、阶段、原生状态及清理结果。重命名后刷新失败仍属于 `published/unconfirmed`。不确定的重命名仅通过只读检查协调；无法消除歧义时不会删除。`delete-pending` 表示已提交基于句柄的删除处置请求，而非其他打开句柄均已关闭的证明。

`PrivateStorageError.receipt` 保留发布后的失败结果。最终源句柄关闭出错时，已建立的 `published/synced` 事实仍会保留，`cleanup: 'failed'` 和 `cleanupFailed: true` 则表示无法确认释放结果。这些字段不证明句柄仍然存活；实现不会再次关闭这个内部句柄。若根目录打开流程在后续步骤失败，`directoryPublications` 会记录已经发布的祖先层级。内存回执无法在进程死亡后保留：持久事务记录与重启恢复仍由调用方负责。原子替换不提供对抗恶意写入者的比较并交换保证。

`synced` 的范围限于可信且符合规范的存储栈上，Windows/NTFS 文档规定的直写元数据与完整文件刷新行为。普通文件通过保留的直写源句柄重命名前后均执行刷新。空目录先通过自身直写句柄发布，再打开任何后代；其命名空间完成状态不宣称等同于 POSIX 目录 fsync 语义。杀死进程的测试不构成实际断电存活的实验依据。

<a id="leases-audit-and-cleanup"></a>
### 锁、审计与清理

实际写入进程必须在应用写入前调用 `acquirePrivateWriterLease(root, fixedName)`，并在整个写入期间保留返回的能力。发生竞争时立即失败。写入进程释放锁或退出时，内核持有关系才结束；监控进程不能释放其他进程的锁。固定锁文件应永久保留。PID 文本、文件年龄、信号量计数以及删除重建锁文件都不是锁归属机制。

`auditPrivateTree` 要求根目录上的有效锁及显式的总条目数和深度上限。每个后代都通过保留的父目录打开并检查；目录在遍历前以枚举权限重新打开并绑定完整身份。枚举不是快照，也不是永久安全证明。`removeOwnedEntry` 校验预期的完整身份，并通过该确切句柄删除；它不执行递归或路径名清理，也不承诺独立的崩溃持久删除。

应显式关闭能力。关闭和释放操作具有幂等性；关闭后的操作会被拒绝。子目录和锁独立保留所需的祖先句柄。终结器仅释放自身资源，绝不发布或删除。能力不能伪造、在线程间传递，也不能转换为 Node 文件描述符。

根入口与转发入口 `./streams` 共享同一个已安装提供方。流式发布每块最多 1 MiB，另设 1 GiB 文件上限；原字节 API 仍限 64 MiB。来源能力允许普通共享权限和多硬链接，但不授予私有目标写入权限。`openSourceFileReader` 要求独立预期摘要；`readSourceDocument` 为最多 64 MiB 的文档计算观察摘要。`openObservedSourceFileReader` 根据完整临时观察流式读取最多 1 GiB，仅在 EOF、观察未变、摘要完成且释放确认后返回 `verification: 'observed'`。

`openPrivateStreamRoot` 报告实际保留的父目录及创建回执，仅在已有父目录下创建最后一级，保留父目录安全属性。已有根目录的持久性为 `not-attempted`；新根目录的持久性取决于提供方实际完成的命名空间同步。Windows 发布回执中的身份必须与保留的根目录及父目录一致，才能确认绑定。`openSourceChild` 和 `listSourceDirectory` 保留来源权限并报告有界枚举中的所有名称。`inspectSourceLink` 返回不跟随目标的完整符号链接观察及原样目标，调用方仍须独立准入目标。Linux 从保留的链接描述符读取；Darwin 要求 macOS 13 或更高版本的 `freadlink`；Windows 拒绝不支持的重解析类型。枚举及重复观察均不承诺不可变快照。

<a id="understand-the-implementation"></a>
## 理解实现

Windows 操作使用 `node-addon-system` 0.1.3 中由环境拥有的 Node-API 8 载荷。句柄、令牌资源及临时缓冲区均在暴露给 JavaScript 前获取并登记。保留的操作包括 `NtCreateFile`、`NtSetInformationFile`、安全查询及 `LockFileEx`；Koffi 3.1.1 仍为独立原生夹具固定版本。无法确认的完成状态会隔离资源并拒绝后续操作，不启用任何令牌特权。进程仍存活时的真实 Worker 强制终止仍是必要原生验收。POSIX 流使用同一版本包族中的独立保留资源载荷。

- [`src/index.ts`](src/index.ts)：不透明能力生命周期、有界操作，以及发布和协调状态
- [`src/native.ts`](src/native.ts)：延迟原生载荷选择与保留句柄调用
- [`src/policy.ts`](src/policy.ts)：字面名称与有界、精确的安全描述符解码
- [`tests/native/acceptance.mjs`](tests/native/acceptance.mjs)：独立 SDK 校验程序与打包产物验收

<a id="further-exploration"></a>
## 进一步探索

- [存储子系统](../../../docs/subsystems/storage.zh.md)：领域存储职责
- [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)：原生相对打开与创建描述符
- [NTFS 缓存行为](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior)：限定范围内的直写元数据行为

<a id="model-experience"></a>
## 模型体验

无，因为这个面向字节的 Host 库不注册任何面向模型的内容。

<a id="kv-cache-effect"></a>
#### KV Cache 影响

本库不组装或发送模型请求。存储字节是否进入请求前缀由调用方负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 实现范围为 Windows x64 和本地、持久、可写的 NTFS。新增 macOS/Linux 流提供方有独立原生验收要求；Windows ARM64 在独立测试前不可用。远程、虚拟、只读、一次写入、WebDAV、终端服务、FAT/exFAT、ReFS 和未知后端都会被拒绝。
- 所属用户、可信祖先目录所有者、管理员、SYSTEM、内核及符合规范的存储驱动仍属于可信范围。本库无法认证每个微筛选器或硬件缓存。模拟其他身份和受限进程令牌会被拒绝。
- 本 API 仅用于严格仅所有者可访问的私有状态。保留刻意共享的已安装文件 ACL 属于另一种能力；调用方不得为编辑这类文件而放宽本接口的接纳策略。
- 验收使用同一套固定归档依赖，禁用安装脚本，固定 Koffi 与平台归档，并核对实际加载的原生二进制摘要。模拟 FFI 覆盖率、受阻的原生用例与未执行的平台均不能代替原生验收。

<a id="dev-note"></a>
### 开发备注

无。
