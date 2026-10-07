/** Actual provider-wrapper lifetime checks in a separate Node environment. */
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'linux')('finished source readers retain no directory wrapper through their closures', () => {
  const entry = new URL('../src/native-posix.ts', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {mkdtempSync,writeFileSync,statSync,readdirSync,readlinkSync,rmSync,realpathSync} from 'node:fs';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    import {setTimeout as delay} from 'node:timers/promises';
    const api=await import(${JSON.stringify(entry)});
    const root=mkdtempSync(join(realpathSync(tmpdir()),'posix-wrapper-lifetime-'));
    try {
      const data=Buffer.from('source-lifetime'), file=join(root,'source');
      writeFileSync(file,data,{mode:0o444});
      const stat=statSync(file,{bigint:true});
      const count=()=>readdirSync('/proc/self/fd').filter(fd=>{
        try {const value=readlinkSync('/proc/self/fd/'+fd);return value===root||value.startsWith(root+'/');}
        catch(error){if(error.code==='ENOENT')return false;throw error;}
      }).length;
      assert.equal(count(),0);
      let directory=api.openPosixSourceDirectory(root);
      const reader=api.openPosixSourceFileReader(directory,'source',{
        expectedIdentity:{backend:'posix',device:String(stat.dev),inode:String(stat.ino)},
        expectedBytes:data.length,expectedSha256:createHash('sha256').update(data).digest('hex')
      });
      assert.ok(count()>=2);
      directory=null;
      reader.readChunk(data.length);
      assert.equal(reader.finish().verification,'verified');
      globalThis.retainedFinishedReader=reader;
      const deadline=Date.now()+5000;
      while(count()!==0&&Date.now()<deadline){global.gc();await delay(20);}
      assert.equal(count(),0,'a finished reader must not retain its caller directory capability');
      assert.equal(reader.receipt.verification,'verified');
      console.log(JSON.stringify({passed:true,finishedReaderRetained:true,remainingDescriptors:count(),nativeDestinationAcceptance:false}));
    } finally {rmSync(root,{recursive:true,force:true});}
  `
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx/esm', '--input-type=module', '--eval', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ passed: true, remainingDescriptors: 0 })
}, 20_000)
