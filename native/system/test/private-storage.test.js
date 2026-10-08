/** Real retained native resources on owned small fixtures; unsupported destinations stay refused. */
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { retainedFixtureDescriptors } from './private-storage-fd-observer.js';

const posix = process.platform === 'linux' || process.platform === 'darwin';
const libc = process.platform === 'linux'
  ? `${process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'}/`
  : '';
// This explicit test-only path never changes runtime binary selection.
const binary = process.env.PRIVATE_STORAGE_TEST_BINARY
  ? resolve(process.env.PRIVATE_STORAGE_TEST_BINARY)
  : fileURLToPath(new URL(`../packages/${process.platform}-${process.arch}/bin/${libc}private-storage.node`, import.meta.url));
const native = posix ? createRequire(import.meta.url)(binary) : null;
const fixture = new URL('./private-storage-worker.js', import.meta.url);
const syscallOracle = process.env.PRIVATE_STORAGE_TEST_ORACLE
  ? resolve(process.env.PRIVATE_STORAGE_TEST_ORACLE)
  : fileURLToPath(new URL(`./bin/${libc}private-storage-syscall-oracle`, import.meta.url));
const readFault = process.env.PRIVATE_STORAGE_TEST_READ_FAULT
  ? resolve(process.env.PRIVATE_STORAGE_TEST_READ_FAULT)
  : fileURLToPath(new URL(`./bin/${libc}private-storage-read-fault.so`, import.meta.url));
const options = { skip: !posix, timeout: 30_000 };

