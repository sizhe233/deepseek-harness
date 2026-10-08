/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, productIdentifierProblems, rescopeText } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

describe('rescope file selection', () => {
  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
  ])('keeps %s subject to upstream package-name checks', (file) => {
    expect(isRescopeExcluded(file)).toBe(false)
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})


describe('reviewed product identifiers', () => {
  const framework = ['cor', 'dis'].join('')
  const scoped = `@deepseek-ai/${framework}`

  it('requires the exact reviewed token count in the forward post-state', () => {
    const file = 'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx'
    const text = `import '${scoped}'; const preset = '${framework}'`
    expect(productIdentifierProblems(text, file)).toEqual([])
    expect(productIdentifierProblems(`import '${scoped}'`, file)).toEqual([
      `product identifier: ${file} has 0 occurrence(s) of "${framework}", expected 1`,
    ])
    expect(productIdentifierProblems(`${text}; const extra = '${framework}'`, file)).toEqual([
      `product identifier: ${file} has 2 occurrence(s) of "${framework}", expected 1`,
    ])
  })

  it('allows restored bare npm imports beside product identifiers during reverse checks', () => {
    const file = 'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx'
    const scopedText = `import '${scoped}'; const preset = '${framework}'`
    const reversed = rescopeText(scopedText, file, true)
    expect(reversed).toEqual({ text: `import '${framework}'; const preset = '${framework}'`, lines: 1 })
    expect(productIdentifierProblems(reversed.text, file, true)).toEqual([])
    expect(rescopeText(reversed.text, file, true)).toEqual({ text: reversed.text, lines: 0 })
    // Forward validation still rejects an unreviewed bare occurrence.
    expect(productIdentifierProblems(reversed.text, file)).toEqual([
      `product identifier: ${file} has 2 occurrence(s) of "${framework}", expected 1`,
    ])
  })

  it.each([
    'apps/web/tests/agent-preset-selection.e2e.ts',
    'apps/web/tests/developer-tools-settings.e2e.ts',
    'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx',
  ])('preserves the preset id without exempting other package subpaths in %s', (file) => {
    const before = `const preset = '${framework}'; import helper from '${framework}/helper'`
    const after = `const preset = '${framework}'; import helper from '${scoped}/helper'`
    expect(rescopeText(before, file)).toEqual({ text: after, lines: 1 })
    expect(rescopeText(after, file)).toEqual({ text: after, lines: 0 })
    expect(rescopeText(after, file, true).text).toBe(before)
  })

  it.each([
    'packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts',
    'packages/extensions/cordis-host-runner/tests/workbench-inspect-registry.spec.ts',
    'snapshots/session/cordis-inspect-liveness/client-fixture.mjs',
  ])('preserves inspect wire events but still checks imports in %s', (file) => {
    const before = `import '${framework}'; on('${framework}/inspect-query'); on('${framework}/inspect-query-resolved'); import '${framework}/new-api'`
    const after = `import '${scoped}'; on('${framework}/inspect-query'); on('${framework}/inspect-query-resolved'); import '${scoped}/new-api'`
    expect(rescopeText(before, file).text).toBe(after)
    expect(rescopeText(after, file).lines).toBe(0)
  })

  it('does not exempt a lookalike path or unreviewed wire event', () => {
    const input = `on('${framework}/inspect-query'); on('${framework}/new-event')`
    expect(rescopeText(input, 'snapshots/session/cordis-inspect-timeout/client-fixture.mjs').text)
      .toBe(`on('${framework}/inspect-query'); on('${scoped}/new-event')`)
    expect(rescopeText(input, 'snapshots/session/cordis-inspect-timeout/other.mjs').text)
      .toBe(`on('${scoped}/inspect-query'); on('${scoped}/new-event')`)
  })

  it('preserves documented preset names while still checking other package names', () => {
    const text = `Preset \`${framework}\` uses \`${framework}/helper\`.`
    expect(rescopeText(text, 'docs/user/guide/schedule.md').text)
      .toBe(`Preset \`${framework}\` uses \`${scoped}/helper\`.`)
    expect(rescopeText(text, 'docs/user/guide/other.md').text)
      .toBe(`Preset \`${scoped}\` uses \`${scoped}/helper\`.`)
  })
})
