# Windows 原生私有存储验收

[English](README.md) | 中文

这些 fixture（测试前置数据）仅用于测试，内容通用且为合成数据。它们不会启用特权、修改系统安全设置、创建账户、注册服务、编译运行时原生扩展，也不宣称完成了断电测试。只应在唯一的临时根目录中运行。`acceptance.mjs` 会分配自己的根目录与隔离 Home；单独运行校验程序和 worker 命令时，必须提供调用方拥有的合成路径。

## 构建 SDK 校验程序

使用现有公开 Windows x64 runner、原生 PowerShell、Node 24 与已安装的 Microsoft C 编译器，无需 WDK 或下载工具链。

```powershell
$oracleDirectory = Join-Path $env:RUNNER_TEMP 'private-storage-oracle'
pwsh -File workbench/private-storage-native.ps1 -OutputDirectory $oracleDirectory
pwsh -File workbench/private-storage-sdk-matrices.ps1 -OutputDirectory $oracleDirectory
$oracle = Join-Path $oracleDirectory 'private-storage-oracle.exe'
& $oracle abi
& $oracle token
```

构建器选择已安装的 x64 编译器绝对路径，并记录编译器、开发环境脚本、源码、二进制与日志的身份。每个目标都在编译日志旁保留一个 `.cmd` 文件；PowerShell 只向 `cmd.exe` 传递该文件路径，开发环境设置或编译失败时，命令文件立即退出。主构建把 C 源码、可执行文件和编译日志的 SHA256 写入 `oracle-build.json`；`compiler.log` 包含 `cl /Bv` 与 Windows SDK 设置。`sdk-abi.json` 记录大小、对齐、偏移、指针宽度和有符号 NTSTATUS 的事实。`FILE_RENAME_INFO`、`FILE_BASIC_INFO` 与 `FILE_STANDARD_INFO` 是原生记录对应的 SDK 布局。SDK 未提供 WDK 的模式 typedef，因此校验程序使用其文档规定的单个 `ULONG Mode` 成员，并在 JSON 中记录这一区别。

```powershell
node packages/storage/private-storage/tests/native/verify-abi.mjs $oracle packages/storage/private-storage/src/abi.ts
```

此命令比较编译后的 SDK 与实际源码 FFI 偏移。它检查源码层 ABI，不构成打包消费者验收。仅依赖产物的工具包改为传入带摘要的 `abi.json`；该 JSON 从同一次构建的 `lib/types/abi.js` 生成一次，因此 Windows 消费者不会导入 Host 源码。

## 准备一套不可变原生依赖闭包

Koffi 3.1.1 及其 Windows x64、macOS arm64/x64、Linux x64 平台包的确切注册表归档只收集一次。辅助程序按 `pnpm-lock.yaml` 中的 SHA512 验证每个归档，记录归档 SHA256 和每个 `.node` 的 SHA256，拒绝不安全归档条目，且从不运行安装脚本或重新打包注册表归档。

```sh
node workbench/private-storage-closure-cli.mjs collect REPOSITORY_ROOT CANDIDATE_STAGING_DIRECTORY
```

可选的第四个参数指定存放相同确切归档的目录，文件名采用 `privateStorageClosurePlan()` 记录的名称。缓存字节也接受相同的完整性验证。`private-storage-native.json` 是父候选 manifest（元数据清单）的闭包描述符，其平台行初始状态为 `not-run`。

`materializePrivateStorageConsumer()` 接收 `artifactDirectory`、存储包的确切候选记录、闭包描述符、检出目录之外的全新 `destination`，以及 `additionalPackages`。所有必需的 peer 和传递依赖均须以同一候选清单中的确切归档记录提供，包括必需的 Cordis peer。仅包含存储包、Koffi 和平台包的文件夹不满足声明的依赖图。缺失或不匹配的依赖会使物化失败。物化过程不使用注册表、包管理器、生命周期脚本或开发者符号链接。

`smokePrivateStorageConsumer(consumer)` 在该文件夹中运行普通 Node，导入打包后的存储导出并独立加载 Koffi。它要求恰好选中一个摘要符合记录的原生二进制。Linux 和 macOS 检查导入与依赖选择，同时仅支持 Windows 的后端在这些平台报告不可用。此辅助程序禁止检出目录依赖链接；从文件系统隐藏检出目录需要另一个仅依赖产物的 CI 作业，物化器不宣称提供这种隔离。

