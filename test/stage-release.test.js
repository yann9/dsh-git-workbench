import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const script = path.join(import.meta.dirname, '..', 'scripts', 'stage-release.js')

const PACKAGE_NAME = '@yann9/dsh-git-workbench'
const STAGE_ID = '11111111-2222-3333-4444-555555555555'

/** The files DSH needs inside the tarball; the script checks for each one. */
const REQUIRED = [
  'cordis.patch.yml',
  'src/index.js',
  'src/client/browser.js',
  'src/client/client.core.js',
  'src/client/client.diff.js',
  'src/client/client.i18n.js',
  'src/client/client.panes.js',
  'src/client/client.shell.js',
  'src/client/client.styles.js',
  'src/client/client.ui.js',
  'locale/en.json',
  'locale/zh.json',
  'assets/icon.png',
]

/** A stand-in for the npm CLI: it answers the three calls the script makes. */
const STUB = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const process = require('node:process')

const args = process.argv.slice(2)
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n')

const name = process.env.STUB_PKG || '${PACKAGE_NAME}'
const version = process.env.STUB_VERSION || '1.2.3'

if (args[0] === 'view') {
  if (process.env.STUB_PUBLISHED === '1') {
    process.stdout.write(JSON.stringify(version) + '\\n')
    process.exit(0)
  }
  process.stderr.write('npm error code E404\\n')
  process.exit(1)
}

if (args[0] === 'stage' && args[1] === 'publish') {
  if (process.env.STUB_PUBLISH_FAIL === '1') {
    process.stdout.write(JSON.stringify({
      error: { summary: 'staging failed', detail: 'the registry said no' },
    }) + '\\n')
    process.exit(1)
  }
  const files = JSON.parse(process.env.STUB_FILES || '[]')
  process.stdout.write(JSON.stringify({
    [name]: {
      id: name + '@' + version,
      name,
      version,
      stageId: process.env.STUB_STAGE_ID || '${STAGE_ID}',
      files: files.map((file) => ({ path: file, size: 10, mode: 420 })),
      bundled: [],
    },
  }) + '\\n')
  process.exit(0)
}

if (args[0] === 'stage' && args[1] === 'list') {
  const items = process.env.STUB_STAGED === '1'
    ? [{ id: process.env.STUB_STAGE_ID || '${STAGE_ID}', packageName: name, version, tag: 'latest' }]
    : []
  process.stdout.write(JSON.stringify(items) + '\\n')
  process.exit(0)
}

process.exit(0)
`

/**
 * A scratch package the script can stage: a manifest, the bundle patch and a
 * stub npm that records what it was asked.
 */
function scratch(version = '1.2.3') {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-stage-'))
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: PACKAGE_NAME, version }, null, 2)}\n`,
  )
  writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    `- insert:\n    - id: git-workbench\n      name: '${PACKAGE_NAME}'\n`,
  )
  const stubPath = path.join(dir, 'stub.cjs')
  writeFileSync(stubPath, STUB)
  let command = stubPath
  if (process.platform === 'win32') {
    command = path.join(dir, 'stub.cmd')
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${stubPath}" %*\r\n`)
  } else {
    chmodSync(stubPath, 0o755)
  }
  return { dir, command, log: path.join(dir, 'calls.log') }
}

function stage(scratchDir, env = {}) {
  return spawnSync(
    process.execPath,
    [script, '--cwd', scratchDir.dir, '--npm', scratchDir.command],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        STUB_LOG: scratchDir.log,
        STUB_PKG: PACKAGE_NAME,
        STUB_VERSION: '1.2.3',
        ...env,
      },
    },
  )
}

/** The argument lists the stub npm was called with, in order. */
function calls(scratchDir) {
  try {
    return readFileSync(scratchDir.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('a version that already reached npm is not staged again', () => {
  const dir = scratch()
  try {
    const result = stage(dir, { STUB_PUBLISHED: '1' })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /already on npm/)
    assert.ok(!calls(dir).some((args) => args[0] === 'stage'))
  } finally {
    rmSync(dir.dir, { recursive: true, force: true })
  }
})

test('a staged release is checked and the stage id is handed back', () => {
  const dir = scratch()
  try {
    const result = stage(dir, { STUB_FILES: JSON.stringify(REQUIRED) })

    assert.equal(result.status, 0)
    assert.match(result.stdout, new RegExp(`stage id ${STAGE_ID}`))
    assert.match(result.stdout, /npm stage approve 11111111-2222-3333-4444-555555555555/)
    // The approve command has to name the official registry; a mirror does not
    // implement the staging endpoints.
    assert.match(result.stdout, /--registry=https:\/\/registry\.npmjs\.org\//)
  } finally {
    rmSync(dir.dir, { recursive: true, force: true })
  }
})

test('a tarball without a client chunk is refused', () => {
  const dir = scratch()
  try {
    const files = REQUIRED.filter((file) => file !== 'src/client/client.diff.js')
    const result = stage(dir, { STUB_FILES: JSON.stringify(files) })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /src\/client\/client\.diff\.js/)
  } finally {
    rmSync(dir.dir, { recursive: true, force: true })
  }
})

test('the design journal never reaches a tarball', () => {
  const dir = scratch()
  try {
    const files = [...REQUIRED, 'docs/internal/design-journal.md']
    const result = stage(dir, { STUB_FILES: JSON.stringify(files) })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\/internal/)
  } finally {
    rmSync(dir.dir, { recursive: true, force: true })
  }
})

test('a prerelease is staged under the next tag', () => {
  const dir = scratch('1.2.3-rc.1')
  try {
    const result = stage(dir, { STUB_FILES: JSON.stringify(REQUIRED), STUB_VERSION: '1.2.3-rc.1' })

    assert.equal(result.status, 0)
    const publish = calls(dir).find((args) => args[0] === 'stage' && args[1] === 'publish')
    assert.equal(publish[publish.indexOf('--tag') + 1], 'next')
  } finally {
    rmSync(dir.dir, { recursive: true, force: true })
  }
})

test('the release and the manifest have to name the same version', () => {
  const dir = scratch()
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--cwd', dir.dir, '--npm', dir.command, '--version', '9.9.9'],
      { encoding: 'utf8', env: { ...process.env, STUB_LOG: dir.log, STUB_PKG: PACKAGE_NAME } },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /package\.json says 1\.2\.3/)
  } finally {
    rmSync(dir.dir, { recursive: true, force: true })
  }
})

test('a failed staging surfaces what npm said', () => {
  const dir = scratch()
  try {
    const result = stage(dir, { STUB_PUBLISH_FAIL: '1' })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /staging failed/)
    assert.match(result.stderr, /the registry said no/)
  } finally {
    rmSync(dir.dir, { recursive: true, force: true })
  }
})
