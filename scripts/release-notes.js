#!/usr/bin/env node
/**
 * dsh-git-workbench — GitHub release notes from conventional commits.
 *
 * Writes the notes for one tag, grouped by commit type, to stdout or a file.
 * Runs without dependencies; every git call is `execFileSync` with argv, never
 * a shell, so it behaves the same on Windows and Linux.
 *
 *   node scripts/release-notes.js --tag v0.2.0 --output notes.md
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** Section order decides the order of the headings in the notes. */
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Bug fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['style', 'Style'],
  ['test', 'Tests'],
  ['build', 'Build'],
  ['ci', 'CI'],
  ['revert', 'Reverts'],
  ['chore', 'Chores'],
  ['other', 'Other changes'],
]

const RECORD = '\x1e'
const FIELD = '\x1f'

function git(args) {
  // stderr stays hidden: a missing parent tag is a normal answer here, not an error.
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function parseArgs(argv) {
  const out = { tag: '', output: '', repo: '', changelog: 'CHANGELOG.md' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--tag' || arg === '-t') out.tag = argv[++i] ?? ''
    else if (arg === '--output' || arg === '-o') out.output = argv[++i] ?? ''
    else if (arg === '--repo' || arg === '-r') out.repo = argv[++i] ?? ''
    else if (arg === '--changelog') out.changelog = argv[++i] ?? ''
    else if (arg === '--no-changelog') out.changelog = ''
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

/** The tag sitting on HEAD, or an empty string when HEAD is not tagged. */
function currentTag() {
  try {
    return git(['describe', '--tags', '--exact-match', 'HEAD']).trim()
  } catch {
    return ''
  }
}

/** The semver tag this release is compared against, or null for the first one. */
function previousTag(tag) {
  const ref = tag ? `${tag}^` : 'HEAD^'
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', ref]).trim() || null
  } catch {
    return null
  }
}

/**
 * A release housekeeping commit (`chore(release): 0.2.0`) says nothing about
 * the release itself, so it never reaches the notes.
 * @param {{ subject: string }} entry
 */
function isReleaseHousekeeping(entry) {
  const match = /^(\w+)(\(([^)]*)\))?(!)?:\s*(.+)$/.exec(entry.subject)
  if (!match || match[1].toLowerCase() !== 'chore') return false
  const scope = (match[3] ?? '').toLowerCase()
  return scope === 'release' || /^release\b/i.test(match[5])
}

function commits(range) {
  const raw = git(['log', '--no-merges', `--format=${RECORD}%h${FIELD}%s${FIELD}%b`, range])
  return raw
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\n/, ''))
    .filter(Boolean)
    .map((chunk) => {
      const [hash, subject, body = ''] = chunk.split(FIELD)
      return { hash, subject: subject.trim(), body }
    })
    .filter((entry) => !isReleaseHousekeeping(entry))
}

/** `feat(api)!: subject` → type `feat`, scope `api`, breaking flag. */
function classify(entry) {
  const match = /^(\w+)(\(([^)]*)\))?(!)?:\s*(.+)$/.exec(entry.subject)
  // The footer is the marker; the phrase in prose is not.
  const breaking = Boolean(match?.[4]) || /^BREAKING[ -]CHANGE:/m.test(entry.body)
  if (!match) return { type: 'other', scope: '', text: entry.subject, breaking }
  const type = match[1].toLowerCase()
  return {
    type: SECTIONS.some(([key]) => key === type) ? type : 'other',
    scope: match[3] ?? '',
    text: match[5],
    breaking,
  }
}

function line(entry, commit) {
  const where = commit.scope ? `**${commit.scope}:** ` : ''
  return `- ${where}${commit.text} (${entry.hash})`
}

/**
 * The hand-written section of CHANGELOG.md for this version, when there is one.
 * The commit list is the audit trail; the prose is what a reader wants first.
 * @param {string} tag
 * @param {string} file
 */
function changelogSection(tag, file) {
  if (!tag || !file) return ''
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  const version = tag.replace(/^v/, '')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}`).test(line))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s+/.test(line))
  return rest.slice(0, end === -1 ? rest.length : end).join('\n').trim()
}

function build({ range, repo, from, to, prose }) {
  const grouped = new Map()
  const breaking = []
  for (const entry of commits(range)) {
    const commit = classify(entry)
    if (commit.breaking) breaking.push(line(entry, commit))
    if (!grouped.has(commit.type)) grouped.set(commit.type, [])
    grouped.get(commit.type).push(line(entry, commit))
  }

  // The release title already carries the tag, so the body starts with prose.
  const blocks = []
  if (prose) blocks.push(prose)
  if (breaking.length) blocks.push(['### Breaking changes', ...breaking].join('\n'))
  for (const [type, name] of SECTIONS) {
    const rows = grouped.get(type)
    if (rows?.length) blocks.push([`### ${name}`, ...rows].join('\n'))
  }
  if (!blocks.length) blocks.push('No conventional commits in this range.')

  if (repo) {
    // GitHub has no compare view for a first release — there is nothing to diff.
    blocks.push(from === '0000000'
      ? `[Browse ${to}](${repo}/tree/${to})`
      : `[Compare ${from}...${to}](${repo}/compare/${from}...${to})`)
  }
  return blocks.join('\n\n')
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log('usage: node scripts/release-notes.js [--tag v0.2.0] [--output notes.md] [--repo https://github.com/owner/name] [--changelog CHANGELOG.md | --no-changelog]')
  process.exit(0)
}

const tag = options.tag || currentTag()
const from = previousTag(tag)
const to = tag || 'HEAD'
const range = from ? `${from}..${to}` : to
// The URL is optional: without a remote the notes simply omit links.
const repo = options.repo
  ? options.repo.replace(/\/+$/, '')
  : (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : '')
const notes = build({
  range,
  repo,
  from: from ?? '0000000',
  to,
  prose: changelogSection(tag, options.changelog),
})
const target = options.output ? path.resolve(options.output) : null
if (target) writeFileSync(target, `${notes}\n`, 'utf8')
else process.stdout.write(notes)