function scope(t) {
  // Darwin's OS temporary location may contain the /var -> /private/var alias.
  const root = mkdtempSync(join(realpathSync(process.env.PRIVATE_STORAGE_TEST_ROOT ?? tmpdir()), 'node-addon-private-storage-'));
  chmodSync(root, 0o700);
  const caps = [];
  t.after(() => {
    for (const cap of caps.reverse()) native.close(cap);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, keep(cap) { caps.push(cap); return cap; } };
}

function systemError(codes) {
  return (error) => {
    assert.ok(codes.includes(error.code), `Unexpected ${error.code}: ${error.message}`);
    assert.ok(Number.isInteger(error.errno) && error.errno > 0);
    assert.equal(typeof error.syscall, 'string');
    assert.equal(typeof error.renameAttempted, 'boolean');
    return true;
  };
}

function compareFacts(facts, path) {
  const stat = statSync(path, { bigint: true });
  for (const name of ['dev', 'ino', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) {
    assert.equal(facts[name], stat[name].toString(), name);
  }
  assert.equal(facts.mode, Number(stat.mode));
  assert.equal(facts.bindingVerified, true);
  assert.equal(typeof facts.filesystem.readOnly, 'boolean');
  assert.equal(typeof facts.filesystem.fsid, 'string');
  assert.equal(typeof facts.acl.supported, 'boolean');
}

function privateDirectory(t, resources) {
  try { return resources.keep(native.openDirectory(resources.root, 'private', false)); }
  catch (error) {
    if (error.code !== 'ENOTSUP') throw error;
    assert.notEqual(process.env.PRIVATE_STORAGE_REQUIRE_DESTINATION, '1', 'Required persistent local destination is not available');
    t.skip('Private destinations require an admitted persistent local filesystem');
    return null;
  }
}

test('readonly shared sources and ordinary hardlinks preserve complete observations', options, (t) => {
  const s = scope(t);
  chmodSync(s.root, 0o755);
  const path = join(s.root, 'source');
  writeFileSync(path, 'abcdef', { mode: 0o444 });
  linkSync(path, join(s.root, 'hardlink'));
  const before = statSync(path, { bigint: true });
  const parent = s.keep(native.openDirectory(s.root, 'source', false));
  const source = s.keep(native.openSource(parent, 'hardlink'));
  compareFacts(native.inspect(source), path);
  assert.equal(native.inspect(source).nlink, '2');
  assert.equal(native.read(source, 2).toString(), 'ab');
  assert.equal(native.read(source, 3).toString(), 'cde');
  assert.equal(native.read(source, 3).toString(), 'f');
  assert.equal(native.read(source, 1).length, 0);
  assert.equal(native.inspect(source).bytesRead, '6');
  compareFacts(native.inspect(source), path);
  const after = statSync(path, { bigint: true });
  for (const name of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[name], before[name], name);
  assert.equal(readFileSync(path, 'utf8'), 'abcdef');
  assert.throws(() => native.write(source, Buffer.from('x')), systemError(['EINVAL']));
  assert.throws(() => native.setExecutable(source, true), systemError(['EINVAL']));
  assert.throws(() => native.createFile(parent, 'staging'), (error) => {
    systemError(['EACCES'])(error);
    assert.equal(error.creation.kind, 'staging');
    assert.equal(error.creation.entryCreated, false);
    assert.equal(error.creation.entryCreationState, 'not-created');
    assert.equal(error.creation.facts, null);
    assert.deepEqual(error.creation.release, { attempted: false, completed: false, errno: null });
    assert.deepEqual(error.creation.cleanup, { attempted: false, removed: false, directorySynced: false });
    return true;
  });
  assert.throws(() => native.openPrivateRecord(parent, 'source'), systemError(['EACCES']));
  assert.equal(existsSync(join(s.root, 'staging')), false);
});

test('bounded sequential reads return distinct buffers including empty input and a tail', options, (t) => {
  const s = scope(t);
  const data = Buffer.alloc(1024 * 1024 + 3, 0x5a);
  writeFileSync(join(s.root, 'source'), data);
  writeFileSync(join(s.root, 'empty'), '');
  const parent = s.keep(native.openDirectory(s.root, 'source', false));
  const source = s.keep(native.openSource(parent, 'source'));
  for (const size of [0, -1, 0.5, NaN, Infinity, 1024 * 1024 + 1]) assert.throws(() => native.read(source, size), { code: 'ERR_INVALID_ARG_VALUE' });
  const first = native.read(source, 1024 * 1024);
  const second = native.read(source, 1024 * 1024);
  assert.equal(first.length, 1024 * 1024);
  assert.deepEqual(second, Buffer.alloc(3, 0x5a));
  first.fill(0);
  assert.deepEqual(second, Buffer.alloc(3, 0x5a));
  assert.equal(native.read(source, 1).length, 0);
  const empty = s.keep(native.openSource(parent, 'empty'));
  assert.equal(native.read(empty, 1).length, 0);
});

test('capabilities reject forgery and remain closed while files retain a closed parent', options, (t) => {
  const s = scope(t);
  writeFileSync(join(s.root, 'source'), 'hello');
  const parent = s.keep(native.openDirectory(s.root, 'source', false));
  const source = s.keep(native.openSource(parent, 'source'));
  assert.deepEqual(Object.keys(parent), []);
  assert.equal(Object.isFrozen(parent), true);
  assert.throws(() => native.inspect({}), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => native.inspect(structuredClone(parent)), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.deepEqual(native.close(parent), { closed: true, alreadyClosed: false });
  assert.deepEqual(native.close(parent), { closed: true, alreadyClosed: true });
  assert.throws(() => native.inspect(parent), systemError(['EBADF']));
  assert.equal(native.read(source, 5).toString(), 'hello');
  assert.equal(native.inspectFileBinding(source, 'source').ino, native.inspect(source).ino);
  native.close(source);
  assert.throws(() => native.read(source, 1), systemError(['EBADF']));
});

test('literal walks reject symlinks, nonregular leaves and invalid components', options, (t) => {
  const s = scope(t);
  mkdirSync(join(s.root, 'directory'));
  writeFileSync(join(s.root, 'source'), 'hello');
  symlinkSync('source', join(s.root, 'link'));
  symlinkSync('directory', join(s.root, 'ancestor'));
  const parent = s.keep(native.openDirectory(s.root, 'source', false));
  assert.throws(() => native.openSource(parent, 'link'), systemError(['ELOOP']));
  assert.throws(() => native.openSource(parent, 'directory'), systemError(['EINVAL']));
  assert.throws(() => native.openDirectory(join(s.root, 'ancestor'), 'source', false), systemError(['ELOOP', 'ENOTDIR']));
  for (const name of ['', '.', '..', 'a/b', '/absolute', 'nul\0name', '\ud800', '\udc00']) assert.throws(() => native.openSource(parent, name), { code: 'ERR_INVALID_ARG_VALUE' });
  for (const path of [`${s.root}/../source`, `${s.root}//directory`, `${s.root}/./directory`]) assert.throws(() => native.openDirectory(path, 'source', false), systemError(['EINVAL']));
  const fifo = spawnSync('mkfifo', [join(s.root, 'fifo')], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr);
  assert.throws(() => native.openSource(parent, 'fifo'), systemError(['EINVAL']));
  assert.equal(native.inspectBinding(parent, 'missing'), null);
  assert.equal(native.inspectBinding(parent, 'link').kind, 'symlink');
});

for (const mutation of ['same-size', 'growth', 'truncate', 'replacement', 'unlink', 'permissions', 'hardlink']) {
  test(`source becomes terminal after ${mutation}`, options, (t) => {
    const s = scope(t);
    const path = join(s.root, 'source');
    writeFileSync(path, 'abcdef');
    const parent = s.keep(native.openDirectory(s.root, 'source', false));
    const source = s.keep(native.openSource(parent, 'source'));
    assert.equal(native.read(source, 1).toString(), 'a');
    if (mutation === 'same-size') writeFileSync(path, 'ABCDEF');
    if (mutation === 'growth') writeFileSync(path, 'abcdefg');
    if (mutation === 'truncate') truncateSync(path, 2);
    if (mutation === 'replacement') { renameSync(path, `${path}-original`); writeFileSync(path, 'second'); }
    if (mutation === 'unlink') unlinkSync(path);
    if (mutation === 'permissions') chmodSync(path, 0o400);
    if (mutation === 'hardlink') linkSync(path, `${path}-second`);
    assert.throws(() => native.read(source, 1), systemError(['ESTALE', 'ENOENT']));
    assert.throws(() => native.read(source, 1), systemError(['EBADF']));
  });
}

test('source ancestor substitution refuses completion and never redirects the retained reader', options, (t) => {
  const s = scope(t);
  const directory = join(s.root, 'directory');
  mkdirSync(directory);
  writeFileSync(join(directory, 'source'), 'original');
  const parent = s.keep(native.openDirectory(directory, 'source', false));
  const source = s.keep(native.openSource(parent, 'source'));
  assert.equal(native.read(source, 1).toString(), 'o');
  renameSync(directory, `${directory}-old`);
  mkdirSync(directory);
  writeFileSync(join(directory, 'source'), 'replaced');
  assert.throws(() => native.read(source, 1), systemError(['ESTALE']));
  assert.equal(readFileSync(join(`${directory}-old`, 'source'), 'utf8'), 'original');
});

test('unsupported private destinations refuse admission and creation before namespace changes', options, (t) => {
  const s = scope(t);
  const source = s.keep(native.openDirectory(s.root, 'source', false));
  const facts = native.inspect(source);
  if (!['overlayfs', 'tmpfs'].includes(facts.filesystem.name)) {
    t.skip('This row specifically checks overlayfs/tmpfs refusal');
    return;
  }
  assert.throws(() => native.openDirectory(s.root, 'private', false), systemError(['ENOTSUP']));
  const absent = join(s.root, 'new-private');
  assert.throws(() => native.openDirectory(absent, 'private', true), systemError(['ENOTSUP']));
  assert.equal(existsSync(absent), false);
  assert.deepEqual(readdirSync(s.root), []);
  t.diagnostic(JSON.stringify({ filesystem: facts.filesystem, sourceSupported: true, privateDestinationSupported: false, persistentLocalAcceptance: false }));
});

test('existing destination permissions are refused without repair', options, (t) => {
  const s = scope(t);
  chmodSync(s.root, 0o755);
  assert.throws(() => native.openDirectory(s.root, 'private', false), systemError(['EACCES']));
  assert.equal(statSync(s.root).mode & 0o7777, 0o755);
});

test('new private directory reports its own and retained parent synchronization', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const path = join(s.root, 'created');
  const created = s.keep(native.openDirectory(path, 'private', true));
  const facts = native.inspect(created);
  assert.equal(facts.created, true);
  assert.deepEqual(facts.creationSync, { directory: true, parent: true });
  compareFacts(facts, path);
  const existing = s.keep(native.openDirectory(path, 'private', true));
  assert.equal(native.inspect(existing).created, false);
});

test('admitted private output publishes exclusively with retained parent and independent sync receipts', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const output = s.keep(native.createFile(parent, 'staging'));
  const initial = native.inspect(output);
  assert.equal(initial.mode & 0o7777, 0o600);
  assert.equal(initial.size, '0');
  assert.equal(initial.nlink, '1');
  assert.throws(() => native.write(output, Buffer.alloc(1024 * 1024 + 1)), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.equal(native.inspect(output).size, '0');
  assert.deepEqual(native.write(output, Buffer.from('hello')), { bytesWritten: 5, totalBytesWritten: '5' });
  native.setExecutable(output, true);
  native.close(parent);
  assert.equal(native.syncFile(output, process.platform === 'darwin').synced, true);
  const publication = native.publish(output, 'final');
  assert.equal(publication.published, true);
  assert.equal(native.syncDirectory(output).synced, true);
  if (process.platform === 'darwin') assert.equal(native.syncFile(output, true).synced, true);
  const final = native.inspect(output);
  compareFacts(final, join(s.root, 'final'));
  assert.equal(final.ino, initial.ino);
  assert.equal(final.mode & 0o7777, 0o700);
  assert.equal(readFileSync(join(s.root, 'final'), 'utf8'), 'hello');
  assert.throws(() => native.removeUnpublished(output), systemError(['EACCES']));
});

test('exclusive publication preserves existing targets and abort only removes its exact staging identity', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  for (const kind of ['file', 'directory', 'symlink']) {
    const final = `${kind}-final`;
    if (kind === 'file') writeFileSync(join(s.root, final), 'preserve');
    if (kind === 'directory') mkdirSync(join(s.root, final));
    if (kind === 'symlink') symlinkSync('file-final', join(s.root, final));
    const before = lstatSync(join(s.root, final), { bigint: true });
    const output = s.keep(native.createFile(parent, `${kind}-staging`));
    native.write(output, Buffer.from('new'));
    assert.throws(() => native.publish(output, final), (error) => {
      systemError(['EEXIST'])(error);
      assert.equal(error.renameAttempted, true);
      assert.equal(error.publicationState, 'not-published');
      return true;
    });
    assert.equal(lstatSync(join(s.root, final), { bigint: true }).ino, before.ino);
    assert.equal(native.removeUnpublished(output).removed, true);
    assert.equal(native.removeUnpublished(output).alreadyRemoved, true);
    native.syncDirectory(output);
  }
  const output = s.keep(native.createFile(parent, 'own-staging'));
  renameSync(join(s.root, 'own-staging'), join(s.root, 'displaced'));
  writeFileSync(join(s.root, 'own-staging'), 'different');
  assert.throws(() => native.removeUnpublished(output), systemError(['ESTALE']));
  assert.equal(readFileSync(join(s.root, 'own-staging'), 'utf8'), 'different');
});

test('private record readers require private single-link metadata and retain read-only authority', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const path = join(s.root, 'record');
  writeFileSync(path, '{"value":1}', { mode: 0o600 });
  const record = s.keep(native.openPrivateRecord(parent, 'record'));
  assert.equal(native.read(record, 1024).toString(), '{"value":1}');
  assert.equal(native.read(record, 1).length, 0);
  compareFacts(native.inspect(record), path);
  assert.throws(() => native.write(record, Buffer.from('x')), systemError(['EINVAL']));
  assert.throws(() => native.setExecutable(record, true), systemError(['EINVAL']));
  assert.throws(() => native.openSource(parent, 'record'), systemError(['EACCES']));
  chmodSync(path, 0o644);
  assert.throws(() => native.openPrivateRecord(parent, 'record'), systemError(['EACCES']));
  chmodSync(path, 0o600);
  linkSync(path, join(s.root, 'hardlink'));
  assert.throws(() => native.openPrivateRecord(parent, 'record'), systemError(['EACCES']));
});

