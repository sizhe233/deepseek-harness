/** Prepare only the current official Node SDK; this build helper never runs at package install. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { downloadNodeSdk } from './download-node-sdk.mjs';

assert.equal(process.platform, 'win32', 'The Windows SDK preparation runs only on its native builder');
assert.equal(process.arch, 'x64');
assert.match(process.version, /^v\d+\.\d+\.\d+$/);
const parent = resolve(process.argv[2] ?? '.release/node-sdk');
const target = join(parent, process.version);
const base = `https://nodejs.org/dist/${process.version}/`;
await mkdir(target, { recursive: true });
async function download(name, limit) {
  return downloadNodeSdk(new URL(name, base), limit);
}
const sums = await download('SHASUMS256.txt', 1024 * 1024);
const records = new Map(sums.toString('utf8').trim().split('\n').map(line => {
  const match = /^([a-f0-9]{64})  (\S+)$/.exec(line.trim()); assert.ok(match); return [match[2], match[1]];
}));
const archive = `node-${process.version}-headers.tar.gz`, library = 'win-x64/node.lib';
const receipt = { version: process.version, architecture: process.arch, source: base, files: [] };
for (const [name, filename, limit] of [[archive, 'headers.tar.gz', 32 * 1024 * 1024], [library, 'node.lib', 32 * 1024 * 1024]]) {
  assert.ok(records.has(name), `Official checksum list lacks ${name}`);
  const bytes = await download(name, limit), sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, records.get(name), `Official SDK checksum differs for ${name}`);
  await writeFile(join(target, filename), bytes, { flag: 'wx' }); receipt.files.push({ name, sha256, bytes: bytes.length });
}
const tar = spawnSync('tar.exe', ['-tzf', join(target, 'headers.tar.gz')], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
assert.equal(tar.error, undefined); assert.equal(tar.status, 0, tar.stderr);
const prefix = `node-${process.version}/`;
for (const name of tar.stdout.trim().split(/\r?\n/)) {
  assert.ok(name.startsWith(prefix) && !name.includes('\\') && !name.includes('\0') && !name.split('/').includes('..'), 'Unexpected official SDK archive path');
}
const extracted = spawnSync('tar.exe', ['-xzf', join(target, 'headers.tar.gz'), '-C', target], { encoding: 'utf8', timeout: 30000 });
assert.equal(extracted.error, undefined); assert.equal(extracted.status, 0, extracted.stderr);
await rename(join(target, `node-${process.version}`, 'include'), join(target, 'include'));
assert.ok((await readFile(join(target, 'include/node/node_api.h'))).length > 0);
await writeFile(join(target, 'verified.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(target + '\n');
