/** Source-instrumented Windows owner evidence. This never certifies a packed native payload. */
import assert from 'node:assert/strict'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ownerProductionSha256, ownerFaultSources, ownerDigest, ownerLibraryDirectories } from '../../../../../workbench/private-storage-owner-fault-evidence.mjs'
export * from '../../../../../workbench/private-storage-owner-fault-evidence.mjs'

export const ownerProductionFile = fileURLToPath(new URL('../../../../../native/system/packages/entry/src/windows-private-owner.c', import.meta.url))
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export const ownerFileDigest = path => { assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()); return ownerDigest(readFileSync(path)) }

/** Bind every source input, including unchanged production C and imported orchestration helpers. */
export function ownerSourceBinding() {
  assert.equal(ownerFileDigest(ownerProductionFile), ownerProductionSha256, 'Production owner source differs from reviewed instrumentation pin')
  const fixtureSources = Object.fromEntries(ownerFaultSources.map(path => [path, ownerFileDigest(join(root, path))]))
  return { productionSourceSha256: ownerProductionSha256, fixtureSources, fixtureSourceSha256: ownerDigest(JSON.stringify(fixtureSources)) }
}

/** Reject stale source, compiler input, binary, or instrumentation evidence before loading the fixture. */
export function ownerFaultBinding(binary) {
  const actual = realpathSync(binary), buildPath = join(dirname(actual), 'owner-fault-build.json')
  const build = JSON.parse(readFileSync(buildPath, 'utf8')), source = ownerSourceBinding()
  assert.equal(build.schemaVersion, 1); assert.equal(build.evidence, 'source-instrumented-native-owner-faults')
  assert.equal(build.complete, true); assert.equal(build.exitCode, 0); assert.equal(build.sourceUnchanged, true)
  assert.equal(build.platform, 'win32'); assert.equal(build.architecture, 'x64'); assert.equal(build.nodeVersion, process.version)
  assert.equal(build.productionSourceSha256, ownerProductionSha256)
  assert.deepEqual(build.fixtureSources, source.fixtureSources)
  assert.equal(build.fixtureSourceSha256, source.fixtureSourceSha256)
  assert.equal(build.binary, 'owner-fault-fixture.node'); assert.equal(actual, realpathSync(join(dirname(actual), build.binary)))
  const fixtureBinarySha256 = ownerFileDigest(actual)
  assert.equal(build.binarySha256, fixtureBinarySha256)
  assert.equal(build.compilerLogSha256, ownerFileDigest(join(dirname(actual), 'owner-fault-compiler.log')))
  assert.equal(build.compiler.binarySha256, ownerFileDigest(build.compiler.path))
  assert.equal(build.compiler.developerScriptSha256, ownerFileDigest(build.compiler.developerScript))
  const output = dirname(actual), sdk = realpathSync(build.nodeSdk)
  assert.deepEqual(build.compiler.arguments, ['/nologo', '/Bv', '/std:c17', '/O2', '/W4', '/WX', '/LD', '/DNAPI_VERSION=8', '/D_WIN32_WINNT=0x0602',
    `/I${join(sdk, 'include/node')}`, '/sourceDependencies', join(output, 'owner-fault-dependencies.json'),
    `/Fo${join(output, 'owner-fault.obj')}`, join(root, 'packages/storage/private-storage/tests/native/owner-fault-fixture.c'),
    '/link', '/VERBOSE:LIB', `/OUT:${actual}`, `/IMPLIB:${join(output, 'owner-fault.lib')}`, join(sdk, 'node.lib'), 'kernel32.lib', 'advapi32.lib'])
  assert.ok(Array.isArray(build.inputs) && build.inputs.length > 5)
  assert.ok(Array.isArray(build.inputsBeforeCompilation) && build.inputsBeforeCompilation.length >= build.inputs.length
    && build.inputsBeforeCompilation.length <= 10000)
  const before = new Map(build.inputsBeforeCompilation.map(input => [realpathSync(input.path).toLowerCase(), input.sha256]))
  assert.equal(before.size, build.inputsBeforeCompilation.length)
  assert.equal(build.discoveryDependenciesSha256, ownerFileDigest(join(output, 'owner-fault-discovery.json')))
  assert.equal(build.discoveryLogSha256, ownerFileDigest(join(output, 'owner-fault-discovery.log')))
  assert.equal(build.librarySearchSha256, ownerFileDigest(join(output, 'owner-fault-library-search.txt')))
  ownerLibraryDirectories(readFileSync(join(output, 'owner-fault-library-search.txt'), 'utf8'))
  assert.deepEqual(build.discoveryArguments, ['/nologo', '/Bv', '/std:c17', '/O2', '/W4', '/WX', '/LD', '/DNAPI_VERSION=8',
    '/D_WIN32_WINNT=0x0602', `/I${join(sdk, 'include/node')}`, '/Zs', '/sourceDependencies', join(output, 'owner-fault-discovery.json'),
    join(root, 'packages/storage/private-storage/tests/native/owner-fault-fixture.c')])
  assert.equal(new Set(build.inputs.map(input => input.path.toLowerCase())).size, build.inputs.length)
  for (const input of build.inputs) {
    assert.equal(input.sha256, before.get(realpathSync(input.path).toLowerCase()), 'Compiler input lacks matching precompile admission')
    assert.equal(input.sha256, ownerFileDigest(input.path))
  }
  const dependencies = JSON.parse(readFileSync(join(output, 'owner-fault-dependencies.json'), 'utf8'))
  assert.ok(Array.isArray(dependencies.Data.Includes) && dependencies.Data.Includes.length > 5)
  const inputPaths = new Set(build.inputs.map(input => realpathSync(input.path).toLowerCase()))
  for (const path of [ownerProductionFile, join(root, 'packages/storage/private-storage/tests/native/owner-fault-fixture.c'),
    join(sdk, 'node.lib'), join(sdk, 'verified.json'), join(sdk, 'headers.tar.gz'), ...dependencies.Data.Includes]) {
    assert.ok(inputPaths.has(realpathSync(path).toLowerCase()), `Unpinned compiler input: ${path}`)
  }
  const compilerLog = readFileSync(join(output, 'owner-fault-compiler.log'), 'utf8')
  const libraries = [...compilerLog.matchAll(/^\s*Searching\s+([A-Z]:\\[^\r\n]+\.lib):\s*$/gimu)]
  assert.ok(libraries.length >= 3)
  for (const [, path] of libraries) assert.ok(inputPaths.has(realpathSync(path).toLowerCase()), 'Unpinned resolved linker library')
  assert.equal(build.dependenciesSha256, ownerFileDigest(join(dirname(actual), 'owner-fault-dependencies.json')))
  assert.equal(build.producedBinarySha256, fixtureBinarySha256)
  assert.equal(build.compilerInputsComplete, true)
  return { ...source, fixtureBinarySha256, fixtureBuildSha256: ownerFileDigest(buildPath), compilerLogSha256: build.compilerLogSha256,
    compilerSha256: build.compiler.binarySha256, build }
}