test('source capabilities cannot acquire management leases or replace control records', options, (t) => {
  const s = scope(t);
  const path = join(s.root, 'source');
  writeFileSync(path, 'preserve');
  const before = statSync(path, { bigint: true });
  const parent = s.keep(native.openDirectory(s.root, 'source', false));
  const source = s.keep(native.openSource(parent, 'source'));
  assert.throws(() => native.acquireLease(parent, 'management-lock'), systemError(['EACCES']));
  assert.equal(existsSync(join(s.root, 'management-lock')), false);
  assert.throws(() => native.replacePrivateRecord(source, source, parent), (error) => {
    systemError(['EINVAL'])(error);
    assert.equal(error.renameAttempted, false);
    return true;
  });
  assert.equal(native.read(source, 16).toString(), 'preserve');
  assert.equal(statSync(path, { bigint: true }).ino, before.ino);
  assert.equal(statSync(path, { bigint: true }).mtimeNs, before.mtimeNs);
});

test('management leases exclude independent opens and release without unlinking the lock', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const contenderParent = s.keep(native.openDirectory(s.root, 'private', false));
  const lease = s.keep(native.acquireLease(parent, 'management-lock'));
  const admitted = native.inspect(lease);
  assert.equal(admitted.leaseHeld, true);
  assert.equal(admitted.mode & 0o7777, 0o600);
  assert.equal(admitted.nlink, '1');
  assert.equal(admitted.size, '0');
  native.close(parent);
  assert.throws(() => native.acquireLease(contenderParent, 'management-lock'), (error) => {
    systemError(['EAGAIN'])(error);
    assert.equal(error.syscall, 'flock');
    return true;
  });
  assert.throws(() => native.write(lease, Buffer.from('x')), systemError(['EINVAL']));
  assert.throws(() => native.removeUnpublished(lease), systemError(['EACCES']));
  native.close(lease);
  assert.equal(statSync(join(s.root, 'management-lock'), { bigint: true }).ino.toString(), admitted.ino);
  const next = s.keep(native.acquireLease(contenderParent, 'management-lock'));
  assert.equal(native.inspect(next).ino, admitted.ino);
  assert.equal(native.inspect(next).created, false);
});

test('management lease admission refuses changed permissions, data, links and symlinks', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  writeFileSync(join(s.root, 'wrong-mode'), '', { mode: 0o644 });
  writeFileSync(join(s.root, 'data'), 'preserve', { mode: 0o600 });
  writeFileSync(join(s.root, 'linked'), '', { mode: 0o600 });
  linkSync(join(s.root, 'linked'), join(s.root, 'second-link'));
  symlinkSync('linked', join(s.root, 'symlink'));
  for (const name of ['wrong-mode', 'data', 'linked']) assert.throws(() => native.acquireLease(parent, name), systemError(['EACCES']));
  assert.throws(() => native.acquireLease(parent, 'symlink'), systemError(['ELOOP']));
  assert.equal(statSync(join(s.root, 'wrong-mode')).mode & 0o7777, 0o644);
  assert.equal(readFileSync(join(s.root, 'data'), 'utf8'), 'preserve');
  assert.equal(statSync(join(s.root, 'linked')).nlink, 2);
});

test('post-create admission failure reports the retained staging residue and actual release', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  native.close(parent);
  const child = spawnSync(process.execPath, [fileURLToPath(fixture), 'creation-failure', binary, s.root], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.creation.entryCreated, true);
  assert.equal(result.creation.entryCreationState, 'created');
  assert.equal(result.creation.kind, 'staging');
  assert.equal(result.creation.facts.ino, statSync(join(s.root, 'rejected-staging'), { bigint: true }).ino.toString());
  assert.equal(result.creation.bindingVerified, true);
  assert.deepEqual(result.creation.release, { attempted: true, completed: true, errno: null });
  assert.deepEqual(result.creation.cleanup, { attempted: false, removed: false, directorySynced: false });
  assert.equal(statSync(join(s.root, 'rejected-staging')).mode & 0o7777, 0);
});

