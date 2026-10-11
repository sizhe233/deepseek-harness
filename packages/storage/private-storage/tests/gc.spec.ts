import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// This non-Cordis OS fixture uses direct erasable TypeScript under docs/testing.md's subprocess exception.
describe('garbage collected private capabilities', () => {
  it.each(['directory', 'lease'])('releases dropped %s handles using the actual factories', (kind) => {
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/gc-worker.mjs', import.meta.url)), kind], {
      encoding: 'utf8', timeout: 25_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ kind, handles: 0, explicitClose: true, collected: true })
  })
})
