/** Bounded HTTPS downloads for the official Node SDK build inputs. */
import assert from 'node:assert/strict';

/**
 * Read a nonempty official response within 120 seconds and the streamed byte limit.
 * An optional Content-Length must be decimal, within the limit, and match the body.
 * @param {URL} url Official nodejs.org URL.
 * @param {number} limit Maximum response bytes.
 * @returns {Promise<Buffer>} Complete response bytes; callers verify artifact checksums.
 */
export async function downloadNodeSdk(url, limit) {
  assert.equal(url.origin, 'https://nodejs.org', 'SDK downloads require official HTTPS');
  assert.ok(Number.isSafeInteger(limit) && limit > 0, 'SDK download limit must be a positive safe integer');
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(120000), headers: { 'accept-encoding': 'identity' },
  });
  const reader = response.body?.getReader();
  try {
    assert.equal(response.status, 200, `Official SDK download failed for ${url.pathname}`);
    assert.ok(reader, 'Official SDK response has no body');
    const declared = response.headers.get('content-length');
    let length = null;
    if (declared !== null) {
      assert.match(declared, /^\d+$/, 'Official SDK Content-Length is malformed');
      length = Number(declared);
      assert.ok(Number.isSafeInteger(length) && length > 0 && length <= limit, 'Official SDK Content-Length is out of bounds');
    }
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert.ok(Number.isSafeInteger(bytes) && bytes <= limit, 'Official SDK body exceeds the byte limit');
      assert.ok(length === null || bytes <= length, 'Official SDK body exceeds Content-Length');
      if (value.byteLength > 0) chunks.push(value);
    }
    assert.ok(bytes > 0, 'Official SDK body is empty');
    if (length !== null) assert.equal(bytes, length, 'Official SDK body is truncated');
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    try { await reader?.cancel(error); }
    catch (cancelError) { /* An errored stream may reject cancellation; retain the download failure. */ }
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