function preparedRecord(s, parent, name = 'record', contents = 'old') {
  writeFileSync(join(s.root, name), contents, { mode: 0o600 });
  const record = s.keep(native.openPrivateRecord(parent, name));
  assert.equal(native.read(record, 1024).toString(), contents);
  assert.equal(native.read(record, 1).length, 0);
  return record;
}

function preparedOutput(s, parent, name = 'record-staging') {
  const output = s.keep(native.createFile(parent, name));
  native.write(output, Buffer.from('new'));
  native.syncFile(output, process.platform === 'darwin');
  return output;
}

test('control-record replacement holds the old fd and verified lease through same-parent rename', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const lease = s.keep(native.acquireLease(parent, 'management-lock'));
  const leaseFacts = native.inspect(lease);
  const record = preparedRecord(s, parent);
  const oldFacts = native.inspect(record);
  const output = preparedOutput(s, parent);
  const newFacts = native.inspect(output);
  native.close(parent);
  const receipt = native.replacePrivateRecord(output, record, lease);
  assert.equal(receipt.published, true);
  assert.equal(receipt.leaseVerified, true);
  assert.equal(receipt.mechanism, process.platform === 'darwin' ? 'renameatx_np(flags=0)' : 'renameat2(flags=0)');
  assert.equal(receipt.replacedFacts.ino, oldFacts.ino);
  assert.equal(receipt.replacedAfterFacts.ino, oldFacts.ino);
  assert.equal(receipt.replacedAfterFacts.nlink, '0');
  assert.equal(receipt.facts.ino, newFacts.ino);
  assert.notEqual(newFacts.ino, oldFacts.ino);
  assert.equal(receipt.stagingParentFacts.dev, receipt.targetParentFacts.dev);
  assert.equal(receipt.stagingParentFacts.ino, receipt.targetParentFacts.ino);
  assert.equal(receipt.parentAfterFacts.ino, receipt.targetParentFacts.ino);
  native.syncDirectory(output);
  if (process.platform === 'darwin') native.syncFile(output, true);
  compareFacts(native.inspect(output), join(s.root, 'record'));
  assert.equal(readFileSync(join(s.root, 'record'), 'utf8'), 'new');
  assert.equal(native.inspect(lease).ino, leaseFacts.ino);
  assert.equal(native.inspect(lease).leaseHeld, true);
  assert.throws(() => native.read(record, 1), systemError(['EBADF']));
  assert.throws(() => native.removeUnpublished(output), systemError(['EACCES']));
});

for (const condition of ['missing-eof', 'not-synced', 'target-changed', 'wrong-parent', 'lease-binding-changed', 'executable', 'lock-as-target']) {
  test(`control-record replacement refuses ${condition} before rename`, options, (t) => {
    const s = scope(t);
    const parent = privateDirectory(t, s);
    if (parent === null) return;
    let lease = s.keep(native.acquireLease(parent, 'management-lock'));
    let record;
    if (condition === 'missing-eof') {
      writeFileSync(join(s.root, 'record'), 'old', { mode: 0o600 });
      record = s.keep(native.openPrivateRecord(parent, 'record'));
      assert.equal(native.read(record, 3).toString(), 'old');
    } else if (condition === 'lock-as-target') {
      record = s.keep(native.openPrivateRecord(parent, 'management-lock'));
      assert.equal(native.read(record, 1).length, 0);
    } else record = preparedRecord(s, parent);
    const output = preparedOutput(s, parent);
    if (condition === 'not-synced') native.write(output, Buffer.from('!'));
    if (condition === 'target-changed') writeFileSync(join(s.root, 'record'), 'bad');
    if (condition === 'wrong-parent') {
      mkdirSync(join(s.root, 'other'), { mode: 0o700 });
      const other = s.keep(native.openDirectory(join(s.root, 'other'), 'private', false));
      lease = s.keep(native.acquireLease(other, 'management-lock'));
    }
    if (condition === 'lease-binding-changed') {
      renameSync(join(s.root, 'management-lock'), join(s.root, 'old-lock'));
      writeFileSync(join(s.root, 'management-lock'), '', { mode: 0o600 });
    }
    if (condition === 'executable') native.setExecutable(output, true);
    assert.throws(() => native.replacePrivateRecord(output, record, lease), (error) => {
      systemError(['EINVAL', 'EACCES', 'ESTALE', 'EXDEV'])(error);
      assert.equal(error.renameAttempted, false);
      assert.equal(error.publicationState, 'not-published');
      return true;
    });
    const name = condition === 'lock-as-target' ? 'management-lock' : 'record';
    assert.equal(readFileSync(join(s.root, name), 'utf8'), condition === 'lock-as-target' ? '' : condition === 'target-changed' ? 'bad' : 'old');
    assert.equal(native.removeUnpublished(output).removed, true);
  });
}

test('closed leases and ordinary source readers provide no replacement authority', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const lease = s.keep(native.acquireLease(parent, 'management-lock'));
  const record = preparedRecord(s, parent);
  const first = preparedOutput(s, parent, 'first-staging');
  const sourceParent = s.keep(native.openDirectory(s.root, 'source', false));
  const ordinarySource = s.keep(native.openSource(sourceParent, 'record'));
  native.read(ordinarySource, 1024);
  assert.throws(() => native.replacePrivateRecord(first, ordinarySource, lease), systemError(['EACCES']));
  native.removeUnpublished(first);
  native.close(lease);
  const second = preparedOutput(s, parent, 'second-staging');
  assert.throws(() => native.replacePrivateRecord(second, record, lease), systemError(['EBADF']));
  native.removeUnpublished(second);
  assert.equal(readFileSync(join(s.root, 'record'), 'utf8'), 'old');
});

test('Worker teardown releases the native management lease and preserves its lock entry', options, async (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const worker = new Worker(fixture, { workerData: { binary, root: s.root, phase: 'lease-live' } });
  t.after(async () => { await worker.terminate(); });
  const [message] = await once(worker, 'message');
  assert.equal(message.facts.leaseHeld, true);
  assert.throws(() => native.acquireLease(parent, 'management-lock'), systemError(['EAGAIN']));
  native.close(parent);
  assert.ok(retainedFixtureDescriptors(s.root).length >= 2);
  await worker.terminate();
  assert.deepEqual(retainedFixtureDescriptors(s.root), []);
  const nextParent = s.keep(native.openDirectory(s.root, 'private', false));
  const nextLease = s.keep(native.acquireLease(nextParent, 'management-lock'));
  assert.equal(native.inspect(nextLease).ino, message.facts.ino);
});

