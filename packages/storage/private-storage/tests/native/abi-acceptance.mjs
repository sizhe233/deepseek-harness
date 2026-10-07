/** Persist the existing independent SDK ABI assertions as a source-bound preflight report. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [oracle, abi, output] = process.argv.slice(2)
assert.ok(oracle && abi && output, 'Usage: node abi-acceptance.mjs ORACLE_EXE ABI_JSON OUTPUT_JSON')
assert.equal(existsSync(output), false, 'ABI report cannot reuse existing evidence')
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const oracleSha256 = hash(oracle), abiSha256 = hash(abi)
await import('./verify-abi.mjs')
assert.equal(hash(oracle), oracleSha256, 'SDK oracle changed during ABI verification')
assert.equal(hash(abi), abiSha256, 'Candidate ABI changed during verification')
writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, complete: true, status: 'passed', check: 'sdk-ffi-abi',
  nativeExecution: process.platform === 'win32', platform: process.platform, architecture: process.arch,
  sourceSha: process.env.CANDIDATE_SHA ?? null, oracleSha256, abiSha256,
  oracleSourceSha256: hash(fileURLToPath(new URL('windows-oracle.c', import.meta.url))),
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
