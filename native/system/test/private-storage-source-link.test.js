/** Real retained symbolic-link observations on small owned fixtures; no destination or platform acceptance inference. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, lstatSync, statSync, rmSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
const binary = process.env.PRIVATE_STORAGE_TEST_BINARY ?? process.argv[2];
if (process.env.PRIVATE_STORAGE_REQUIRE_DESTINATION === '1') assert.ok(binary, 'Packed native source-link test requires an explicit binary');
test('retained link bytes, identities and parent facts remain distinct from their unresolved targets',
  { skip: !['linux', 'darwin'].includes(process.platform) || !binary, timeout: 10000 }, () => {
    const native = createRequire(import.meta.url)(resolve(binary));
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'source-link-'));
    let cap;
    try {
      mkdirSync(join(root, 'source')); writeFileSync(join(root, 'original'), 'untouched');
      symlinkSync('../original', join(root, 'source', 'bin'));
      cap = native.openDirectory(join(root, 'source'), 'source', false);
      const facts = native.inspect(cap), parent = statSync(root, { bigint: true });
      assert.equal(facts.parentBinding.before.ino, parent.ino.toString());
      assert.equal(facts.parentBinding.after.dev, parent.dev.toString());
      assert.deepEqual(facts.creationSync, { directory: false, parent: false });
      const result = native.inspectSourceLink(cap, 'bin', 32768), link = lstatSync(join(root, 'source', 'bin'), { bigint: true });
      assert.equal(Buffer.from(result.targetBytes).toString('utf8'), '../original');
      assert.equal(result.before.kind, 'symlink'); assert.equal(result.before.ino, link.ino.toString());
      assert.deepEqual(result.before, result.after); assert.equal(result.bindingVerified, true); assert.equal(result.released, true);
      assert.equal(readFileSync(join(root, 'original'), 'utf8'), 'untouched');
      assert.throws(() => native.inspectSourceLink(cap, 'bin', 2), error => error.code === 'EOVERFLOW');
      assert.throws(() => native.inspectSourceLink(cap, '../original', 32768));
      assert.throws(() => native.inspectSourceLink(cap, 'absent', 32768), error => error.code === 'ENOENT');
      writeFileSync(join(root, 'source', 'regular'), 'regular');
      assert.throws(() => native.inspectSourceLink(cap, 'regular', 32768), error => error.code === 'EINVAL');
      symlinkSync('../absent-target', join(root, 'source', 'dangling'));
      assert.equal(Buffer.from(native.inspectSourceLink(cap, 'dangling', 32768).targetBytes).toString(), '../absent-target');
      for (let index = 0; index < 100; index++) native.inspectSourceLink(cap, 'bin', 32768);
    } finally { if (cap) native.close(cap); rmSync(root, { recursive: true }); }
  });