test('actual GC releases management lease ownership without unlinking the lock', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  native.close(parent);
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(fixture), 'gc-lease', binary, s.root], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).gcReleased, true);
  assert.equal(statSync(join(s.root, 'management-lock')).nlink, 1);
  const nextParent = s.keep(native.openDirectory(s.root, 'private', false));
  assert.equal(native.inspect(s.keep(native.acquireLease(nextParent, 'management-lock'))).leaseHeld, true);
});

test('two Worker writers racing one final name produce exactly one winner', options, async (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  native.close(parent);
  const barrier = new SharedArrayBuffer(4);
  const workers = ['alpha', 'bravo'].map((name) => new Worker(fixture, {
    workerData: { binary, root: s.root, phase: 'publish', name, barrier },
  }));
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const ready = await Promise.all(workers.map((worker) => once(worker, 'message')));
  assert.ok(ready.every(([message]) => message.ready === true));
  const results = workers.map((worker) => once(worker, 'message'));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, 2);
  const observed = (await Promise.all(results)).map(([message]) => message);
  assert.equal(observed.filter((message) => message.published).length, 1);
  assert.equal(observed.filter((message) => message.code === 'EEXIST').length, 1);
  const winner = observed.find((message) => message.published);
  assert.equal(readFileSync(join(s.root, 'winner'), 'utf8'), winner.name);
});

test('Worker teardown releases owned output fds and leaves unpublished entries intact', options, async (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  native.close(parent);
  const worker = new Worker(fixture, { workerData: { binary, root: s.root, phase: 'output-live' } });
  t.after(async () => { await worker.terminate(); });
  await once(worker, 'message');
  assert.ok(retainedFixtureDescriptors(s.root).length >= 2);
  await worker.terminate();
  assert.deepEqual(retainedFixtureDescriptors(s.root), []);
  assert.equal(readFileSync(join(s.root, 'staging'), 'utf8'), 'unfinished');
  assert.equal(existsSync(join(s.root, 'final')), false);
});

test('Worker environment teardown releases actual native source descriptors', options, async (t) => {
  const s = scope(t);
  writeFileSync(join(s.root, 'source'), 'data');
  assert.deepEqual(retainedFixtureDescriptors(s.root), []);
  for (const phase of ['live', 'explicit-close']) {
    const worker = new Worker(fixture, { workerData: { binary, root: s.root, phase } });
    t.after(async () => { await worker.terminate(); });
    const [message] = await once(worker, 'message');
    assert.equal(message.phase, phase);
    assert.throws(() => native.inspect(message.capability), { code: 'ERR_INVALID_ARG_VALUE' });
    const descriptors = retainedFixtureDescriptors(s.root);
    if (phase === 'live') {
      assert.ok(descriptors.length >= 2);
      for (const fd of process.platform === 'linux' ? descriptors : []) {
        const flags = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^flags:\s+(\d+)$/m);
        assert.ok(flags);
        assert.notEqual(Number.parseInt(flags[1], 8) & 0o2000000, 0, 'Native owned fd must have CLOEXEC');
      }
    }
    else assert.deepEqual(descriptors, []);
    await worker.terminate();
    assert.deepEqual(retainedFixtureDescriptors(s.root), []);
  }
});

test('actual GC releases native resources without namespace side effects', options, (t) => {
  const s = scope(t);
  writeFileSync(join(s.root, 'source'), 'data');
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(fixture), 'gc', binary, s.root], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).gcReleased, true);
  assert.equal(readFileSync(join(s.root, 'source'), 'utf8'), 'data');
});