## 运行构建后或打包后的行为验收

`--entry` 必须指向构建后的 JavaScript。打包验收应使用离线物化器返回的入口、每个 OS 作业中的同一存储归档、不可变候选 manifest，以及其确切源码提交。

```powershell
node packages/storage/private-storage/tests/native/acceptance.mjs `
  --oracle $oracle `
  --entry $consumerEntry `
  --output (Join-Path $env:RUNNER_TEMP 'private-storage-native.json') `
  --candidate-archive $storageArchive `
  --manifest $candidateManifest `
  --source-sha $candidateCommit
```

报告记录 Node、OS 构建版本、架构、令牌分类、文件系统事实、候选/源码/manifest/校验程序/原生二进制身份与逐项结果。退出码 1 表示失败。添加 `--require-complete true` 后，任一必需 x64 行受阻也会以退出码 2 结束。报告将未执行的断电测试和未测试的 ARM64 保留为 `out-of-scope`，将私有插件组合保留为 `separate-requirement`；它们均不计为通过。不使用该标志时，部分报告可退出为零，但受阻行仍是验收缺口。非 Windows 运行会报告 `nativeExecution: false`、零项原生通过，以及受阻的原生运行时行。校验程序缺失或原生原语失败绝不会转成 mock 通过。

## 组合的纯产物验收

打包运行器调用 loader 检查、两次 SDK 构建、独立 ABI 断言和四个独立行为矩阵。它保留每份失败或受阻的报告；即使某个矩阵失败，也会尝试其他独立且已接纳的矩阵。编译阶段被拒绝的产物不能通过后续构建重新获得资格；同一个固定 SDK 二进制身份贯穿 ABI 和全部行为检查。每次调用前后都会检查输入。

- `windows-primary.json`：原始字节/ACL/身份/锁/发布矩阵，始终使用 `--require-complete true`
- `windows-admission.json`：真实条件 ACL、内核对畸形描述符的拒绝、联接点/未知重解析、别名/大小写、管道/设备与现有只读卷接纳用例
- `windows-boundary.json`：确定性的保留句柄竞争、所属进程死亡阶段、真实分配/调用故障注入、SDK 继承对照与存活 Worker 的关闭/终止
- `windows-directory.json`：有界目录解析/查询，以及明确标记的清理返回值失败
- `windows-composite.json`：确切子用例映射、保留的原始占位项、原始报告字节、退出码、信号、超时与缺失义务
- `windows-native-suite.json`：全部前置结果和最终必需证据判定

四个矩阵的预算分别为 20、10、30 和 10 分钟。即使退出码看似成功，超时仍是失败；被中断或进程尚未关闭的报告会保留在磁盘上，但不被接受。后代进程清理结果不确定时，不会递归清理合成根目录。实证断电、Windows ARM64 和私有插件组合保留各自声明的范围；任何跳过或缺失的原生行都不会计为通过。

## 声明的验收范围

候选 manifest 将 `privateStorageAcceptance.claim` 绑定到 `ordinary-local-ntfs-private-bytes-v1`：Windows x64 上可写、持久、本地 NTFS 中的私有数据。求值器按这一声明检查独立观察到的根文件系统/设备事实。不支持的后端会以具体诊断被拒绝；该声明不承诺支持云、远程、虚拟或其他文件系统。现有 Linux/macOS 行为和私有插件组合仍是独立的合并要求。

完整展开清单保留在 `expandedEvidence` 中，包含原始报告、退出码、缺失行和原始受阻占位项。`expandedComplete` 独立报告这份清单。声明配置验收成功意味着所有适用要求均通过；`not-required-for-declared-use` 与 `not-applicable` 都贡献零项通过。实际失败、未知受阻行、无效报告、前置条件失败或必需用例不完整，始终阻止成功。未显式声明范围的默认严格求值器仍要求完整展开清单。

七个显式条件可由候选绑定的 `requiredConditions` 列表激活。它们涵盖可用且已授权的不支持卷、隔离的真实存储失败、实际卷挂载、真实云服务提供方、已授权远程卷、运行中可执行文件/映射映像替换，以及安全的真实内核释放拒绝 fixture。已执行的条件用例也会激活其要求。经过验证的只读已挂载驱动器清单会激活可用本地不支持卷的探测；清单缺失或自相矛盾不能证明条件未激活。不可读介质与未查询的远程映射会保留观察结果和限制，不会被称为不存在。不会自动配置账户、挂载、特权、远程认证或系统设置。

