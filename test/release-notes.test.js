import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const script = path.join(import.meta.dirname, '..', 'scripts', 'release-notes.js')

/**
 * A scratch repository the notes script can read: one conventional commit per
 * shape the script has to tell apart.
 */
function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-notes-'))
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'dev@example.com'])
  git(['config', 'user.name', 'Dev'])
  git(['config', 'core.autocrlf', 'false'])
  return {
    dir,
    git,
    /**
     * @param {string} subject
     * @param {string} [body]
     */
    commit(subject, body) {
      writeFileSync(path.join(dir, `${subject.replace(/\W+/g, '-')}.txt`), `${subject}\n`)
      git(['add', '-A'])
      git(['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])])
    },
  }
}

function notes(dir, args) {
  return execFileSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' })
}

/** The bullet lines of one section of the notes. */
function section(text, heading) {
  const start = text.indexOf(`### ${heading}`)
  if (start === -1) return []
  const rest = text.slice(start).split('\n').slice(1)
  const end = rest.findIndex((line) => line.startsWith('### ') || line.startsWith('['))
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.startsWith('- '))
}

test('release notes group the commits by type and drop the release housekeeping', () => {
  const repo = scratchRepo()
  const { dir, git, commit } = repo
  try {
    commit('feat(core): add the changelist panel')
    commit('fix(ui): repair the empty state')
    commit('docs: explain the release flow')
    commit('chore(release): 1.2.3')
    commit('tidy the leftover files')
    git(['tag', 'v1.2.3'])

    const text = notes(dir, ['--tag', 'v1.2.3', '--no-changelog'])

    assert.equal(section(text, 'Features').length, 1)
    assert.match(section(text, 'Features')[0], /add the changelist panel/)
    assert.match(section(text, 'Bug fixes')[0], /repair the empty state/)
    assert.match(section(text, 'Documentation')[0], /explain the release flow/)
    assert.match(section(text, 'Other changes')[0], /tidy the leftover files/)
    // The release commit itself is not part of the release notes.
    assert.equal(section(text, 'Chores').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a breaking change is the footer or the bang, not the phrase in prose', () => {
  const repo = scratchRepo()
  const { dir, git, commit } = repo
  try {
    commit('feat(api)!: drop the old entry point')
    commit('docs: describe how BREAKING CHANGE entries are pulled out', 'The notes script recognises the footer of a breaking change.')
    commit('fix(core): keep the parser strict', 'BREAKING CHANGE: the old option no longer exists.')
    git(['tag', 'v2.0.0'])

    const text = notes(dir, ['--tag', 'v2.0.0', '--no-changelog'])

    const breaking = section(text, 'Breaking changes')
    assert.equal(breaking.length, 2)
    assert.ok(breaking.some((line) => /drop the old entry point/.test(line)))
    assert.ok(breaking.some((line) => /keep the parser strict/.test(line)))
    // The documentation commit only mentions the phrase.
    assert.equal(section(text, 'Documentation').length, 1)
    assert.equal(section(text, 'Bug fixes').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the notes compare against the previous tag', () => {
  const repo = scratchRepo()
  const { dir, git, commit } = repo
  try {
    commit('feat(core): first feature')
    git(['tag', 'v1.0.0'])
    commit('feat(core): second feature')
    git(['tag', 'v1.1.0'])

    const text = notes(dir, ['--tag', 'v1.1.0', '--no-changelog', '--repo', 'https://github.com/owner/name'])

    const features = section(text, 'Features')
    assert.equal(features.length, 1)
    assert.match(features[0], /second feature/)
    assert.match(text, /Compare v1\.0\.0\.\.\.v1\.1\.0/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the changelog section leads the notes', () => {
  const repo = scratchRepo()
  const { dir, git, commit } = repo
  try {
    commit('feat(core): a feature')
    git(['tag', 'v3.0.0'])
    writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 3.0.0\n\nHand-written summary.\n\n## 2.0.0\n\nOlder.\n')

    const text = notes(dir, ['--tag', 'v3.0.0'])

    assert.match(text, /^Hand-written summary\./)
    assert.doesNotMatch(text, /Older\./)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