test('independent syscall oracle reports observations without provider acceptance', options, (t) => {
  const s = scope(t);
  const result = spawnSync(syscallOracle, [s.root], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const facts = JSON.parse(result.stdout);
  assert.equal(facts.kind, 'independent-syscall-diagnostic');
  assert.equal(facts.providerAcceptance, false);
  assert.equal(facts.persistentLocalAcceptance, false);
  assert.equal(facts.nativeDurabilityClaimed, false);
  assert.equal(facts.exclusivePublication, true);
  assert.equal(facts.nonblockingLeaseObserved, true);
  assert.equal(facts.retainedRecordReplacement, true);
  assert.equal(readFileSync(join(s.root, 'oracle-final'), 'utf8'), 'first');
  assert.equal(readFileSync(join(s.root, 'oracle-control'), 'utf8'), 'after');
  if (process.platform === 'darwin') {
    assert.deepEqual(facts.darwinAcl, {
      absentFileObserved: true, absentDirectoryObserved: true, presentFileObserved: true,
      presentDirectoryObserved: true, invalidDescriptorRefused: true,
    });
    const sourceParent = s.keep(native.openDirectory(s.root, 'source', false));
    const privateParent = s.keep(native.openDirectory(s.root, 'private', false));
    const absentFile = s.keep(native.openPrivateRecord(privateParent, 'oracle-no-acl'));
    const absentDirectory = s.keep(native.openDirectory(join(s.root, 'oracle-no-acl-directory'), 'private', false));
    for (const cap of [absentFile, absentDirectory]) {
      assert.deepEqual(native.inspect(cap).acl, { model: 'darwin-extended', supported: true, entries: 0, defaultEntries: 0 });
    }
    assert.equal(native.read(absentFile, 3).toString(), 'acl');
    const presentFile = s.keep(native.openSource(sourceParent, 'oracle-with-acl'));
    const presentDirectory = s.keep(native.openDirectory(join(s.root, 'oracle-with-acl-directory'), 'source', false));
    for (const cap of [presentFile, presentDirectory]) {
      assert.deepEqual(native.inspect(cap).acl, { model: 'darwin-extended', supported: true, entries: 1, defaultEntries: 0 });
    }
    assert.equal(native.read(presentFile, 3).toString(), 'acl');
    assert.throws(() => native.openPrivateRecord(privateParent, 'oracle-with-acl'), systemError(['EACCES']));
    assert.throws(() => native.openDirectory(join(s.root, 'oracle-with-acl-directory'), 'private', false), systemError(['EACCES']));
    for (const [name, entries, admitted] of [
      ['oracle-deny-ancestor', 1, true], ['oracle-allow-ancestor', 1, false], ['oracle-mixed-ancestor', 2, false],
    ]) {
      const ancestorPath = join(s.root, name);
      const before = statSync(ancestorPath, { bigint: true });
      const sourceAncestor = s.keep(native.openDirectory(ancestorPath, 'source', false));
      assert.equal(native.inspect(sourceAncestor).acl.entries, entries);
      // A deny-only ACL is still refused on the private destination itself.
      assert.throws(() => native.openDirectory(ancestorPath, 'private', false), systemError(['EACCES']));
      const leaf = join(ancestorPath, 'private-leaf');
      if (admitted) {
        const privateLeaf = s.keep(native.openDirectory(leaf, 'private', false));
        compareFacts(native.inspect(privateLeaf), leaf);
        assert.equal(native.inspect(privateLeaf).acl.entries, 0);
      } else {
        assert.throws(() => native.openDirectory(leaf, 'private', false), (error) => {
          systemError(['EACCES'])(error);
          assert.match(error.message, /ancestor extended ACL/);
          return true;
        });
      }
      const after = statSync(ancestorPath, { bigint: true });
      for (const field of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) {
        assert.equal(after[field], before[field], field);
      }
      assert.equal(native.inspect(sourceAncestor).acl.entries, entries);
    }
  } else {
    assert.equal(facts.darwinAcl, null);
  }
  t.diagnostic(JSON.stringify(facts));
});

test('synthetic native read faults preserve genuine partial progress and terminal failures', { ...options, skip: process.platform !== 'linux' }, (t) => {
  const s = scope(t);
  const path = join(s.root, 'source');
  writeFileSync(path, 'abcdefgh');
  const stat = statSync(path, { bigint: true });
  for (const mode of ['eintr', 'short', 'partial-error', 'zero']) {
    const result = spawnSync(process.execPath, [fileURLToPath(fixture), 'read-fault', binary, s.root], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        LD_PRELOAD: readFault,
        PRIVATE_STORAGE_FAULT_DEV: stat.dev.toString(),
        PRIVATE_STORAGE_FAULT_INO: stat.ino.toString(),
        PRIVATE_STORAGE_FAULT_MODE: mode,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
  }
  assert.equal(readFileSync(path, 'utf8'), 'abcdefgh');
});

test('retained source child traversal inherits readonly policy and survives caller parent close', options, (t) => {
  const s = scope(t);
  mkdirSync(join(s.root, 'child'), { mode: 0o755 });
  writeFileSync(join(s.root, 'child', 'source'), 'retained', { mode: 0o444 });
  const parent = s.keep(native.openDirectory(s.root, 'source', false));
  const child = s.keep(native.openChild(parent, 'child'));
  native.close(parent);
  const source = s.keep(native.openSource(child, 'source'));
  native.close(child);
  assert.equal(native.read(source, 32).toString(), 'retained');
  assert.equal(native.read(source, 1).length, 0);
  compareFacts(native.inspect(source), join(s.root, 'child', 'source'));
});

test('source child traversal refuses symlinks, non-directories and replaced ancestors', options, (t) => {
  const s = scope(t);
  mkdirSync(join(s.root, 'child'));
  mkdirSync(join(s.root, 'child', 'nested'));
  symlinkSync('child', join(s.root, 'alias'));
  writeFileSync(join(s.root, 'file'), 'preserve');
  const parent = s.keep(native.openDirectory(s.root, 'source', false));
  assert.throws(() => native.openChild(parent, 'alias'), systemError(['ELOOP', 'ENOTDIR']));
  assert.throws(() => native.openChild(parent, 'file'), systemError(['ENOTDIR']));
  for (const name of ['', '.', '..', 'a/b', 'nul\0name']) assert.throws(() => native.openChild(parent, name), { code: 'ERR_INVALID_ARG_VALUE' });
  const child = s.keep(native.openChild(parent, 'child'));
  renameSync(join(s.root, 'child'), join(s.root, 'old-child'));
  mkdirSync(join(s.root, 'child'));
  assert.throws(() => native.openChild(child, 'nested'), systemError(['ESTALE']));
});

test('source roots provide no private child, audit, listing or capacity authority', options, (t) => {
  const s = scope(t);
  writeFileSync(join(s.root, 'source'), 'preserve', { mode: 0o600 });
  const parent = s.keep(native.openDirectory(s.root, 'source', false));
  assert.throws(() => native.createPrivateChild(parent, 'uncreated'), (error) => {
    systemError(['EACCES'])(error);
    assert.equal(error.creation.entryCreationState, 'not-created');
    assert.equal(error.publicationState, 'not-published');
    return true;
  });
  assert.throws(() => native.openPrivateOutput(parent, 'source'), systemError(['EACCES']));
  assert.throws(() => native.listDirectory(parent, 100), systemError(['EACCES']));
  assert.throws(() => native.observeCapacity(parent), systemError(['EACCES']));
  for (const maximum of [-1, 0.5, NaN, Infinity, 100001]) assert.throws(() => native.listDirectory(parent, maximum), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.equal(existsSync(join(s.root, 'uncreated')), false);
  assert.equal(readFileSync(join(s.root, 'source'), 'utf8'), 'preserve');
});

test('private child creation is exclusive, empty, synchronized and retains its parent', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const created = native.createPrivateChild(parent, 'child');
  const child = s.keep(created.capability);
  assert.equal(created.published, true);
  assert.equal(created.mechanism, 'mkdirat');
  assert.deepEqual(created.creationSync, { directory: true, parent: true });
  assert.equal(created.facts.created, true);
  assert.equal(created.facts.published, true);
  assert.equal(created.facts.mode & 0o7777, 0o700);
  assert.equal(created.parentBeforeFacts.ino, created.parentAfterFacts.ino);
  assert.deepEqual(native.listDirectory(child, 0).entries, []);
  compareFacts(created.facts, join(s.root, 'child'));
  const inode = created.facts.ino;
  assert.throws(() => native.createPrivateChild(parent, 'child'), (error) => {
    systemError(['EEXIST'])(error);
    assert.equal(error.creation.entryCreated, false);
    assert.equal(error.creation.entryCreationState, 'not-created');
    assert.equal(error.creation.release.attempted, false);
    return true;
  });
  const reopened = s.keep(native.openChild(parent, 'child'));
  assert.equal(native.inspect(reopened).ino, inode);
  native.close(parent);
  const output = s.keep(native.createFile(child, 'staging'));
  native.write(output, Buffer.from('retained'));
  assert.equal(native.removeUnpublished(output).removed, true);
});

test('private child admission preserves existing modes and post-create failures report visible residue', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  mkdirSync(join(s.root, 'shared'), { mode: 0o755 });
  assert.throws(() => native.openChild(parent, 'shared'), systemError(['EACCES']));
  assert.equal(statSync(join(s.root, 'shared')).mode & 0o7777, 0o755);
  writeFileSync(join(s.root, 'file'), 'preserve', { mode: 0o600 });
  assert.throws(() => native.createPrivateChild(parent, 'file'), systemError(['EEXIST']));
  assert.equal(readFileSync(join(s.root, 'file'), 'utf8'), 'preserve');
  const child = spawnSync(process.execPath, [fileURLToPath(fixture), 'child-creation-failure', binary, s.root], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  const receipt = JSON.parse(child.stdout).creation;
  assert.equal(receipt.kind, 'directory');
  assert.equal(receipt.entryCreationState, 'created');
  assert.deepEqual(receipt.creationSync, { directory: false, parent: false });
  assert.deepEqual(receipt.cleanup, { attempted: false, removed: false, directorySynced: false });
  assert.equal(statSync(join(s.root, 'rejected-child')).mode & 0o7777, 0);
  if (receipt.facts !== null) assert.equal(receipt.facts.ino, statSync(join(s.root, 'rejected-child'), { bigint: true }).ino.toString());
  assert.equal(receipt.release.completed, receipt.release.attempted);
  chmodSync(join(s.root, 'rejected-child'), 0o700);
});

test('private output audit readers accept data and executables with sequential bounded readonly authority', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  for (const mode of [0o600, 0o700]) {
    const name = `output-${mode}`;
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0x61);
    writeFileSync(join(s.root, name), bytes, { mode });
    const before = statSync(join(s.root, name), { bigint: true });
    const reader = s.keep(native.openPrivateOutput(parent, name));
    assert.throws(() => native.read(reader, 1024 * 1024 + 1), { code: 'ERR_INVALID_ARG_VALUE' });
    assert.equal(native.read(reader, 1024 * 1024).length, 1024 * 1024);
    assert.equal(native.read(reader, 16).toString(), 'a');
    assert.equal(native.read(reader, 1).length, 0);
    compareFacts(native.inspect(reader), join(s.root, name));
    assert.throws(() => native.write(reader, Buffer.from('x')), systemError(['EINVAL']));
    assert.throws(() => native.setExecutable(reader, false), systemError(['EINVAL']));
    const after = statSync(join(s.root, name), { bigint: true });
    for (const field of ['dev', 'ino', 'mode', 'size', 'nlink', 'uid', 'gid', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field], field);
    if (mode === 0o700) assert.throws(() => native.openPrivateRecord(parent, name), systemError(['EACCES']));
  }
});

