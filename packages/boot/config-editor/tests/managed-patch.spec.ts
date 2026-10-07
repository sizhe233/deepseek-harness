/** Raw native history must pass syntax and root validation before YAML mutation. */
import { expect, it } from 'vitest'
import { parseManagedPatch } from '../src/managed-patch.ts'

it.each(['- id: [', '- id: probe\n  config: { value: before }\n  config: { value: after }\n'])(
  'rejects malformed or ambiguous raw patch syntax: %s', (source) => {
    expect(() => parseManagedPatch(source)).toThrow()
  },
)

it.each(['{}', 'scalar', 'null', ''])(
  'rejects a non-sequence raw patch: %s', (source) => {
    expect(() => parseManagedPatch(source)).toThrow('Profile patch must be a YAML sequence')
  },
)

it('preserves a sequence document with comments, anchors and raw expressions', () => {
  const source = '# retained\n- &row\n  id: probe\n  config:\n    value: !!js "1 + 2"\n- *row\n'
  const document = parseManagedPatch(source)
  expect(document.contents.items).toHaveLength(2)
  expect(document.contents.flow).toBe(false)
  expect(String(document)).toContain('# retained')
  expect(String(document)).toContain('&row')
  expect(String(document)).toContain('*row')
  expect(String(document)).toContain('!!js')
})
