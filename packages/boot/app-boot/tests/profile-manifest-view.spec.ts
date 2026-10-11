/** Managed manifest reads use their admitted version and never reopen original files. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { readProfileManifest } from '../src/profile.ts'
import {
  createProfileDocumentView, type ProfileCodeBindingReference, type ProfileDocumentReference,
  type ProfileDocumentViewReference, type ProfilePackageDocumentsReference,
} from '../src/profile-document-view.ts'

function fixture(original: string, admitted: string | undefined, listed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'profile-manifest-view-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const file = join(dir, 'package.json')
  writeFileSync(file, original)
  const view = createProfileDocumentView({
    reference: brandString<ProfileDocumentViewReference>('view'),
    selection: {
      profileDir: dir, home: dir,
      codeBinding: brandString<ProfileCodeBindingReference>('code'),
      packageDocuments: brandString<ProfilePackageDocumentsReference>('packages'),
    },
    documents: listed ? [{
      logicalPath: file, reference: brandString<ProfileDocumentReference>('manifest'),
      ...admitted === undefined ? { state: 'absent' as const } : { state: 'present' as const, text: admitted },
    }] : [],
  })
  return { dir, file, view }
}

it('reads the admitted manifest and preserves an unreadable original verbatim', () => {
  const original = 'invalid original JSON\n'
  const { dir, file, view } = fixture(original, '{"dependencies":{"fixture":"1.0.0"}}')
  expect(readProfileManifest('test', dir, view)).toEqual({ dependencies: { fixture: '1.0.0' } })
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(() => readProfileManifest('test', dir)).toThrow()
})

it.each([true, false])('refuses unavailable admitted manifest without original fallback; listed=%s', (listed) => {
  const { dir, file, view } = fixture('{"name":"original"}', undefined, listed)
  expect(() => readProfileManifest('test', dir, view)).toThrow(listed ? 'manifest is absent' : 'outside the admitted view')
  expect(readFileSync(file, 'utf8')).toBe('{"name":"original"}')
})

it.each(['null', '[]', '"manifest"', '{'])('validates admitted manifest data: %s', (admitted) => {
  const { dir, view } = fixture('{"name":"original"}', admitted)
  expect(() => readProfileManifest('test', dir, view)).toThrow()
})
