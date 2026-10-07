import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import yaml from 'js-yaml'
import { zipSync, strToU8, Zip, ZipDeflate } from 'fflate'

const require = createRequire(import.meta.url)
const workflow = yaml.load(readFileSync(new URL('../.github/workflows/fork-ci.yml', import.meta.url), 'utf8'))
const locator = workflow.jobs['private-storage-artifact']
const script = locator.steps.find(step => step.id === 'candidate').with.script
const source = 'a'.repeat(40)
const manifest = { commit: source, source: { commit: source, tree: 'b'.repeat(40), repository: 'owner/repository' }, build: { platform: 'linux' }, packages: [], dependencyPatches: [], privateStorageAcceptance: { schemaVersion: 1, nativeClosure: { packages: [] }, ordinaryDependencies: [], toolkit: { files: [] } } }
const payload = Buffer.from(zipSync({ [`${source}/candidate.json`]: strToU8(JSON.stringify(manifest)) }))
const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`
const artifact = { id: 123, name: `host-candidate-${source}`, expired: false, digest, size_in_bytes: payload.length, workflow_run: { id: 42, head_sha: source } }

async function execute({ run = { id: 42, head_sha: source }, artifacts = [artifact], jobs = [], bytes = payload, now } = {}) {
  const outputs = {}, calls = []
  const actions = {
    getWorkflowRun: async params => { calls.push(['run', params]); return { data: run } },
    listWorkflowRunArtifacts: Symbol('artifacts'), listJobsForWorkflowRun: Symbol('jobs'),
    downloadArtifact: async params => { calls.push(['download', params]); return { data: bytes } },
  }
  const github = { rest: { actions }, paginate: async (method, params) => {
    calls.push(['paginate', params]); return method === actions.listWorkflowRunArtifacts ? artifacts : jobs
  } }
  await runInNewContext(`(async () => { ${script} })()`, {
    require, Buffer, process: { env: { CANDIDATE_SHA: source } }, github,
    context: { repo: { owner: 'owner', repo: 'repository' }, runId: 42 },
    core: { setOutput: (key, value) => { outputs[key] = value } },
    Date: now ? { now } : Date, setTimeout: callback => callback(),
  })
  return { outputs, calls }
}

test('same-run immutable ZIP is hashed and its source-bound manifest digest is returned', async () => {
  const { outputs, calls } = await execute()
  assert.deepEqual(outputs, { 'artifact-id': '123', 'artifact-digest': digest,
    'manifest-sha256': createHash('sha256').update(JSON.stringify(manifest)).digest('hex') })
  assert.ok(calls.filter(([kind]) => kind === 'paginate').every(([, params]) => params.run_id === 42 && params.per_page === 100))
})
for (const [name, changed] of [
  ['wrong run', { workflow_run: { id: 41, head_sha: source } }],
  ['wrong head', { workflow_run: { id: 42, head_sha: 'c'.repeat(40) } }],
  ['missing digest', { digest: undefined }], ['invalid id', { id: -1 }], ['expired', { expired: true }],
  ['oversize', { size_in_bytes: 32 * 1024 * 1024 + 1 }], ['wrong digest', { digest: `sha256:${'0'.repeat(64)}` }],
]) test(`rejects ${name} before emitting acceptance outputs`, async () => { await assert.rejects(execute({ artifacts: [{ ...artifact, ...changed }] })) })
test('rejects duplicate names across paginated candidate matches', async () => {
  await assert.rejects(execute({ artifacts: [artifact, { ...artifact, id: 124 }] }), /Ambiguous same-name/u)
})
test('rejects a workflow with the wrong source or run before downloading', async () => {
  await assert.rejects(execute({ run: { id: 42, head_sha: 'f'.repeat(40) } }), /Wrong workflow source/u)
  await assert.rejects(execute({ run: { id: 43, head_sha: source } }), /Wrong workflow run/u)
})
test('stops when the producer has terminated without publishing an artifact', async () => {
  for (const conclusion of ['success', 'failure', 'cancelled']) await assert.rejects(execute({ artifacts: [], jobs: [{ name: 'linux-build-and-test', status: 'completed', conclusion }] }), /producer terminated/u)
})
test('bounds an absent candidate by the existing producer execution window', async () => {
  let time = 0
  await assert.rejects(execute({ artifacts: [], now: () => { time += 185 * 60 * 1000; return time } }), /execution window/u)
})
test('rejects a ZIP manifest naming different source bytes', async () => {
  const wrong = Buffer.from(zipSync({ [`source/candidate.json`]: strToU8(JSON.stringify(manifest)) }))
  await assert.rejects(execute({ bytes: wrong, artifacts: [{ ...artifact, digest: `sha256:${createHash('sha256').update(wrong).digest('hex')}` }] }), /outside candidate root|manifest is missing/u)
})
test('only the locator gains actions read and all existing checks remain required', () => {
  assert.deepEqual(locator.permissions, { contents: 'read', actions: 'read' })
  const packed = workflow.jobs['private-storage-packed']
  assert.deepEqual(packed.permissions, { contents: 'read' })
  const download = packed.steps.find(step => step.uses === 'actions/download-artifact@v4')
  assert.deepEqual(download.with, { 'artifact-ids': '${{ needs.private-storage-artifact.outputs.artifact-id }}', 'merge-multiple': true, path: 'candidate' })
  assert.deepEqual(packed.strategy.matrix.include, [
    { os: 'ubuntu-24.04', node: '24' }, { os: 'macos-15', node: '24' },
    { os: 'windows-2025', node: '22.19.0' }, { os: 'windows-2025', node: '24' },
  ])
  assert.ok(!packed.steps.some(step => step.uses?.startsWith('actions/checkout') || /pnpm install|npm install/u.test(step.run ?? '')))
  assert.deepEqual(workflow.jobs['build-and-test'].needs, ['linux-build-and-test', 'source-coverage', 'node-22-compatibility', 'native-platforms', 'private-storage-packed'])
  assert.ok(workflow.jobs['native-platforms'].steps.some(step => step.name === 'Diagnose macOS PowerShell input modes'))
})

const zipFor = (entries = {}, record = manifest) => Buffer.from(zipSync({ [`${source}/candidate.json`]: strToU8(JSON.stringify(record)), ...entries }, { level: 0 }))
const executeZip = bytes => execute({ bytes, artifacts: [{ ...artifact, size_in_bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] })

for (const path of ['../outside.txt', '/absolute.txt', `${source}/../escape.txt`, `${source}/stream:other`, `${source}/CON.txt`, `${source}/trail.`, `${source}/back\\slash`, `${source}/line\nname`]) {
  test(`rejects unsafe outer ZIP path ${JSON.stringify(path)} before extraction`, async () => {
    await assert.rejects(executeZip(zipFor({ [path]: strToU8('synthetic') })), /ZIP path|candidate root/)
  })
}

test('rejects unlisted ZIP files, case collisions and file/directory conflicts', async () => {
  for (const entries of [
    { [`${source}/unlisted.txt`]: strToU8('extra') },
    { [`${source}/A.txt`]: strToU8('a'), [`${source}/a.txt`]: strToU8('b') },
    { [`${source}/parent`]: strToU8('file'), [`${source}/parent/child.txt`]: strToU8('child') },
    { [`${source}/unused/`]: new Uint8Array() },
  ]) await assert.rejects(executeZip(zipFor(entries)), /inventory|colliding|conflict|Unlisted/)
})

test('rejects outer ZIP symlinks and special types', async () => {
  for (const kind of [0o120777, 0o010600, 0o060600]) {
    const bytes = zipFor({ [`${source}/linked`]: [strToU8('target'), { os: 3, attrs: kind << 16 }] })
    await assert.rejects(executeZip(bytes), /ZIP link or special type/)
  }
})

test('checks the complete ZIP inventory and all hashes before emitting the artifact ID', async () => {
  const record = structuredClone(manifest)
  const entries = {}
  const ordinary = (file, content) => {
    const bytes = strToU8(content)
    entries[`${source}/${file}`] = bytes
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  record.packages.push(ordinary('storage.tgz', 'synthetic package'))
  const patch = ordinary('dependency-patches/@name__pkg@1.0.0.patch', 'synthetic patch')
  record.dependencyPatches.push({ patchFile: patch.file, patchBytes: patch.bytes, patchSha256: patch.sha256 })
  record.privateStorageAcceptance.nativeClosure.packages.push(ordinary('private-storage-native/koffi.tgz', 'synthetic native'))
  record.privateStorageAcceptance.ordinaryDependencies.push(ordinary('support.tgz', 'synthetic support'))
  const toolkit = ordinary('private-storage-tests/runner.mjs', 'synthetic inert fixture')
  record.privateStorageAcceptance.toolkit.files.push({ path: toolkit.file, bytes: toolkit.bytes, sha256: toolkit.sha256 })
  const success = await executeZip(zipFor(entries, record))
  assert.equal(success.outputs['artifact-id'], String(artifact.id))
  for (const name of Object.keys(entries)) {
    await assert.rejects(executeZip(zipFor({ ...entries, [name]: new Uint8Array(entries[name].length) }, record)), /bytes differ from inventory/)
  }
  const missing = { ...entries }; delete missing[Object.keys(missing)[0]]
  await assert.rejects(executeZip(zipFor(missing, record)), /complete hashed file inventory/)
})

test('bounds outer ZIP entry count, per-file size and aggregate expansion before reading members', async () => {
  const many = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`${source}/f${i}`, new Uint8Array()]))
  await assert.rejects(executeZip(zipFor(many)), /entry count limit/)
  function inflateDeclaredSizes(bytes, expanded) {
    const copy = Buffer.from(bytes)
    for (let i = 0; i <= copy.length - 46; i++) {
      if (copy.readUInt32LE(i) === 0x02014b50) copy.writeUInt32LE(expanded, i + 24)
    }
    return copy
  }
  await assert.rejects(executeZip(inflateDeclaredSizes(zipFor(), 64 * 1024 * 1024 + 1)), /entry size limit/)
  const three = zipFor({ [`${source}/a`]: new Uint8Array(), [`${source}/b`]: new Uint8Array() })
  await assert.rejects(executeZip(inflateDeclaredSizes(three, 64 * 1024 * 1024)), /total expansion limit/)
})

test('rejects local-header mismatch and CRC corruption through the maintained ZIP reader', async () => {
  const localMismatch = Buffer.from(payload)
  localMismatch[30] ^= 1
  await assert.rejects(executeZip(localMismatch), /ZIP local name differs|File name in directory.*header .* differ/)
  const stored = zipFor()
  const dataStart = 30 + stored.readUInt16LE(26) + stored.readUInt16LE(28)
  stored[dataStart] ^= 1
  await assert.rejects(executeZip(stored), /Bad CRC/)
})

test('accepts producer-style streaming ZIP descriptors and rejects a changed descriptor', async () => {
  const parts = []
  let complete = false
  const zip = new Zip((error, data, final) => { assert.ifError(error); parts.push(Buffer.from(data)); complete = final })
  const file = new ZipDeflate(`${source}/candidate.json`)
  zip.add(file)
  file.push(strToU8(JSON.stringify(manifest)), true)
  zip.end()
  assert.equal(complete, true)
  const bytes = Buffer.concat(parts)
  assert.equal(bytes.readUInt16LE(6) & 8, 8)
  assert.equal((await executeZip(bytes)).outputs['artifact-id'], String(artifact.id))
  const corrupted = Buffer.from(bytes)
  const descriptor = corrupted.indexOf(Buffer.from('504b0708', 'hex'))
  assert.ok(descriptor > 0)
  corrupted[descriptor + 4] ^= 1
  await assert.rejects(executeZip(corrupted), /ZIP data descriptor differs/)
})

test('rejects central-directory-hidden local members and prefixed data', async () => {
  const bytes = zipFor({ [`${source}/hidden.mjs`]: strToU8('synthetic inert fixture') })
  const end = bytes.length - 22
  const centralStart = bytes.readUInt32LE(end + 16)
  const firstLength = 46 + bytes.readUInt16LE(centralStart + 28) + bytes.readUInt16LE(centralStart + 30) + bytes.readUInt16LE(centralStart + 32)
  const closing = Buffer.from(bytes.subarray(end))
  closing.writeUInt16LE(1, 8); closing.writeUInt16LE(1, 10); closing.writeUInt32LE(firstLength, 12)
  const orphan = Buffer.concat([bytes.subarray(0, centralStart + firstLength), closing])
  await assert.rejects(executeZip(orphan), /orphan|gap/)
  await assert.rejects(executeZip(Buffer.concat([Buffer.from('prefix'), payload])), /orphan|prefix|gap/)
})