test('private output audit authority cannot authorize control-record replacement', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const lease = s.keep(native.acquireLease(parent, 'management-lock'));
  writeFileSync(join(s.root, 'record'), 'old', { mode: 0o600 });
  const reader = s.keep(native.openPrivateOutput(parent, 'record'));
  assert.equal(native.read(reader, 16).toString(), 'old');
  assert.equal(native.read(reader, 1).length, 0);
  const output = preparedOutput(s, parent);
  assert.throws(() => native.replacePrivateRecord(output, reader, lease), (error) => {
    systemError(['EACCES'])(error);
    assert.equal(error.renameAttempted, false);
    return true;
  });
  native.removeUnpublished(output);
  assert.equal(readFileSync(join(s.root, 'record'), 'utf8'), 'old');
});

for (const mutation of ['same-size', 'growth', 'truncate', 'replacement', 'permissions', 'hardlink']) {
  test(`private output audit refuses ${mutation} after admission`, options, (t) => {
    const s = scope(t);
    const parent = privateDirectory(t, s);
    if (parent === null) return;
    const path = join(s.root, 'output');
    writeFileSync(path, 'abcdef', { mode: 0o600 });
    const reader = s.keep(native.openPrivateOutput(parent, 'output'));
    assert.equal(native.read(reader, 1).toString(), 'a');
    if (mutation === 'same-size') writeFileSync(path, 'ABCDEF');
    if (mutation === 'growth') writeFileSync(path, 'abcdefg');
    if (mutation === 'truncate') truncateSync(path, 2);
    if (mutation === 'replacement') { renameSync(path, `${path}-old`); writeFileSync(path, 'second', { mode: 0o600 }); }
    if (mutation === 'permissions') chmodSync(path, 0o644);
    if (mutation === 'hardlink') linkSync(path, `${path}-link`);
    assert.throws(() => native.read(reader, 1), systemError(['ESTALE', 'ENOENT']));
    assert.throws(() => native.read(reader, 1), systemError(['EBADF']));
  });
}

test('private directory listings return complete literal stat facts without admitting leaf privacy', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  writeFileSync(join(s.root, 'private-file'), 'private', { mode: 0o600 });
  writeFileSync(join(s.root, 'shared-file'), 'shared', { mode: 0o644 });
  mkdirSync(join(s.root, 'child'), { mode: 0o700 });
  symlinkSync('private-file', join(s.root, 'link'));
  const fifo = spawnSync('mkfifo', [join(s.root, 'fifo')], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr);
  const listing = native.listDirectory(parent, 5);
  assert.equal(listing.complete, true);
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ['child', 'fifo', 'link', 'private-file', 'shared-file']);
  assert.deepEqual(listing.parentBeforeFacts, listing.parentAfterFacts);
  for (const entry of listing.entries) {
    const stat = lstatSync(join(s.root, entry.name), { bigint: true });
    assert.equal(entry.facts.ino, stat.ino.toString());
    assert.equal(entry.facts.dev, stat.dev.toString());
    assert.equal(Object.hasOwn(entry.facts, 'acl'), false);
    assert.equal(Object.hasOwn(entry.facts, 'filesystem'), false);
    assert.equal(Object.hasOwn(entry.facts, 'bindingVerified'), false);
  }
  assert.equal(listing.entries.find((entry) => entry.name === 'link').facts.kind, 'symlink');
  assert.equal(listing.entries.find((entry) => entry.name === 'fifo').facts.kind, 'fifo');
  assert.throws(() => native.openPrivateOutput(parent, 'shared-file'), systemError(['EACCES']));
  assert.throws(() => native.openPrivateOutput(parent, 'link'), systemError(['ELOOP']));
  assert.throws(() => native.openPrivateOutput(parent, 'fifo'), systemError(['EINVAL']));
});

test('directory entry limits refuse partial results and subsequent enumeration restarts completely', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  assert.deepEqual(native.listDirectory(parent, 0).entries, []);
  writeFileSync(join(s.root, 'one'), '', { mode: 0o600 });
  writeFileSync(join(s.root, 'two'), '', { mode: 0o600 });
  const before = retainedFixtureDescriptors(s.root).length;
  for (const maximum of [0, 1]) assert.throws(() => native.listDirectory(parent, maximum), systemError(['EOVERFLOW']));
  assert.equal(retainedFixtureDescriptors(s.root).length, before);
  assert.deepEqual(native.listDirectory(parent, 2).entries.map((entry) => entry.name).sort(), ['one', 'two']);
  assert.deepEqual(native.listDirectory(parent, 100000).entries.map((entry) => entry.name).sort(), ['one', 'two']);
});

