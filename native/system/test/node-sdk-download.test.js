import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadNodeSdk } from '../scripts/download-node-sdk.mjs';

const url = new URL('https://nodejs.org/dist/v24.21.0/SHASUMS256.txt');

function responseFixture(chunks, headers = {}, status = 200) {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk instanceof Error) controller.error(chunk);
      else if (chunk === undefined) controller.close();
      else controller.enqueue(Buffer.from(chunk));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers, status }), body, reads: () => reads, cancelled: () => cancelled };
}

async function withFetch(t, fetchResponse, run) {
  const original = globalThis.fetch;
  const mocked = t.mock.method(globalThis, 'fetch', async (requested, options) => {
    assert.equal(requested.href, url.href);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['accept-encoding'], 'identity');
    assert.ok(options.signal instanceof AbortSignal);
    return typeof fetchResponse === 'function' ? fetchResponse(options.signal) : fetchResponse;
  });
  try { return await run(); }
  finally {
    mocked.mock.restore();
    assert.equal(globalThis.fetch, original);
  }
}

for (const headers of [{}, { 'content-length': '4' }]) {
  test(`SDK downloads accept bounded streams ${'content-length' in headers ? 'with' : 'without'} Content-Length`, async (t) => {
    const f = responseFixture(['ab', '', 'cd'], headers);
    await withFetch(t, f.response, async () => assert.deepEqual(await downloadNodeSdk(url, 4), Buffer.from('abcd')));
    assert.equal(f.body.locked, false);
  });
}

for (const declared of ['', '-1', '+4', '1.5', '1e2', '0x4', 'NaN', 'Infinity', '4, 4', '0', '5', '9007199254740992']) {
  test(`SDK downloads reject malformed or oversized Content-Length ${JSON.stringify(declared)} before reading`, async (t) => {
    const f = responseFixture(['body'], { 'content-length': declared });
    await withFetch(t, f.response, () => assert.rejects(downloadNodeSdk(url, 4), /Content-Length is (malformed|out of bounds)/));
    assert.equal(f.reads(), 0);
    assert.equal(f.cancelled(), true);
    assert.equal(f.body.locked, false);
  });
}

for (const headers of [{}, { 'content-length': '4' }]) {
  test(`SDK downloads cancel an oversized ${'content-length' in headers ? 'declared' : 'lengthless'} stream immediately`, async (t) => {
    const f = responseFixture(['ab', 'cde', 'must not be read'], headers);
    await withFetch(t, f.response, () => assert.rejects(downloadNodeSdk(url, 4), /body exceeds the byte limit/));
    assert.equal(f.reads(), 2);
    assert.equal(f.cancelled(), true);
    assert.equal(f.body.locked, false);
  });
}

test('SDK downloads reject extra bytes even below the overall limit', async (t) => {
  const f = responseFixture(['ab', 'cd', 'must not be read'], { 'content-length': '3' });
  await withFetch(t, f.response, () => assert.rejects(downloadNodeSdk(url, 8), /body exceeds Content-Length/));
  assert.equal(f.reads(), 2);
  assert.equal(f.cancelled(), true);
  assert.equal(f.body.locked, false);
});

test('SDK downloads reject a truncated declared body', async (t) => {
  const f = responseFixture(['ab'], { 'content-length': '4' });
  await withFetch(t, f.response, () => assert.rejects(downloadNodeSdk(url, 4), /body is truncated/));
  assert.equal(f.body.locked, false);
});

test('SDK downloads reject empty lengthless bodies', async (t) => {
  const f = responseFixture(['']);
  await withFetch(t, f.response, () => assert.rejects(downloadNodeSdk(url, 4), /body is empty/));
  assert.equal(f.body.locked, false);
});

test('SDK downloads reject missing bodies', async (t) => {
  await withFetch(t, new Response(null), () => assert.rejects(downloadNodeSdk(url, 4), /response has no body/));
});

test('SDK downloads preserve transport failures after a partial body', async (t) => {
  const failure = new Error('connection terminated');
  const f = responseFixture(['ab', failure]);
  await withFetch(t, f.response, () => assert.rejects(downloadNodeSdk(url, 4), error => error === failure));
  assert.equal(f.body.locked, false);
});

for (const status of [302, 404, 500]) {
  test(`SDK downloads reject HTTP ${status} and cancel the response`, async (t) => {
    const f = responseFixture(['error'], {}, status);
    await withFetch(t, f.response, () => assert.rejects(downloadNodeSdk(url, 8), /Official SDK download failed/));
    assert.equal(f.reads(), 0);
    assert.equal(f.cancelled(), true);
    assert.equal(f.body.locked, false);
  });
}

test('SDK downloads reject nonofficial or insecure URLs before fetch', async (t) => {
  await withFetch(t, () => assert.fail('fetch must not run'), async () => {
    for (const value of ['http://nodejs.org/dist/file', 'https://example.com/file', 'https://nodejs.org:444/file']) {
      await assert.rejects(downloadNodeSdk(new URL(value), 4), /require official HTTPS/);
    }
  });
});

test('SDK downloads reject unbounded or invalid byte limits before fetch', async (t) => {
  await withFetch(t, () => assert.fail('fetch must not run'), async () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(downloadNodeSdk(url, limit), /positive safe integer/);
    }
  });
});

test('SDK downloads retain the 120-second deadline through body consumption', async (t) => {
  const controller = new AbortController();
  const original = AbortSignal.timeout;
  const timeout = t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 120000);
    return controller.signal;
  });
  const failure = new DOMException('SDK download deadline', 'TimeoutError');
  let body;
  try {
    await withFetch(t, signal => {
      assert.equal(signal, controller.signal);
      body = new ReadableStream({
        start(stream) {
          signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
        },
        pull() { controller.abort(failure); },
      }, { highWaterMark: 0 });
      return new Response(body);
    }, () => assert.rejects(downloadNodeSdk(url, 4), error => error === failure));
    assert.equal(body.locked, false);
  } finally {
    timeout.mock.restore();
    assert.equal(AbortSignal.timeout, original);
  }
});
