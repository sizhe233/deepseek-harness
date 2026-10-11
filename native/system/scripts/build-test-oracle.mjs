/** Build the independent POSIX flock oracle used by native behavior tests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'linux' && process.platform !== 'darwin') {
  throw new Error('The flock oracle is a POSIX test fixture');
}
const { values } = parseArgs({ options: { 'host-libc-only': { type: 'boolean' } }, allowPositionals: false });
const hostLibc = process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl') : '';
const variants = values['host-libc-only'] ? [hostLibc] : process.platform === 'linux' ? ['glibc', 'musl'] : [''];
for (const variant of variants) {
  const compiler = variant === 'musl' ? 'musl-gcc' : 'cc';
  const output = path.join(root, 'test/bin', variant, 'flock-oracle');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
  if (process.platform === 'darwin') args.push('-mmacosx-version-min=11.0');
  if (variant === 'musl') args.push('-static');
  const result = spawnSync(compiler, [...args, path.join(root, 'test/fixtures/flock-oracle.c'), '-o', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${compiler} failed to build the flock oracle`);
  console.log(`Built test oracle ${path.relative(root, output)}`);
  const storageOracle = path.join(root, 'test/bin', variant, 'private-storage-syscall-oracle');
  const storageResult = spawnSync(compiler, [...args, path.join(root, 'test/private-storage-syscall-oracle.c'), '-o', storageOracle], { stdio: 'inherit' });
  if (storageResult.error) throw storageResult.error;
  if (storageResult.status !== 0) throw new Error(`${compiler} failed to build the retained-storage oracle`);
  console.log(`Built test oracle ${path.relative(root, storageOracle)}`);
  if (process.platform === 'linux') {
    for (const name of ['private-storage-read-fault', 'private-storage-directory-fault']) {
    const fault = path.join(root, 'test/bin', variant, `${name}.so`);
    const faultResult = spawnSync(compiler, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-shared',
      path.join(root, `test/${name}.c`), '-o', fault, '-ldl'], { stdio: 'inherit' });
    if (faultResult.error) throw faultResult.error;
    if (faultResult.status !== 0) throw new Error(`${compiler} failed to build the synthetic retained-read fault fixture`);
    console.log(`Built synthetic fault fixture ${path.relative(root, fault)}`);
    }
  }
}