受限主令牌拒绝、全部 ACL/重解析/竞争/持久性/生命周期保证、实际存活 Worker 终止用例，以及每个已建模的分配/调用/清理故障均为必需。条件回调 ACL 测试也为必需；名称中的“条件”并不使它依赖环境条件。固定版本 Koffi 的 `free(value):void` 对有效且拥有的分配没有可恢复失败结果，因此对应的保留原始行被明确标记为 N/A。分配/视图所有权及由确切原生基线推导出的每个序号仍为必需。成功清理后注入失败返回值只证明状态记录，不证明真实内核拒绝。这些区分不意味着已测试实证断电或 Windows ARM64。

## 故障、竞争与 GC worker

`acceptance.mjs` 会自动调用这些 worker，也可针对另行准备的合成根目录和构建后入口单独运行以诊断。

```powershell
node packages/storage/private-storage/tests/native/fault-worker.mjs $consumerEntry $syntheticRoot short-write record.bin
node packages/storage/private-storage/tests/native/fault-worker.mjs $consumerEntry $syntheticRoot post-flush-failure record.bin
node packages/storage/private-storage/tests/native/fault-worker.mjs $consumerEntry $syntheticRoot rename-return-lost-unqueryable record.bin
node --expose-gc packages/storage/private-storage/tests/native/gc-worker.mjs $consumerEntry $syntheticRoot directories
node --expose-gc packages/storage/private-storage/tests/native/gc-worker.mjs $consumerEntry $syntheticRoot leases
```

故障 worker 在包首次延迟调用前包装同一个外部 Koffi 依赖。所有普通调用都到达真实 DLL；每个注入结果或异常都明确标注，并说明是否转发了原生调用。场景涵盖创建后首次写入前检查、短写入，以及写入/预刷新/重命名/后刷新/验证/关闭失败和重命名返回值丢失。只读协调区分已发布、未发布和真正不确定的结果。成功或可能成功的重命名绝不能收到删除处置请求。发布前清理报告 `delete-pending`，不保证对象已消失。最终源句柄关闭出错时，会保留已建立的 `published/synced` 事实，但报告 `cleanup: 'failed'` 与 `cleanupFailed: true`：释放未确认，而不是已知留下存活句柄。不会重试该源句柄。`close-failure` fixture 要求真实清理成功后才替换失败返回值，不能证明真实内核拒绝。

`creation-barrier` 和 `root-guard-barrier` 会输出 JSON 事件并等待标准输入中的一个字节。控制器独立检查刚创建的空文件，或尝试重命名除此之外为空且受保护的目录，然后放行 worker。手动运行任一场景却不提供该字节，会有意使 worker 持续等待。锁进程用例验证：杀死另一个监控进程不会释放写入者的锁，而实际写入者退出会释放；持久锁的身份保持不变。

GC worker 将显式关闭对照与丢弃 100 个目录或锁进行比较。它观察真实进程句柄数、转发的打开/关闭调用和分配/释放的底层缓冲区；跨事件循环轮次强制 GC，直到观察到释放或达到截止时间；禁止终结器调用命名空间操作；并在不删除锁对象的前提下重新获取每个锁。验收控制器独立重新打开每个结果锁文件，并检查身份与安全性。

## 原生 loader 拒绝 fixture

```powershell
node packages/storage/private-storage/tests/native/loader-negative.mjs $consumerRoot (Join-Path $env:RUNNER_TEMP 'loader-negative.json')
```

在主套件前针对已经验证的安装后消费者运行此检查，避免某个行为领域受阻使 loader 拒绝证据也无法执行。它克隆消费者，形成一个干净的 Windows 基线和四个负例：带可检测降级路径的已选二进制缺失/损坏，以及嵌套 `static.cjs` 层的平台遮蔽模块，该模块导出另一个对象或在写入标记后抛出异常。真实 loader 必须拒绝每个负例，不执行遮蔽模块、Koffi loader 入口或降级标记，也不创建请求的根目录。`.node` 扩展观察器转发真实 Node 加载，不模拟原生成功。只修改可丢弃的克隆。非 Windows 执行被明确标记为受阻。

## 十五领域证据记录

