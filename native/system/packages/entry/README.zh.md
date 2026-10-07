---
description: "预编译 Landlock 启动器与异步 POSIX flock 的 JavaScript 入口。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system

[English](README.md) | 中文

`./landlock-run` 入口导出 Landlock 启动器路径、强制执行探测、授权参数和协议常量。独立的 `./flock` 入口导出 `tryLockExclusive(fd): Promise<void>`；导入任一入口都不会加载 `system.node`。包不提供根导出。

锁操作异步尝试 `LOCK_EX | LOCK_NB`。在完成前保持调用方拥有的描述符打开；竞争以 `EAGAIN`/`EWOULDBLOCK` 拒绝，其他系统调用失败也会拒绝，错误携带 code、值为正数的 errno 和 `syscall: 'flock'`。原生调用准备阶段的错误也会拒绝同一个 promise。关闭指向该打开文件描述的最后一个描述符即释放锁。绑定不打开、复制、关闭或显式解锁描述符。

可选操作系统/CPU 平台包携带二进制。它们的 `~x.y.z` 依赖范围允许同一次版本内的后续补丁版本。Linux 包含 `bin/landlock-run` 和分别用于两种 libc 的 `bin/glibc/system.node` / `bin/musl/system.node`；macOS 包含 `bin/system.node`。flock 绑定缺失或无法加载时，锁获取请求会被拒绝，不在安装时编译。Landlock 仍是遵循既有失败关闭协议的独立可执行文件；不支持的内核或平台探测结果为不可用。

声明的原生 C 源文件随包分发以供审计。参见工作区[架构](../../docs/architecture.md)、[支持矩阵](../../docs/support-matrix.md)和 [CLI 约定](../../docs/cli-contract.md)。

独立的 `./private-storage` 入口导出 `loadPosixStoragePrimitives()` 及不透明目录/文件类型。导入按需进行；显式加载器要求新的平台专用 `private-storage.node`，绝不以 `system.node` 替代。[审查交接](../../docs/private-storage-review.md)说明源文件准入、私有策略、环境持有的描述符释放及未完成的原生验收。该能力不接受或返回原始描述符。在 macOS 上，ACL 准入要求保留描述符上的文件安全信息检查成功。私有目标要求空 ACL；可信祖先通过所有权和权限检查后可保留仅拒绝条目的 ACL。任何授权、未知标签或检查失败都会拒绝。

新增的 `./windows-private-owner` 入口导出 `loadWindowsPrivateOwner()` 和 `inspectWindowsPrivateOwnerRuntime()`。其 Windows x64 后继版本在向 JavaScript 暴露结果前持有所有原生文件、令牌、安全描述符及 I/O 资源，并负责 Worker 环境清理。返回的文件是不透明能力，不提供 HANDLE 访问器。仅导入入口不会加载二进制。运行时身份观察不等同于原生验收；缺少或不匹配的后继版本字节会被拒绝。
