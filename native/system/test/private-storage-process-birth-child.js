/** An owned child reports its own birth and exits through its test IPC channel. */
import { createRequire } from 'node:module';

const native = createRequire(import.meta.url)(process.argv[2]);
const deadline = setTimeout(() => {
  if (process.connected) process.disconnect();
}, 10_000);
deadline.unref();
process.on('message', (message) => {
  if (message === 'exit') {
    clearTimeout(deadline);
    if (process.connected) process.disconnect();
  }
});
try {
  const birth = native.observeProcessBirth(process.pid);
  let parentRefusal = null;
  try { native.observeProcessBirth(process.ppid); }
  catch (error) {
    parentRefusal = {
      code: error.code, reason: error.reason,
      observationOnly: error.observationOnly, exitConfirmed: error.exitConfirmed,
    };
  }
  process.send({ birth, parentRefusal });
} catch (error) {
  process.send({ error: { code: error.code, reason: error.reason, message: error.message } });
  clearTimeout(deadline);
  process.disconnect();
}
