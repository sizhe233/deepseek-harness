/** OS observations of descriptors held by this owned test process. */
import { spawnSync } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';

/**
 * Locate descriptors referring to an owned fixture root or its entries.
 * @param {string} root The fixture directory owned by the current test.
 * @returns {string[]} Matching descriptor numbers from the current process.
 */
export function retainedFixtureDescriptors(root) {
  const belongs = (path) => path === root || path.startsWith(`${root}/`);
  if (process.platform === 'linux') {
    return readdirSync('/proc/self/fd').filter((fd) => {
      try { return belongs(readlinkSync(`/proc/self/fd/${fd}`)); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
  }
  if (process.platform !== 'darwin') throw new Error('Descriptor observation requires Linux or macOS');
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Required macOS descriptor-observation gate is unmet: ${result.error?.message ?? result.stderr.trim() ?? 'lsof failed'}`);
  }
  const descriptors = [];
  let descriptor = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('f')) descriptor = /^f\d+$/.test(line) ? line.slice(1) : null;
    if (descriptor !== null && line.startsWith('n') && belongs(line.slice(1))) descriptors.push(descriptor);
  }
  return descriptors;
}
