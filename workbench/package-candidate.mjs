import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
// pnpm pack consumes the package file manifest; never archive the checkout or Home.
mkdirSync('workbench-artifacts', { recursive: true });
execFileSync('pnpm', ['-r', '--filter', './packages/**', '--filter', './apps/**', 'pack', '--pack-destination', process.cwd() + '/workbench-artifacts'], { stdio: 'inherit' });
writeFileSync('workbench-artifacts/candidate.json', JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), productionApproved: false }, null, 2) + '\n');
