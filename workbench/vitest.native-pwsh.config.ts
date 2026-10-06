/** Required native PowerShell PTY acceptance, including Windows omitted by the upstream Bash lane. */
import { spawnSync } from 'node:child_process'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { resolvePwshPath } from '../packages/shell/pwsh-local/src/resolve.ts'
import { standardDecoratorPlugin, vitestExecArgv } from '../vitest.shared.ts'

const probe = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' })
if (probe.status !== 0) throw new Error(`Native PowerShell acceptance requires pwsh: ${probe.error?.message ?? probe.stderr}`)

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    pool: 'forks',
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-dom-environment.ts'],
    include: ['packages/terminal/terminal-bash/tests/local.spec.ts'],
    testNamePattern: 'terminal-bash pwsh real shell',
    testTimeout: 90_000,
    hookTimeout: 90_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
})
