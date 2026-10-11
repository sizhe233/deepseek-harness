/** Static command-file guards; real compiler and SDK evidence belongs to the Windows packed lanes. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const scripts = ['private-storage-native.ps1', 'private-storage-sdk-matrices.ps1']

function commandFile(source) {
  assert.match(source, /^\s*& \$env:ComSpec \/d \/c \$commandFile 2>&1 \| Tee-Object -FilePath \$(?:compilerLog|log)$/mu,
    'cmd.exe must receive the command-file path without nested command quoting')
  const block = source.match(/@\('@echo off',[\s\S]+?Set-Content -LiteralPath \$commandFile -Encoding ascii/u)?.[0]
  assert.ok(block, 'Compiler commands must be retained in a command file')
  return block
}

function requireFailurePropagation(block) {
  assert.match(block, /"call `"\$developer`" -no_logo -arch=x64 -host_arch=x64",\s*'if errorlevel 1 exit \/b %errorlevel%'/u)
  assert.match(block, /\/link Advapi32\.lib",\s*'if errorlevel 1 exit \/b %errorlevel%', 'set WindowsSDK', 'exit \/b %errorlevel%'/u)
}

for (const script of scripts) {
  const source = readFileSync(new URL(script, import.meta.url), 'utf8')

  test(`${script} keeps shell quoting inside a retained command file`, () => {
    const block = commandFile(source)
    assert.match(block, /'setlocal DisableDelayedExpansion'/u)
    assert.match(block, /'set CL=', 'set _CL_=', 'set LINK=', 'set _LINK_='/u)
    assert.match(block, /`"\$compilerPath`" \/nologo \/Bv \/std:c17 \/W4 \/WX \/wd4191 \/TC \/DUNICODE \/D_UNICODE/u)
    assert.match(block, /`"\$source`" \/Fo`"\$object`" \/Fe`"\$binary`"/u)
    requireFailurePropagation(block)
  })

  test(`${script} rejects the nested inline invocation regression`, () => {
    const regressed = source.replace('& $env:ComSpec /d /c $commandFile', '& $env:ComSpec /d /s /c "`"$command`""')
    assert.notEqual(regressed, source)
    assert.throws(() => commandFile(regressed), /without nested command quoting/u)
  })

  test(`${script} rejects setup or compiler failures hidden by later commands`, () => {
    const block = commandFile(source)
    for (const index of [block.indexOf("'if errorlevel"), block.lastIndexOf("'if errorlevel")]) {
      const regressed = block.slice(0, index) + block.slice(index).replace("'if errorlevel 1 exit /b %errorlevel%',", '')
      assert.throws(() => requireFailurePropagation(regressed))
    }
  })
}