test('directory listings refuse names that cannot round-trip through JavaScript strings', { ...options, skip: process.platform !== 'linux' }, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const path = Buffer.concat([Buffer.from(`${s.root}/`), Buffer.from([0xff])]);
  writeFileSync(path, '', { mode: 0o600 });
  try { assert.throws(() => native.listDirectory(parent, 100), systemError(['EILSEQ'])); }
  finally { unlinkSync(path); }
});

test('capacity is an fd-bound observation with full-width allocation and free-entry facts', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const observed = native.observeCapacity(parent);
  const inspected = native.inspect(parent);
  assert.deepEqual(observed.filesystem, inspected.filesystem);
  assert.equal(observed.reservation, false);
  assert.ok(BigInt(observed.allocationUnitBytes) > 0n);
  assert.ok(BigInt(observed.availableBytes) >= 0n);
  assert.equal(BigInt(observed.availableBytes) % BigInt(observed.allocationUnitBytes), 0n);
  for (const name of ['freeEntries', 'availableEntries']) assert.ok(observed[name] === null || /^\d+$/.test(observed[name]));
  assert.deepEqual(observed.parentBeforeFacts, observed.parentAfterFacts);
  assert.equal(observed.parentBeforeFacts.ino, inspected.ino);
  assert.deepEqual(readdirSync(s.root), []);
});

test('listing and capacity refuse substituted private directory bindings', options, (t) => {
  const s = scope(t);
  const parent = privateDirectory(t, s);
  if (parent === null) return;
  const child = s.keep(native.createPrivateChild(parent, 'child').capability);
  renameSync(join(s.root, 'child'), join(s.root, 'old-child'));
  mkdirSync(join(s.root, 'child'), { mode: 0o700 });
  assert.throws(() => native.listDirectory(child, 100), systemError(['ESTALE']));
  assert.throws(() => native.observeCapacity(child), systemError(['ESTALE']));
  assert.deepEqual(readdirSync(join(s.root, 'old-child')), []);
});

for (const mode of ['list-mutation', 'capacity-mutation']) {
  test(`synthetic native ${mode} is detected without returning a successful observation`, { ...options, skip: process.platform !== 'linux' }, (t) => {
    const s = scope(t);
    const parent = privateDirectory(t, s);
    if (parent === null) return;
    writeFileSync(join(s.root, 'entry'), '', { mode: 0o600 });
    native.close(parent);
    const stat = statSync(s.root, { bigint: true });
    const directoryFault = process.env.PRIVATE_STORAGE_TEST_DIRECTORY_FAULT
      ? resolve(process.env.PRIVATE_STORAGE_TEST_DIRECTORY_FAULT)
      : fileURLToPath(new URL(`./bin/${libc}private-storage-directory-fault.so`, import.meta.url));
    const result = spawnSync(process.execPath, [fileURLToPath(fixture), 'directory-fault', binary, s.root, mode], {
      encoding: 'utf8', timeout: 15_000,
      env: {
        ...process.env,
        LD_PRELOAD: directoryFault,
        PRIVATE_STORAGE_DIRECTORY_FAULT_DEV: stat.dev.toString(),
        PRIVATE_STORAGE_DIRECTORY_FAULT_INO: stat.ino.toString(),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
    assert.equal(existsSync(join(s.root, 'native-observation-mutation')), true);
  });
}

test('process-birth observations reject invalid PID arguments before querying the platform', options, () => {
  for (const pid of [0, -1, 0.5, NaN, Infinity, 2 ** 31, '', '1', null, undefined, {}, []]) {
    assert.throws(() => native.observeProcessBirth(pid), { code: 'ERR_INVALID_ARG_VALUE' });
  }
});

test('Darwin process-birth observation explicitly refuses Linux without invented identity or exit facts', { ...options, skip: process.platform !== 'linux' }, () => {
  assert.throws(() => native.observeProcessBirth(process.pid), (error) => {
    assert.equal(error.code, 'ENOTSUP');
    assert.ok(error.errno > 0);
    assert.equal(error.pid, process.pid);
    assert.equal(error.syscall, 'proc_pid_rusage(RUSAGE_INFO_V0)');
    assert.equal(error.reason, 'unsupported-platform');
    assert.equal(error.observationOnly, true);
    assert.equal(error.exitConfirmed, false);
    assert.equal(Object.hasOwn(error, 'startAbstime'), false);
    assert.equal(Object.hasOwn(error, 'bootSessionUuid'), false);
    return true;
  });
});

test('Darwin current-process birth is a stable full-width kernel and boot-session observation', { ...options, skip: process.platform !== 'darwin' }, () => {
  const first = native.observeProcessBirth(process.pid);
  const second = native.observeProcessBirth(process.pid);
  assert.deepEqual(first, second);
  assert.equal(first.platform, 'darwin');
  assert.equal(first.pid, process.pid);
  assert.equal(first.parentPid, process.ppid);
  assert.equal(first.uid, String(process.geteuid()));
  assert.equal(first.scope, 'current-process');
  assert.equal(first.mechanism, 'proc_pid_rusage(RUSAGE_INFO_V0)');
  assert.match(first.startAbstime, /^[1-9]\d*$/);
  assert.ok(BigInt(first.startAbstime) <= (1n << 64n) - 1n);
  assert.match(first.bootSessionUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(first.observationOnly, true);
});

test('Darwin birth observation is limited to an owned direct child and never turns absence into exit confirmation', { ...options, skip: process.platform !== 'darwin' }, async (t) => {
  const child = fork(new URL('./private-storage-process-birth-child.js', import.meta.url), [binary], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(name))),
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.connected) child.send('exit');
    await exited;
  });
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(15_000) });
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  const observed = native.observeProcessBirth(child.pid);
  assert.equal(observed.platform, 'darwin');
  assert.equal(observed.pid, child.pid);
  assert.equal(observed.parentPid, process.pid);
  assert.equal(observed.uid, String(process.geteuid()));
  assert.equal(observed.scope, 'direct-child');
  assert.equal(observed.startAbstime, message.birth.startAbstime);
  assert.equal(observed.bootSessionUuid, message.birth.bootSessionUuid);
  assert.equal(observed.observationOnly, true);
  assert.deepEqual(message.parentRefusal, { code: 'EACCES', reason: 'scope-refused', observationOnly: true, exitConfirmed: false });
  child.send('exit');
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.throws(() => native.observeProcessBirth(child.pid), (error) => {
    assert.ok(['process-unavailable', 'scope-refused', 'identity-changed', 'process-exiting'].includes(error.reason));
    assert.ok(error.errno > 0);
    assert.equal(error.observationOnly, true);
    assert.equal(error.exitConfirmed, false);
    return true;
  });
});
