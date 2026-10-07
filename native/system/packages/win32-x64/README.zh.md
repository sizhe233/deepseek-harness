---
description: "预编译的 Windows x64 环境托管存储资源所有者。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system-win32-x64

[English](README.md) | 中文

此平台包包含 `bin/windows-private-owner.node`，即由 `@deepseek-ai/node-addon-system/windows-private-owner` 按需选择的稳定 Node-API8 资源所有者。它没有安装期编译或回退机制。精确的后继版本二进制必须先在 Windows 上构建并验证，之后才能打包；元数据本身不代表原生验收。此包不提供 Landlock 或 POSIX flock。
