/** Compare the compiled SDK with FFI offsets from a source module or immutable built ABI JSON. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [oraclePath, abiModule] = process.argv.slice(2)
assert.ok(oraclePath && abiModule, 'Usage: node verify-abi.mjs ORACLE_EXE ABI_MODULE_OR_JSON')
assert.equal(process.platform, 'win32', 'ABI acceptance requires native Windows')
assert.equal(process.arch, 'x64', 'Only the Windows x64 candidate is currently admitted')
const child = spawnSync(resolve(oraclePath), ['abi'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
assert.ifError(child.error)
assert.equal(child.signal, null)
assert.equal(child.status, 0, child.stderr)
const oracle = JSON.parse(child.stdout)
assert.equal(oracle.complete, true)
assert.equal(oracle.ntstatusSigned, true)
assert.equal(oracle.ntstatusBytes, 4)
assert.equal(oracle.constants.statusAccessDeniedSigned, -1073741790)
assert.equal(oracle.constants.statusPending, 259)
const s = oracle.structures
const jsonInput = abiModule.endsWith('.json')
const ABI = jsonInput ? JSON.parse(readFileSync(resolve(abiModule), 'utf8')) : (await import(pathToFileURL(resolve(abiModule)).href)).ABI
const expected = {
  pointer: oracle.pointerBytes,
  unicodeString: s.UNICODE_STRING.size,
  unicodeBuffer: s.UNICODE_STRING.Buffer,
  objectAttributes: s.OBJECT_ATTRIBUTES.size,
  objectRoot: s.OBJECT_ATTRIBUTES.RootDirectory,
  objectName: s.OBJECT_ATTRIBUTES.ObjectName,
  objectFlags: s.OBJECT_ATTRIBUTES.Attributes,
  objectDescriptor: s.OBJECT_ATTRIBUTES.SecurityDescriptor,
  ioStatus: s.IO_STATUS_BLOCK.size,
  ioInformation: s.IO_STATUS_BLOCK.Information,
  renameSize: s.FILE_RENAME_INFO.size,
  renameRoot: s.FILE_RENAME_INFO.RootDirectory,
  renameLength: s.FILE_RENAME_INFO.FileNameLength,
  renameName: s.FILE_RENAME_INFO.FileName,
  fileId: s.FILE_ID_INFO.size,
  basic: s.FILE_BASIC_INFO.size,
  standard: s.FILE_STANDARD_INFO.size,
  mode: s.FILE_MODE_INFORMATION.size,
  overlapped: s.OVERLAPPED.size,
  descriptor: s.SECURITY_DESCRIPTOR_RELATIVE.size,
  acl: s.ACL.size,
  aceSid: s.ACCESS_ALLOWED_ACE.SidStart,
}
assert.deepEqual(ABI, expected, 'Actual FFI byte offsets differ from the independently compiled SDK')
console.log(JSON.stringify({ complete: true, status: 'passed', check: 'sdk-ffi-abi', abiInput: jsonInput ? 'candidate-build-json' : 'source-module', fields: Object.keys(expected).length, oracle }))
