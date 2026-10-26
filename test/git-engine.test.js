import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GitService } from '../src/git/service.js'
import { parseDiff } from '../src/git/diff.js'
import { analyzeConflicts, applyDecision } from '../src/git/conflict.js'

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function gitSync(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * @param {string} name
 */
async function makeRepo(name) {
  const dir = await mkdtemp(path.join(tmpdir(), `dsh-git-${name}-`))
  gitSync(dir, ['init', '-q', '-b', 'main'])
  gitSync(dir, ['config', 'user.email', 'dev@example.com'])
  gitSync(dir, ['config', 'user.name', 'Dev'])
  gitSync(dir, ['config', 'commit.gpgsign', 'false'])
  // The tests write LF content; a developer's global autocrlf must not turn
  // every worktree comparison into a CRLF one.
  gitSync(dir, ['config', 'core.autocrlf', 'false'])
  return dir
}

/**
 * @param {string} dir
 * @param {string} message
 */
function commitAll(dir, message) {
  gitSync(dir, ['add', '-A'])
  gitSync(dir, ['commit', '-q', '-m', message])
}

/**
 * @param {string} dir
 * @param {string} file
 */
async function read(dir, file) {
  return readFile(path.join(dir, file), 'utf8')
}

/** 12 lines so two edits are more than one context block apart. */
const BASE = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'

test('status reports staged, unstaged and untracked entries separately', async () => {
  const dir = await makeRepo('status')
  try {
    await writeFile(path.join(dir, 'a.txt'), 'a\n')
    await writeFile(path.join(dir, 'b.txt'), 'b\n')
    commitAll(dir, 'init')

    await writeFile(path.join(dir, 'a.txt'), 'a changed\n')
    gitSync(dir, ['add', 'a.txt'])
    await writeFile(path.join(dir, 'a.txt'), 'a changed again\n')
    await writeFile(path.join(dir, 'b.txt'), 'b changed\n')
    await writeFile(path.join(dir, 'new.txt'), 'new\n')

    const service = new GitService({ defaultDir: dir })
    const status = await service.status()

    assert.equal(status.branch, 'main')
    assert.equal(status.repo.unborn, false)

    const a = status.files.find((file) => file.path === 'a.txt')
    assert.ok(a)
    assert.equal(a.staged, true, 'index change present')
    assert.equal(a.unstaged, true, 'worktree change present')
    assert.equal(a.index, 'M')
    assert.equal(a.worktree, 'M')

    const b = status.files.find((file) => file.path === 'b.txt')
    assert.equal(b.staged, false)
    assert.equal(b.unstaged, true)

    const untracked = status.files.find((file) => file.path === 'new.txt')
    assert.equal(untracked.kind, 'untracked')
    assert.equal(status.counts.untracked, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('diff parser keeps both line numbers and file status', async () => {
  const dir = await makeRepo('diff')
  try {
    await writeFile(path.join(dir, 'a.txt'), BASE)
    commitAll(dir, 'init')
    await writeFile(path.join(dir, 'a.txt'), BASE.replace('line 3\n', 'line 3 changed\n'))

    const service = new GitService({ defaultDir: dir })
    const { files } = await service.diff({})

    assert.equal(files.length, 1)
    const file = files[0]
    assert.equal(file.status, 'modified')
    assert.equal(file.additions, 1)
    assert.equal(file.deletions, 1)

    const hunk = file.hunks[0]
    assert.equal(hunk.oldStart, 1)
    const changed = hunk.lines.find((line) => line.type === 'del')
    assert.equal(changed.oldLine, 3)
    assert.equal(changed.newLine, null)
    const added = hunk.lines.find((line) => line.type === 'add')
    assert.equal(added.newLine, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('staging one hunk leaves the other hunk in the working tree', async () => {
  const dir = await makeRepo('hunk')
  try {
    await writeFile(path.join(dir, 'a.txt'), BASE)
    commitAll(dir, 'init')

    const edited = BASE.replace('line 2\n', 'line 2 changed\n').replace('line 18\n', 'line 18 changed\n')
    await writeFile(path.join(dir, 'a.txt'), edited)

    const service = new GitService({ defaultDir: dir })
    const { files } = await service.diff({})
    assert.equal(files[0].hunks.length, 2, 'two independent hunks')

    await service.stage({ file: 'a.txt', direction: 'stage', mode: 'hunk', hunk: 0 })

    const staged = gitSync(dir, ['diff', '--cached', '--unified=0'])
      .split('\n')
      .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
    assert.deepEqual(staged, ['-line 2', '+line 2 changed'], 'only hunk 0 reached the index')

    const worktree = await read(dir, 'a.txt')
    assert.ok(worktree.includes('line 18 changed'), 'hunk 1 is still uncommitted in the worktree')

    const remaining = await service.diff({})
    assert.equal(remaining.files[0].hunks.length, 1, 'one hunk left unstaged')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('staging a single line inside a hunk stages only that line', async () => {
  const dir = await makeRepo('line')
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    commitAll(dir, 'init')
    await writeFile(path.join(dir, 'a.txt'), 'one added\ntwo\nthree\nfour added\n')

    const service = new GitService({ defaultDir: dir })
    const { files } = await service.diff({})
    const hunk = files[0].hunks[0]
    const addedIndexes = hunk.lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.type === 'add')
      .map((entry) => entry.index)
    assert.equal(addedIndexes.length, 2)

    await service.stage({ file: 'a.txt', direction: 'stage', mode: 'lines', hunk: 0, lines: [addedIndexes[0]] })

    const staged = gitSync(dir, ['diff', '--cached', '--unified=0'])
    assert.match(staged, /\+one added/)
    assert.doesNotMatch(staged, /\+four added/, 'the second line stays unstaged')

    const worktree = await read(dir, 'a.txt')
    assert.equal(worktree, 'one added\ntwo\nthree\nfour added\n', 'worktree untouched by partial staging')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unstaging one hunk returns it to the working tree', async () => {
  const dir = await makeRepo('unstage')
  try {
    await writeFile(path.join(dir, 'a.txt'), BASE)
    commitAll(dir, 'init')
    const edited = BASE.replace('line 2\n', 'line 2 changed\n').replace('line 18\n', 'line 18 changed\n')
    await writeFile(path.join(dir, 'a.txt'), edited)
    gitSync(dir, ['add', 'a.txt'])

    const service = new GitService({ defaultDir: dir })
    const staged = await service.diff({ staged: true })
    assert.equal(staged.files[0].hunks.length, 2)

    await service.stage({ file: 'a.txt', direction: 'unstage', mode: 'hunk', hunk: 1 })

    const remaining = gitSync(dir, ['diff', '--cached', '--unified=0'])
    assert.match(remaining, /line 2 changed/)
    assert.doesNotMatch(remaining, /line 18 changed/, 'hunk 1 left the index')

    const worktree = await read(dir, 'a.txt')
    assert.ok(worktree.includes('line 18 changed'), 'worktree keeps the change')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a new file is staged whole when partial staging is requested', async () => {
  const dir = await makeRepo('newfile')
  try {
    await writeFile(path.join(dir, 'a.txt'), 'a\n')
    commitAll(dir, 'init')
    await writeFile(path.join(dir, 'new.txt'), 'n1\nn2\n')

    const service = new GitService({ defaultDir: dir })
    await service.stage({ file: 'new.txt', direction: 'stage', mode: 'lines', hunk: 0, lines: [0] })

    const staged = gitSync(dir, ['diff', '--cached', '--name-only']).trim()
    assert.equal(staged, 'new.txt')
    assert.equal(await read(dir, 'new.txt'), 'n1\nn2\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('commit, log, blame and branches work against a real repository', async () => {
  const dir = await makeRepo('history')
  try {
    await writeFile(path.join(dir, 'a.txt'), 'alpha\nbeta\n')
    commitAll(dir, 'feat: first')
    await writeFile(path.join(dir, 'a.txt'), 'alpha\nbeta changed\n')
    commitAll(dir, 'feat: second')
    gitSync(dir, ['checkout', '-q', '-b', 'feature/x'])

    const service = new GitService({ defaultDir: dir })
    const log = await service.log({ limit: 10 })
    assert.equal(log.length, 2)
    assert.equal(log[0].subject, 'feat: second')
    assert.equal(log[0].parents.length, 1)

    const branches = await service.branches()
    const names = branches.local.map((branch) => branch.name).sort()
    assert.deepEqual(names, ['feature/x', 'main'])
    assert.equal(branches.local.find((branch) => branch.name === 'feature/x').current, true)

    const blame = await service.blame({ file: 'a.txt' })
    assert.equal(blame.lines.length, 2)
    assert.equal(blame.lines[1].text, 'beta changed')
    assert.equal(blame.lines[1].author, 'Dev')

    const show = await service.showCommit({ sha: 'HEAD' })
    assert.match(show.message, /feat: second/)
    assert.equal(show.files.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file history is scoped to the file and skips stash entries', async () => {
  const dir = await makeRepo('filelog')
  try {
    await writeFile(path.join(dir, 'a.txt'), 'a\n')
    await writeFile(path.join(dir, 'b.txt'), 'b\n')
    commitAll(dir, 'touch both')
    await writeFile(path.join(dir, 'a.txt'), 'a changed\n')
    commitAll(dir, 'edit a')
    await writeFile(path.join(dir, 'b.txt'), 'b changed\n')
    commitAll(dir, 'edit b')
    gitSync(dir, ['checkout', '-q', '-b', 'side'])
    await writeFile(path.join(dir, 'a.txt'), 'a on side\n')
    commitAll(dir, 'edit a on side')
    await writeFile(path.join(dir, 'b.txt'), 'b stashed\n')
    gitSync(dir, ['stash', 'push', '-q', '-m', 'wip'])

    const service = new GitService({ defaultDir: dir })
    const history = await service.log({ path: 'a.txt', limit: 20 })
    assert.deepEqual(
      history.map((entry) => entry.subject).sort(),
      ['edit a', 'edit a on side', 'touch both'],
      'only the commits that touched a.txt, on every branch',
    )

    const all = await service.log({ limit: 20 })
    assert.ok(!all.some((entry) => /stash/i.test(entry.subject)), 'a stash entry is not a commit')
    await assert.rejects(() => service.log({ path: '--output=/tmp/pwn' }), /invalid path/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('discarding one line keeps its neighbour in the same hunk', async () => {
  const dir = await makeRepo('discard')
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    commitAll(dir, 'init')
    await writeFile(path.join(dir, 'a.txt'), 'one added\ntwo\nthree\nfour added\n')

    const service = new GitService({ defaultDir: dir })
    const hunk = (await service.diff({ file: 'a.txt', staged: false })).files[0].hunks[0]
    const added = hunk.lines.findIndex((line) => line.type === 'add' && line.text === 'one added')

    // Discarding an addition deletes that line — it does not resurrect the
    // line it replaced, which is a separate deletion.
    await service.revertLines({ file: 'a.txt', mode: 'lines', selection: [{ hunk: 0, lines: [added] }] })
    assert.equal(await read(dir, 'a.txt'), 'two\nthree\nfour added\n', 'only the selected addition went back')

    // A deletion is restored at its own position, not by reverting the block.
    const next = (await service.diff({ file: 'a.txt', staged: false })).files[0].hunks[0]
    const deleted = next.lines.findIndex((line) => line.type === 'del' && line.text === 'four')
    await service.revertLines({ file: 'a.txt', mode: 'lines', selection: [{ hunk: 0, lines: [deleted] }] })
    assert.equal(await read(dir, 'a.txt'), 'two\nthree\nfour\nfour added\n', 'four is back, the other change is intact')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('discarding a line leaves CRLF endings alone', async () => {
  const dir = await makeRepo('discard-crlf')
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\r\ntwo\r\n')
    commitAll(dir, 'init')
    await writeFile(path.join(dir, 'a.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\n')

    const service = new GitService({ defaultDir: dir })
    const hunk = (await service.diff({ file: 'a.txt', staged: false })).files[0].hunks[0]
    const added = hunk.lines.findIndex((line) => line.type === 'add' && line.text.replace(/\r$/, '') === 'three')

    await service.revertLines({ file: 'a.txt', mode: 'lines', selection: [{ hunk: 0, lines: [added] }] })
    assert.equal(await read(dir, 'a.txt'), 'one\r\ntwo\r\nfour\r\n', 'the kept line still ends with CRLF')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('line indexes address the whole-file diff the panel renders', async () => {
  const dir = await makeRepo('fullctx')
  try {
    await writeFile(path.join(dir, 'a.txt'), BASE)
    commitAll(dir, 'init')
    await writeFile(path.join(dir, 'a.txt'), BASE.replace('line 3\n', 'line 3 changed\n').replace('line 16\n', 'line 16 changed\n'))

    const service = new GitService({ defaultDir: dir })
    const full = await service.diff({ file: 'a.txt', full: true })
    assert.equal(full.files[0].hunks.length, 1, 'whole-file context is one hunk')
    const adds = full.files[0].hunks[0].lines.map((line, index) => ({ line, index })).filter((entry) => entry.line.type === 'add')
    const second = adds[adds.length - 1].index
    assert.ok(second > 9, 'the anchor sits past the first three-line hunk')

    // The same index means two different lines depending on the context width,
    // so the mutation has to be told which diff the rows came from.
    await assert.rejects(
      () => service.stage({ file: 'a.txt', direction: 'stage', mode: 'lines', selection: [{ hunk: 0, lines: [second] }] }),
      /not found in hunk 0/,
    )
    await service.stage({ file: 'a.txt', direction: 'stage', mode: 'lines', selection: [{ hunk: 0, lines: [second] }], full: true })

    const staged = gitSync(dir, ['diff', '--cached'])
    assert.match(staged, /\+line 16 changed/)
    assert.doesNotMatch(staged, /\+line 3 changed/, 'the other change stays unstaged')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('discarding a whole hunk still goes through git apply', async () => {
  const dir = await makeRepo('discard-hunk')
  try {
    await writeFile(path.join(dir, 'a.txt'), BASE)
    commitAll(dir, 'init')
    await writeFile(path.join(dir, 'a.txt'), BASE.replace('line 2\n', 'line 2 changed\n').replace('line 18\n', 'line 18 changed\n'))

    const service = new GitService({ defaultDir: dir })
    await service.revertLines({ file: 'a.txt', mode: 'hunk', hunk: 1 })
    assert.equal(await read(dir, 'a.txt'), BASE.replace('line 2\n', 'line 2 changed\n'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid paths and revisions are refused', async () => {
  const dir = await makeRepo('guard')
  try {
    await writeFile(path.join(dir, 'a.txt'), 'a\n')
    commitAll(dir, 'init')
    const service = new GitService({ defaultDir: dir })
    await assert.rejects(() => service.diff({ file: '../../etc/passwd' }), /escapes the repository/)
    await assert.rejects(() => service.showCommit({ sha: '--upload-pack=touch /tmp/x' }), /invalid revision/)
    await assert.rejects(() => service.commit({ message: '   ' }), /message is empty/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseDiff handles additions, deletions and renames', async () => {
  const dir = await makeRepo('meta')
  try {
    await writeFile(path.join(dir, 'keep.txt'), 'keep\n')
    await writeFile(path.join(dir, 'gone.txt'), 'gone\n')
    commitAll(dir, 'init')
    await rm(path.join(dir, 'gone.txt'))
    await writeFile(path.join(dir, 'added.txt'), 'brand new\n')
    await mkdir(path.join(dir, 'sub'))
    await writeFile(path.join(dir, 'sub', 'new.txt'), 'nested\n')

    const service = new GitService({ defaultDir: dir })
    const { files } = await service.diff({})
    const byPath = new Map(files.map((file) => [file.path, file]))
    assert.equal(byPath.get('gone.txt').status, 'deleted')
    assert.equal(files.length, 1, 'untracked files are not part of `git diff`')

    const untracked = await service.fileDiff(undefined, 'sub/new.txt')
    assert.equal(untracked.unstaged.status, 'added')
    assert.equal(untracked.unstaged.hunks.length, 1)
    assert.equal(untracked.entry.kind, 'untracked')

    const parsed = parseDiff('diff --git a/old.txt b/renamed.txt\nsimilarity index 100%\nrename from old.txt\nrename to renamed.txt\n')
    assert.equal(parsed[0].status, 'renamed')
    assert.equal(parsed[0].oldPath, 'old.txt')
    assert.equal(parsed[0].path, 'renamed.txt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the repository revision changes when git metadata changes', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = new GitService({ defaultDir: dir })
  const before = await service.revision({ dir })
  gitSync(dir, ['commit', '--allow-empty', '-m', 'second'])
  // revision() memoises for 200ms under the *resolved* root (git reports
  // forward slashes, which may differ from the temp dir on Windows).
  service.revisions.delete(await service.resolveDir(dir))
  const after = await service.revision({ dir })
  assert.notEqual(after.rev, before.rev)
  assert.notEqual(after.head, before.head)
})

test('working-tree edits made outside the plugin reach the change watcher', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = new GitService({ defaultDir: dir })
  const root = await service.resolveDir(dir)
  let fired = false
  const dispose = service.onRepoChange(root, () => {
    fired = true
  })
  t.after(dispose)
  await writeFile(path.join(dir, 'a.txt'), 'one\nexternal edit\nthree\n')
  // The watcher debounces; give the filesystem a moment to report the change.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.ok(fired, 'an edit outside the plugin notifies subscribers')
})

test('the conflict reader separates both sides and keeps a diff3 ancestor', () => {
  const text = [
    'one',
    '<<<<<<< HEAD',
    'mine',
    '||||||| merged common ancestors',
    'original',
    '=======',
    ' theirs',
    '>>>>>>> feature',
    'two',
    '',
  ].join('\n')
  const { segments, count, complete } = analyzeConflicts(text)
  assert.equal(count, 1)
  assert.equal(complete, true)
  assert.deepEqual(segments.map((segment) => segment.kind), ['plain', 'conflict', 'plain'])
  const block = segments[1]
  assert.equal(block.index, 0)
  assert.equal(block.line, 2)
  assert.deepEqual(block.ours, ['mine'])
  assert.deepEqual(block.base, ['original'])
  assert.deepEqual(block.theirs, [' theirs'])
  assert.deepEqual(segments[2].lines, ['two', ''])

  // A marker pair with nothing between them is not a conflict git wrote.
  const empty = analyzeConflicts('a\n<<<<<<< HEAD\n=======\n>>>>>>> x\nb\n')
  assert.equal(empty.count, 0)
  assert.deepEqual(empty.segments.flatMap((segment) => segment.lines), ['a', '<<<<<<< HEAD', '=======', '>>>>>>> x', 'b', ''])

  // An unclosed block is reported as broken so the writer refuses the file.
  const broken = analyzeConflicts('a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n')
  assert.equal(broken.count, 0)
  assert.equal(broken.complete, false)
})

test('a decision rewrites one region and leaves the others byte for byte', () => {
  const text = [
    'head',
    '<<<<<<< HEAD',
    'A-mine',
    '=======',
    'A-theirs',
    '>>>>>>> feature',
    'middle',
    '<<<<<<< HEAD',
    'B-mine',
    '=======',
    'B-theirs',
    '>>>>>>> feature',
    'tail',
    '',
  ].join('\n')
  const { segments } = analyzeConflicts(text)

  // CRLF content must survive: rewriting the whole file to LF would turn every
  // line into a change.
  const crlf = analyzeConflicts(text.replace(/\n/g, '\r\n'))
  assert.equal(
    applyDecision(crlf.segments, 0, 'ours'),
    ['head', 'A-mine', 'middle', '<<<<<<< HEAD', 'B-mine', '=======', 'B-theirs', '>>>>>>> feature', 'tail', ''].join('\r\n'),
  )

  assert.equal(applyDecision(segments, 0, 'ours'), ['head', 'A-mine', 'middle', '<<<<<<< HEAD', 'B-mine', '=======', 'B-theirs', '>>>>>>> feature', 'tail', ''].join('\n'))
  assert.equal(applyDecision(segments, 0, 'custom', ['A-merged', 'still mine']), ['head', 'A-merged', 'still mine', 'middle', '<<<<<<< HEAD', 'B-mine', '=======', 'B-theirs', '>>>>>>> feature', 'tail', ''].join('\n'))
  assert.equal(applyDecision(segments, 1, 'theirs'), ['head', '<<<<<<< HEAD', 'A-mine', '=======', 'A-theirs', '>>>>>>> feature', 'middle', 'B-theirs', 'tail', ''].join('\n'))
  assert.equal(applyDecision(segments, 1, 'both'), ['head', '<<<<<<< HEAD', 'A-mine', '=======', 'A-theirs', '>>>>>>> feature', 'middle', 'B-mine', 'B-theirs', 'tail', ''].join('\n'))
  // null answers every region at once
  assert.equal(applyDecision(segments, null, 'ours'), ['head', 'A-mine', 'middle', 'B-mine', 'tail', ''].join('\n'))
  assert.equal(analyzeConflicts(applyDecision(segments, null, 'both')).count, 0)
})
