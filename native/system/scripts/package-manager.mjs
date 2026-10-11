/** Shell-free invocation of the installed package managers used by native pack rehearsals. */
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';

export function packageManagerInvocation(name, args, environment = process.env, platform = process.platform) {
  if (name !== 'npm' && name !== 'pnpm') throw new Error('Unknown native packaging tool');
  if (platform !== 'win32') return { command: name, args };
  const candidates = name === 'npm'
    ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
    : [environment.npm_execpath, environment.PNPM_HOME && join(environment.PNPM_HOME, 'node_modules/pnpm/bin/pnpm.cjs')];
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    candidates.push(join(directory, name === 'npm' ? 'node_modules/npm/bin/npm-cli.js' : 'node_modules/pnpm/bin/pnpm.cjs'));
    if (name === 'pnpm') candidates.push(join(directory, 'pnpm.cjs'), join(directory, 'pnpm.mjs'), join(directory, '../pnpm/bin/pnpm.cjs'));
  }
  for (const candidate of candidates) {
    if (!candidate || !['.js', '.mjs', '.cjs'].includes(extname(candidate)) || !existsSync(candidate)) continue;
    const file = realpathSync(resolve(candidate));
    if (name === 'pnpm' && !/[/\\]pnpm\.(?:c?js|mjs)$/.test(file)) continue;
    return { command: process.execPath, args: [file, ...args] };
  }
  throw new Error(`Native packaging requires the installed ${name} JavaScript entry; command-shell fallback is unavailable`);
}
