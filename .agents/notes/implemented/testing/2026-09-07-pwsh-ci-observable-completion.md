# Agent Note: PowerShell CI completion and profile expectations

Status: implemented

English | [中文](2026-09-07-pwsh-ci-observable-completion.zh.md)

## Problem

The [hosted coverage job](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34033367752/job/101605386802) rejects a persistent PowerShell send because it returns `inferred_idle` rather than `stdin_read`. Output silence is a supported bounded inference, not proof that a command finished. The real-shell test also searches output for text present in the echoed command, which cannot independently prove execution.

The [snapshot job](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34033367752/job/101605386868) rejects both PowerShell scenarios despite successful `PWSH_OK` output. Their fixtures omit the headless profile’s policy events and runtime-context message; their prompt and tool-schema pins also describe an older, smaller composition. Hosts without PowerShell skip these cases and cannot detect that drift.

The [fork post-merge job](https://github.com/sizhe233/deepseek-harness/actions/runs/37473792995/job/112303818124) rejects the UTF-8 encoding test because its settled viewport lacks the command’s output. The send result contains only bytes collected before settlement; startup acknowledgement does not guarantee that each subsequent command produces output before the silence bound.

## Decision

The [real-shell test](../../../../packages/terminal/terminal-bash/tests/local.spec.ts) accepts either supported readiness tier, rejects timeout and exit settlements, and observes formatted child output in scrollback to prove environment persistence, current directory, and credential scrubbing. The expected text is absent from the submitted command. A private-file barrier holds execution beyond the silence settlement and releases it only after the next send settles, proving that later output remains observable without extending production timings. Session disposal precedes removal of the private test directory.

The encoding probes also observe child-produced scrollback: both encoding names must be `utf-8`, and an ASCII-only character-code command must decode to `中文 encoding-ok`. Their file-gated variant acknowledges entry into each command, holds output until an `inferred_idle` settlement, verifies the expected token is absent, then releases execution. Neither token occurs in the submitted command. Closing the session must remove its registry entry and leave its process stopped.

The [one-shot](../../../../snapshots/session/pwsh-tool-turn/snapshot.yml) and [persistent](../../../../snapshots/session/persistent-pwsh-tool-turn/snapshot.yml) fixtures and owned header pins are refreshed through the built headless profile with a real PowerShell executable and recorded model replies. Policy events and available tools remain visible in the expectations; the tool result and final answer remain `PWSH_OK` and `DONE`.

## Alternatives considered

- Increase silence or handoff timeouts: this changes latency without making exact readiness deterministic. The [persistent-terminal decision](../feature/2026-07-16-persistent-pty-sessions.md) retains both exact and inferred outcomes.
- Accept either wait reason without observing execution: echoed input and delayed commands could falsely satisfy the test.
- Filter policy events or disable inherited headless tools: this hides the assembled profile instead of testing it. The [snapshot-corpus decision](2026-08-24-session-log-snapshot-corpus.md) keeps persisted output and header pins authoritative.

## Consequences

The file-gated case deterministically rejects the exact-only assertion, while the repaired test proves the command’s effects after an inferred settlement. The encoding variant rejects the old viewport-only assertion, an ASCII bootstrap pin, and a non-UTF-8 decoder. Real PowerShell is required for this evidence; a skipped local run is not validation. Focused built replay checks both Session output and header pins without normalizer changes. Production terminal behavior, timing configuration, and CI routing are unchanged.