实现检查不等于检查已经执行。确切候选的结果 JSON 才是依据；须保留失败和受阻行。以下列出已实现的 fixture 与剩余缺口。所有新增 Windows fixture 的执行仍待完成；源码/可移植测试不能满足这些行：

1. ABI：编译后的 SDK 与实际 FFI 偏移比较；真实源句柄模式与身份观察。合成的待完成状态测试仍与原生完成证据分开
2. 身份/令牌：当前用户所有权、重启与 runner 分类；相对于匹配的可读对照，验证真实匿名外部令牌和同用户受限令牌被拒绝；验证同用户、匿名与受限线程模拟下公共 API 的拒绝。这些用例仍需原生执行。受限主进程接纳仍受阻
3. 创建时私密性：在宽权限父目录下创建，并在原生创建后首次写入前独立检查；在该屏障执行同样的真实匿名/受限拒绝检查。备用令牌设置失败仍明确记录为受阻
4. DACL：公开、null、空、缺失、继承、有序拒绝、对象及回调 fixture。若某种形式被 Windows 规范化，则该形式记为受阻；接纳矩阵已实现条件回调接纳，以及 OS 对无效 ACL/描述符提交的拒绝。仅解析畸形字节的测试仍单独记录
5. 不跟随链接：最终/中间/悬空符号链接和内部/外部硬链接。无符号链接权限时记为受阻；联接点和未知标签接纳 fixture 已实现；已挂载卷和云重解析 fixture 仍缺失
6. 竞争：确定性的空父目录保护与写入前屏障。边界矩阵实现叶节点替换、带重定位前后对照的保留中间父目录拒绝、阻止暂存名称替换并验证兼容的读取/SDK 检查、自身句柄发布及释放后的重命名对照、写入失败清理，以及规范 ACL 漂移
7. 边界：空内容、精确调用方上限、完整 64 MiB 上限、超限与无效上限。边界矩阵在保留读取屏障处尝试真实增长/截断/同尺寸写入者，并单独检查现有写入者。写入者无法获得访问权不等于建立了可变快照保证。原生管道/设备接纳另行执行
8. 名称：路径形式、ADS、设备、控制字符、畸形 UTF-16、大小写别名、尾随标点和有效 Unicode。现有短别名与调用方拥有的区分大小写目录 fixture 已实现；设置不可用时保持受阻，不启用文件系统功能
9. 发布：独占冲突、替换，以及允许或禁止共享删除时的新旧读取者。只读目标拒绝与遵守锁协议的发布者已实现；运行中映像 fixture 仍缺失
10. 持久性：观察直写源、相对原生重命名、同一源身份和两次文件刷新；明确标记的真实调用故障注入。补充分配/查询/读取/待完成/锁/目录/清理返回值故障矩阵已实现。注入返回值明确标记，真实内核存储/释放失败仍未证实；这不是断电测试
11. 目录：新建嵌套根目录、私有子目录发布与重新打开的身份。只有实际运行确切原生序列，才能接受 synced 回执
12. 崩溃恢复：监控进程退出后进程持有的锁仍存活，写入者退出后释放。七个真实所属进程终止阶段覆盖创建、写入、刷新和发布前后；进程死亡不能证明断电持久性
13. 资源：显式关闭、伪造能力拒绝、实际 GC 句柄/分配释放，以及不变的锁对象。实际跨 Worker 拒绝、存活 Worker 关闭/终止、带正向对照的 SDK 子进程继承和旧句柄复用已实现。真实 Windows 结果仍为必需；不会从源码测试推断生命周期保证
14. 不支持的环境：观察到的本地文件系统接纳。有界只读探测可使用已观察到且已挂载的本地不支持卷。环境用例不可用时保留其受阻原始证据，以及前述显式适用性判定
15. 打包消费者：确切归档闭包、必需依赖/peer 验证、独立导入和实际选中二进制摘要。仅依赖产物的平台作业必须建立最终候选验收；源码测试不能替代

Windows arm64 明确未经测试。任何架构都不继承另一个架构的结果。Linux/macOS 回归与消费者作业仍是这套仅针对 Windows 的行为套件之外的必需检查。突然断电需要另行适配的基础设施；此处不引入付费或特权 fixture。

## 可移植测试框架记录检查

```sh
node --test packages/storage/private-storage/tests/native/*.test.mjs workbench/private-storage-*.test.mjs
```

这些可移植测试验证报告接纳、子用例映射、参数处理和有界进程所有权。它们不贡献任何原生通过项。
