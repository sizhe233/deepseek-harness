---
description: "为 Linux 进程隔离与 POSIX 会话写锁提供预编译系统原语。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system

[English](README.md) | 中文

## Summary

使用 Linux `landlock-run` 可执行文件限制子进程，或通过 `./flock` 入口获取 POSIX 写锁。平台包包含预编译二进制；消费方安装时不会构建原生代码。Landlock 策略与会话生命周期仍由调用方负责。

## Table of Contents

- [使用](#use)
- [支持范围](#support)
- [开发](#development)

## Use

`@deepseek-ai/node-addon-system/landlock-run` 为 Landlock 导出 `launcherPath`、`probe` 和 `grantArgs`。其可执行文件名、参数和失败语义由 [CLI 约定](docs/cli-contract.md) 定义。

[flock 行为约定](docs/flock-contract.md) 将描述符、进程和咨询式锁语义对应到独立原生测试。

`@deepseek-ai/node-addon-system/flock` 导出 `tryLockExclusive(fd): Promise<void>`。在调用完成前保持描述符打开。获取操作使用非阻塞独占 flock；发生竞争时，返回的 Promise 会以 `EAGAIN` 或 `EWOULDBLOCK` 拒绝，关闭该打开文件描述的最后一个描述符即释放锁。参见[入口 README](packages/entry/README.zh.md)。

独立的 `./private-storage` 入口按需加载 `private-storage.node`，提供保留句柄、禁止跟随链接的源文件与私有目标原语。它不扩展 flock 的描述符所有权或 Landlock 策略。[审查交接](docs/private-storage-review.md)记录支持范围和未完成的原生验收。

导入任一入口都不会加载 addon。Landlock 可执行文件缺失时探测为不可用；flock 绑定缺失时拒绝获取。两条路径都不会进行编译，也不会静默允许不受支持的行为。

## Support

Linux x64/arm64 包包含静态 Landlock 可执行文件，以及分别用于 glibc/musl 的 `system.node` 和 `private-storage.node` 文件。macOS x64/arm64 包包含这两种 addon。Landlock 还需要支持强制执行的 Linux 内核；Windows 使用 Harness 既有锁实现。[支持矩阵](docs/support-matrix.md) 指定构建者与验证负责人。

## Development

在本目录运行 `pnpm build:ts` 构建入口、`pnpm build:native` 构建当前宿主声明的原生产物、`pnpm build:test-oracle` 构建独立的 flock 系统调用 fixture（测试前置数据）。随后用 `pnpm test` 验证入口、锁、打包及可用的内核行为。Linux 完整构建需要 musl-gcc；macOS 使用 cc。根目录 `pnpm run build:native-system` 只构建源码测试所需的当前宿主 addon。

[架构](docs/architecture.md)、[打包](docs/packaging.md)和[发布流程](docs/release.md)分别负责实现与发布细节。

### Dev Note

无。


## Windows resource owner (0.1.3 successor)

`@deepseek-ai/node-addon-system/windows-private-owner` 按需加载精确的 Windows x64 Node-API8 平台包。它只暴露由原生环境持有的不透明能力，不暴露 HANDLE 或指针。缺少后继版本二进制时会拒绝，不会在安装时编译，也不会退回 0.1.2。原有 Landlock/flock 入口保持其行为。实际 Windows 编译和 Worker 生命周期验收仍为必需检查，源代码或格式检查不能替代。

Windows 构建机通过 `node scripts/prepare-windows-node-sdk.mjs` 准备当前官方 Node 头文件与 `node.lib`，使用同一版本的官方 SHA256 清单验证两者，再在 x64 Windows SDK 编译环境中执行 `pnpm build:native --node-sdk <verified-directory>`。仅构建期使用的可选 `NATIVE_SYSTEM_NODE_SDK` 可提供同一目录。运行时二进制选择不会读取该变量。
