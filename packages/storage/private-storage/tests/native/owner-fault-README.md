# Native owner fault fixture

This test-only Node-API module includes the byte-pinned production Windows owner C translation unit with compile-time wrappers. It is source-instrumented native evidence, never execution of the packed production native binary. The driver executes the offline packed JavaScript against this module; packed Worker cleanup, security, sharing and inheritance checks remain separate mandatory requirements.

Build on Windows x64 with an installed Microsoft C compiler, Windows SDK and the already verified official Node SDK matching the running Node version:

```
pwsh -File workbench/private-storage-owner-fault.ps1 -OutputDirectory C:\evidence\owner-fault -NodeSdk C:\evidence\node-sdk\v24.19.0
node packages/storage/private-storage/tests/native/owner-fault-matrix.mjs --fixture C:\evidence\owner-fault\owner-fault-fixture.node --entry C:\consumer\node_modules\@deepseek-ai\dsh-private-storage\lib\index.js --oracle C:\evidence\private-storage-oracle.exe --report C:\evidence\owner-fault-report.json --source-sha <candidate-commit>
```

The compiler record binds the exact production source, instrumentation and imported helpers, compiler flags and binaries, included headers, resolved linker libraries, output module and compiler log. A changed source or missing input record refuses execution. The fixture exports only `createOwner`, `arm`, `report` and `reset`; reset disarms injection without clearing resource ownership, quarantine or protocol violations. Every case runs in an owned bounded subprocess, and independently checks synthetic files with the Windows SDK oracle before and after exit.

The 24 original directory/cleanup IDs and 27 original internal IDs remain required. A successful read/publish baseline establishes dynamic one-shot IDs for every observed native allocation and exposure ordinal. The original `alloc` IDs map to production `calloc`; the original `view` IDs explicitly map to `napi_create_buffer_copy` and `napi_create_external` result exposure. No native pointer view exists at that replacement seam. Allocation/exposure refusals are injected returns, not genuine allocator failures. These reviewed mappings must remain visible in reports.

Win32/NT wrappers forward real calls, then alter only a named completed return or owned output buffer. Pending cases inject pending return/completion fields after synchronous native completion. They verify finite waits, cancellation, refusal and retained quarantine without claiming a genuinely pending kernel operation. Directory dot-only pages must hit production's scanned-record bound before the external 64-query watchdog; reaching that watchdog fails the row. Cleanup-return faults follow a real release, retain the source owner's unconfirmed state and prohibit retrying that released resource.

Genuine deterministic kernel-release failure stays blocked. The original Koffi-free-failure ID stays blocked with not-applicable applicability and zero passes because Koffi free has no failure status. Missing SDK/native execution, unknown allocation counts and unsupported observations also remain blocked; they are never removed or treated as an empty passing inventory. A fully successful executable matrix still exits 2 with partial acceptance because the two original blocked requirements remain explicit.

Portable checks run with `node owner-fault-report.test.mjs <Node-headers-directory>`. Their synthetic-header C syntax check and report rejection tests establish no Windows SDK or native runtime passes. The source pin must be deliberately updated after reviewing a production change; an old preserved checkpoint must never be presented as the current candidate.
