#!/usr/bin/env node
/**
 * dsh-git-workbench — stage a release on npm and check what is going out.
 *
 * npm's staged publishing uploads the tarball to a queue and waits for the
 * maintainer to approve it with 2FA, so nothing here touches the live
 * registry. The script checks the tarball against the files DSH needs, then
 * prints the stage id and the command that puts it live.
 *
 *   node scripts/stage-release.js --version v0.2.0
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REGISTRY = 'https://registry.npmjs.org/'

/** Files DSH needs inside the tarball; a missing one breaks the install. */
const REQUIRED_FILES = [
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

/** The design journal is gitignored; it must never reach a tarball. */
const FORBIDDEN_PREFIX = 'docs/internal/'

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REGISTRY_RE = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i
const NAME_RE = /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i

function parseArgs(argv) {
  const out = { version: '', registry: REGISTRY, npm: 'npm', cwd: process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version' || arg === '-v') out.version = argv[++i] ?? ''
    else if (arg === '--registry' || arg === '-r') out.registry = argv[++i] ?? ''
    else if (arg === '--npm') out.npm = argv[++i] ?? ''
    else if (arg === '--cwd') out.cwd = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

/**
 * npm ships as a shell script on Windows and Node refuses to spawn one
 * without a shell, so every argument is validated before it gets there.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string }} options
 */
function npmRun(command, args, { cwd }) {
  const shell = process.platform === 'win32'
  // cmd.exe needs the program path quoted, or a path with a space in it splits
  // into two commands.
  const file = shell && /\s/.test(command) ? `"${command}"` : command
  const result = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    shell,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** npm prints one JSON blob, but the older shapes bury it in other output. */
function parseJson(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[[{]/)
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

/** The bundle name DSH resolves the package by. */
function patchName(root) {
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  const match = /^[ \t]*-?[ \t]*name:[ \t]*['"]?([^'"\n]+)['"]?[ \t]*$/m.exec(patch)
  return match ? match[1].trim() : ''
}

/**
 * The files that are missing from the tarball, and the ones that must not be
 * in it.
 * @param {{ path: string }[]} files
 */
function payloadProblems(files) {
  const paths = (files ?? []).map((file) => file.path)
  const present = new Set(paths)
  const missing = REQUIRED_FILES.filter((file) => !present.has(file))
  const forbidden = paths.filter((file) => file.startsWith(FORBIDDEN_PREFIX))
  return { missing, forbidden }
}

/** The tarball npm packed, keyed by the package name. */
function stagedPayload(stdout) {
  const parsed = parseJson(stdout)
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.stageId && Array.isArray(parsed.files)) return parsed
  const entries = Object.values(parsed).filter(
    (value) => value && typeof value === 'object' && value.stageId,
  )
  return entries.length ? entries[0] : null
}

/** A stage of this exact version left behind by an earlier run. */
function findStaged({ npm, cwd, registry, name, version }) {
  const result = npmRun(npm, ['stage', 'list', name, '--json', `--registry=${registry}`], { cwd })
  if (result.status !== 0) return null
  const items = parseJson(result.stdout)
  if (!Array.isArray(items)) return null
  const match = items.find((item) => item?.version === version && item?.id)
  return match ? match.id : null
}

/** npm reports a failure as `{ error: { summary, detail } }` in JSON mode. */
function failureText(result) {
  const parsed = parseJson(result.stdout)
  const error = parsed?.error
  if (error) {
    const detail = typeof error.detail === 'string' ? error.detail.trim() : ''
    return [error.summary, detail].filter(Boolean).join('\n')
  }
  return (result.stderr || result.stdout || 'npm stage publish failed').trim()
}

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

function report({ name, version, stageId, registry }) {
  const lines = [
    `Staged ${name}@${version} — stage id ${stageId}`,
    '',
    'Approve it from a terminal signed in as the npm owner. The 2FA prompt',
    'stays in that terminal; the tarball is on npm but not installable yet.',
    '',
    `  npm stage approve ${stageId} --registry=${registry}`,
    '',
    'To look at it before it goes live:',
    '',
    `  npm stage view ${stageId} --registry=${registry}`,
    `  npm stage download ${stageId} --registry=${registry}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  writeOutput('status', 'staged')
  writeOutput('stage_id', stageId)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log('usage: node scripts/stage-release.js [--version v0.2.0] [--registry https://registry.npmjs.org/] [--npm npm] [--cwd dir]')
  process.exit(0)
}

const root = path.resolve(options.cwd)
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const name = manifest.name
const version = (options.version || manifest.version).replace(/^v/, '')

if (!NAME_RE.test(name)) {
  console.error(`refusing to stage: ${name} is not a package name npm would accept`)
  process.exit(1)
}
if (!VERSION_RE.test(version)) {
  console.error(`refusing to stage: ${version} is not a semver version`)
  process.exit(1)
}
if (!REGISTRY_RE.test(options.registry)) {
  console.error(`refusing to stage: ${options.registry} is not an https registry`)
  process.exit(1)
}
if (version !== manifest.version) {
  console.error(`refusing to stage: package.json says ${manifest.version}, the release says ${version}`)
  process.exit(1)
}
if (patchName(root) !== name) {
  console.error(`refusing to stage: cordis.patch.yml names ${patchName(root)}, the package is ${name}`)
  process.exit(1)
}

// A version that already reached the registry needs no staging.
const published = npmRun(
  options.npm,
  [
    'view',
    `${name}@${version}`,
    'version',
    '--json',
    '--prefer-online',
    `--registry=${options.registry}`,
  ],
  { cwd: root },
)
if (published.status === 0) {
  writeOutput('status', 'published')
  console.log(`${name}@${version} is already on npm, nothing to stage`)
  process.exit(0)
}

const publishArgs = [
  'stage',
  'publish',
  '--provenance',
  '--access',
  'public',
  '--json',
  `--registry=${options.registry}`,
]
// A prerelease must not take the `latest` tag away from the stable release.
if (version.includes('-')) publishArgs.push('--tag', 'next')

const staged = npmRun(options.npm, publishArgs, { cwd: root })
if (staged.status !== 0) {
  // An earlier run of the same tag may have staged it already.
  const existing = findStaged({
    npm: options.npm,
    cwd: root,
    registry: options.registry,
    name,
    version,
  })
  if (existing) {
    report({ name, version, stageId: existing, registry: options.registry })
    process.exit(0)
  }
  process.stderr.write(`${failureText(staged)}\n`)
  process.exit(1)
}

const payload = stagedPayload(staged.stdout)
if (!payload) {
  console.error('npm stage publish did not report a stage id')
  process.exit(1)
}
if (payload.version !== version) {
  console.error(`refusing to stage: npm packed ${payload.version}, the release says ${version}`)
  process.exit(1)
}

const { missing, forbidden } = payloadProblems(payload.files)
if (missing.length || forbidden.length) {
  if (missing.length) console.error(`the tarball is missing: ${missing.join(', ')}`)
  if (forbidden.length) console.error(`the tarball must not contain: ${forbidden.join(', ')}`)
  process.exit(1)
}

report({ name, version, stageId: payload.stageId, registry: options.registry })
