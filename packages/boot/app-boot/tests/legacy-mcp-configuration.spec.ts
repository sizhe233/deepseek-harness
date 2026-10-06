/** Legacy control-plane rows keep their saved edits across profile composition. */
import { describe, expect, it } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '../src/profile.ts'
import { migrateLegacyMcpConfiguration } from '../src/legacy-mcp-configuration.ts'

const BRIDGE = '@deepseek-ai/dsh-mcp-client'
const CONFIGURATION = `${BRIDGE}/configuration`

describe('legacy MCP configuration composition', () => {
  it('migrates the exact control mode while preserving unrelated configuration and input layers', () => {
    const patches: PatchOptions[] = [{ insert: [{
      id: 'mcp-control', name: BRIDGE,
      config: { mode: 'configuration', retained: { custom: true }, entries: { server: { env: { TOKEN: 'fixture-secret' } } } },
    }] }]
    const before = structuredClone(patches)
    expect(composeEntries([patches])).toEqual([{
      id: 'mcp-control', name: CONFIGURATION,
      config: { retained: { custom: true }, entries: { server: { env: { TOKEN: 'fixture-secret' } } } },
    }])
    expect(patches).toEqual(before)
  })

  it('accepts both legacy and standalone name guards on subsequent saved edits', () => {
    const base: PatchOptions = { insert: [{ id: 'control', name: BRIDGE, config: { mode: 'configuration' } }] }
    for (const name of [BRIDGE, CONFIGURATION]) {
      const patches: PatchOptions[] = [base, { id: 'control', name, config: { entries: { server: { args: ['new'] } } } }]
      expect(composeEntries([patches])).toEqual([{
        id: 'control', name: CONFIGURATION, config: { entries: { server: { args: ['new'] } } },
      }])
    }
  })

  it('leaves stdio and HTTP bridges and unrelated modules unchanged', () => {
    const patches: PatchOptions[] = [{ insert: [
      { id: 'stdio', name: BRIDGE, config: { transport: 'stdio', command: 'node' } },
      { id: 'http', name: BRIDGE, config: { transport: 'streamable-http', url: 'https://example.test/mcp' } },
      { id: 'other', name: '@fixture/other', config: { mode: 'configuration' } },
    ] }]
    expect(migrateLegacyMcpConfiguration(patches)).toEqual(patches)
  })

  it('migrates group children but retains explicit conversion to a normal bridge', () => {
    const group: PatchOptions = { insert: [{ id: 'group', name: 'cordis:group', group: true, config: [
      { id: 'nested', name: BRIDGE, config: { mode: 'configuration' } },
    ] }] }
    expect(composeEntries([[group]])[0]?.config).toEqual([{ id: 'nested', name: CONFIGURATION, config: {} }])
    const patches: PatchOptions[] = [group, { id: 'nested', name: BRIDGE, config: { transport: 'stdio', command: 'node' } }]
    expect(migrateLegacyMcpConfiguration(patches)).toEqual(patches)
  })
})
