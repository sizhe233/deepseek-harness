/** Isolated environment ownership fixture; only the parent creates and cleans its files. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { retainedFixtureDescriptors } from './private-storage-fd-observer.js';

const require = createRequire(import.meta.url);
if (!isMainThread && workerData.phase === 'publish') {
  const native = require(workerData.binary);
  const parent = native.openDirectory(workerData.root, 'private', false);
  const output = native.createFile(parent, `staging-${workerData.name}`);
  native.write(output, Buffer.from(workerData.name));
  native.syncFile(output, process.platform === 'darwin');
  parentPort.postMessage({ ready: true });
  Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
  let result;
  try { result = { published: native.publish(output, 'winner').published }; }
  catch (error) { result = { published: false, code: error.code, publicationState: error.publicationState }; }
  native.close(output);
  native.close(parent);
  parentPort.postMessage({ ...result, name: workerData.name });
} else if (!isMainThread && workerData.phase === 'lease-live') {
  const native = require(workerData.binary);
  const parent = native.openDirectory(workerData.root, 'private', false);
  const lease = native.acquireLease(parent, 'management-lock');
  native.close(parent);
  parentPort.postMessage({ ready: true, facts: native.inspect(lease) });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (!isMainThread && workerData.phase === 'output-live') {
  const native = require(workerData.binary);
  const parent = native.openDirectory(workerData.root, 'private', false);
  const output = native.createFile(parent, 'staging');
  native.write(output, Buffer.from('unfinished'));
  parentPort.postMessage({ ready: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (!isMainThread) {
  const native = require(workerData.binary);
  const parent = native.openDirectory(workerData.root, 'source', false);
  const source = native.openSource(parent, 'source');
  assert.equal(native.read(source, 1).toString(), 'd');
  if (workerData.phase === 'explicit-close') {
    native.close(parent);
    native.close(source);
  }
  parentPort.postMessage({ phase: workerData.phase, capability: source });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (process.argv[2] === 'gc' || process.argv[2] === 'gc-lease') {
  const native = require(process.argv[3]);
  const root = process.argv[4];
  const descriptors = () => retainedFixtureDescriptors(root);
  (() => {
    if (process.argv[2] === 'gc-lease') {
      const parent = native.openDirectory(root, 'private', false);
      const lease = native.acquireLease(parent, 'management-lock');
      assert.equal(native.inspect(lease).leaseHeld, true);
      assert.ok(descriptors().length >= 2);
      return;
    }
    const parent = native.openDirectory(root, 'source', false);
    const source = native.openSource(parent, 'source');
    assert.ok(descriptors().length >= 2);
    assert.equal(native.read(source, 1).toString(), 'd');
  })();
  const deadline = Date.now() + 5000;
  while (descriptors().length !== 0 && Date.now() < deadline) {
    global.gc();
    await setImmediate();
  }
  assert.deepEqual(descriptors(), []);
  process.stdout.write(`${JSON.stringify({ gcReleased: true, namespaceMutated: false })}\n`);
} else if (process.argv[2] === 'directory-fault') {
  const native = require(process.argv[3]);
  const root = process.argv[4];
  const parent = native.openDirectory(root, 'private', false);
  const before = retainedFixtureDescriptors(root).length;
  process.env.PRIVATE_STORAGE_DIRECTORY_FAULT_MODE = process.argv[5];
  try {
    assert.throws(() => process.argv[5] === 'list-mutation' ? native.listDirectory(parent, 10) : native.observeCapacity(parent), { code: 'ESTALE' });
    assert.equal(retainedFixtureDescriptors(root).length, before);
  } finally {
    native.close(parent);
  }
  process.stdout.write(`${JSON.stringify({ kind: 'synthetic-native-directory-mutation', mode: process.argv[5], passed: true })}\n`);
} else if (process.argv[2] === 'creation-failure' || process.argv[2] === 'child-creation-failure') {
  const native = require(process.argv[3]);
  const root = process.argv[4];
  const parent = native.openDirectory(root, 'private', false);
  const before = retainedFixtureDescriptors(root).length;
  const previous = process.umask(0o777);
  let receipt;
  try {
    assert.throws(() => process.argv[2] === 'child-creation-failure' ? native.createPrivateChild(parent, 'rejected-child') : native.createFile(parent, 'rejected-staging'), (error) => {
      assert.equal(error.code, 'EACCES');
      assert.equal(error.creation.entryCreated, true);
      if (process.argv[2] === 'child-creation-failure') assert.equal(error.publicationState, 'published');
      receipt = error.creation;
      return true;
    });
  } finally {
    process.umask(previous);
  }
  assert.equal(retainedFixtureDescriptors(root).length, before);
  native.close(parent);
  assert.deepEqual(retainedFixtureDescriptors(root), []);
  process.stdout.write(`${JSON.stringify({ creation: receipt })}\n`);
} else if (process.argv[2] === 'read-fault') {
  const native = require(process.argv[3]);
  const parent = native.openDirectory(process.argv[4], 'source', false);
  const source = native.openSource(parent, 'source');
  const mode = process.env.PRIVATE_STORAGE_FAULT_MODE;
  try {
    if (mode === 'short' || mode === 'eintr') {
      assert.equal(native.read(source, 8).toString(), 'abcdefgh');
      assert.equal(native.read(source, 1).length, 0);
    } else {
      assert.throws(() => native.read(source, 8), (error) => {
        assert.equal(error.code, 'EIO');
        assert.equal(error.syscall, 'read');
        assert.equal(error.confirmedBytes, mode === 'partial-error' ? 2 : 0);
        assert.equal(error.totalBytesRead, mode === 'partial-error' ? '2' : '0');
        return true;
      });
      assert.throws(() => native.read(source, 8), { code: 'EBADF' });
    }
  } finally {
    native.close(source);
    native.close(parent);
  }
  process.stdout.write(`${JSON.stringify({ kind: 'synthetic-native-read-fault', mode, passed: true })}\n`);
}
