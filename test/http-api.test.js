import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GitService } from '../src/git/service.js'
import { gitStats } from '../src/git/exec.js'
import { createHandler } from '../src/http/routes.js'

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function gitSync(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * A git command whose failure is the answer (no upstream, no such ref).
 * @param {string} cwd
 * @param {string[]} args
 */
function gitMaybe(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

/**
 * The fixture root is created with a real path, because macOS hands out
 * `/tmp/…` while git reports `/private/tmp/…`.
 * @param {string} prefix
 */
async function makeTempDir(prefix) {
  return realpathSync(await mkdtemp(path.join(tmpdir(), prefix)))
}

/**
 * Windows spells one folder two ways: the 8.3 short name the temp directory
 * comes with, and the long name git reports. Node cannot expand the short
 * name — it namespaces the path before the OS ever sees it — so the file
 * identity is what proves that two paths are one folder.
 * @param {string} a
 * @param {string} b
 */
function sameFolder(a, b) {
  const left = statSync(a)
  const right = statSync(b)
  if (!left.ino || !right.ino) return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  return left.dev === right.dev && left.ino === right.ino
}

async function makeRepo() {
  const dir = await makeTempDir('dsh-git-http-')
  gitSync(dir, ['init', '-q', '-b', 'main'])
  gitSync(dir, ['config', 'user.email', 'dev@example.com'])
  gitSync(dir, ['config', 'user.name', 'Dev'])
  // The tests write LF content; a developer's global autocrlf must not turn
  // every worktree comparison into a CRLF one.
  gitSync(dir, ['config', 'core.autocrlf', 'false'])
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  gitSync(dir, ['add', '-A'])
  gitSync(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

/**
 * @param {string} dir
 */
async function startServer(dir, options = {}) {
  const handler = createHandler(new GitService({ defaultDir: dir }), options)
  const server = http.createServer((req, res) => {
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {any} */ (server.address())
  return { server, base: `http://127.0.0.1:${port}/dsh-git` }
}

test('http api serves status, diff, stage, commit and refuses cross-origin writes', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    const status = await (await fetch(`${base}/api/status`)).json()
    assert.equal(status.branch, 'main')
    assert.equal(status.files.length, 0)

    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo changed\nthree\n')
    const file = await (await fetch(`${base}/api/file?file=a.txt`)).json()
    assert.equal(file.unstaged.hunks.length, 1)
    assert.equal(file.entry.kind, 'modified')

    const stageResponse = await fetch(`${base}/api/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, file: 'a.txt', direction: 'stage', mode: 'hunk', hunk: 0 }),
    })
    assert.equal(stageResponse.status, 200)

    const after = await (await fetch(`${base}/api/status`)).json()
    assert.equal(after.files[0].staged, true)

    const commitResponse = await fetch(`${base}/api/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, message: 'feat: change two' }),
    })
    const commit = await commitResponse.json()
    assert.equal(commitResponse.status, 200)
    assert.equal(String(commit.hash).length, 40)

    const log = await (await fetch(`${base}/api/log?limit=5`)).json()
    assert.equal(log[0].subject, 'feat: change two')

    const crossOrigin = await fetch(`${base}/api/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ dir, file: 'a.txt', direction: 'stage', mode: 'file' }),
    })
    assert.equal(crossOrigin.status, 403)

    const traversal = await fetch(`${base}/../package.json`)
    assert.ok(traversal.status === 404 || traversal.status === 403, 'asset root is not escapable')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('http api reports a readable error for a non-repository path', async () => {
  const outside = await makeTempDir('dsh-git-norepo-')
  const { server, base } = await startServer(outside)
  try {
    const response = await fetch(`${base}/api/status`)
    const payload = await response.json()
    assert.equal(response.status, 500)
    assert.match(payload.error, /not a git repository/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(outside, { recursive: true, force: true })
  }
})

test('overview returns every changed file with both sides in one response', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo changed\nthree\n')
    await writeFile(path.join(dir, 'b.txt'), 'staged\n')
    gitSync(dir, ['add', 'b.txt'])
    await writeFile(path.join(dir, 'c.txt'), 'untracked\n')

    const overview = await (await fetch(`${base}/api/overview`)).json()
    assert.equal(overview.total, 3)
    const byPath = new Map(overview.files.map((file) => [file.path, file]))

    assert.ok(byPath.get('a.txt').unstaged, 'worktree edit has an unstaged side')
    assert.equal(byPath.get('a.txt').staged, null)
    assert.ok(byPath.get('b.txt').staged, 'staged file has an index side')
    assert.equal(byPath.get('c.txt').untracked, true)
    assert.equal(byPath.get('c.txt').unstaged.status, 'added', 'untracked file gets a synthesized diff')

    const total = overview.files.reduce((sum, file) => sum + (file.unstaged?.additions ?? 0) + (file.staged?.additions ?? 0), 0)
    assert.ok(total > 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('workspaces endpoint answers with a list even when nothing is registered', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    const response = await fetch(`${base}/api/workspaces`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.ok(Array.isArray(payload.workspaces))
    for (const workspace of payload.workspaces) {
      assert.equal(typeof workspace.path, 'string')
      assert.equal(typeof workspace.isRepo, 'boolean')
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('commit-file answers with the change that commit made, and never the working tree', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    // Commit a change, then leave the working tree dirty in a different way.
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    gitSync(dir, ['commit', '-qam', 'change two'])
    const sha = gitSync(dir, ['rev-parse', 'HEAD']).trim()
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nworking tree edit\n')

    const payload = await (await fetch(`${base}/api/commit-file?sha=${sha}&file=a.txt`)).json()
    assert.equal(payload.entry.kind, 'modified')
    const lines = payload.unstaged.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.type}:${line.text}`))
    assert.ok(lines.includes('del:two'), 'the committed removal is shown')
    assert.ok(lines.includes('add:TWO'), 'the committed addition is shown')
    assert.ok(!lines.some((line) => line.includes('working tree edit')), 'uncommitted work is not part of this commit')
    assert.equal(payload.staged, null)

    const response = await fetch(`${base}/api/commit-file?sha=${sha}&file=..%2F..%2Fetc%2Fpasswd`)
    assert.notEqual(response.status, 200)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('showCommit lists a merge commit\'s changes against its first parent', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    // feature branch with one change, then merge it (--no-ff keeps a merge commit)
    gitSync(dir, ['checkout', '-qb', 'feature'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nfeature\nthree\n')
    gitSync(dir, ['commit', '-qam', 'feature change'])
    gitSync(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'other.txt'), 'x\n')
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-qm', 'main change'])
    gitSync(dir, ['merge', '-q', '--no-ff', '--no-edit', 'feature'])
    const head = gitSync(dir, ['rev-parse', 'HEAD']).trim()
    const parents = gitSync(dir, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1)

    const detail = await (await fetch(`${base}/api/commit?sha=${head}`)).json()
    assert.equal(parents.length, 2, 'the fixture really is a merge')
    const paths = detail.files.map((file) => file.path)
    assert.ok(paths.includes('a.txt'), 'the merge brought feature work in')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('pull and push fail fast with the git output, never hang on credentials', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    // no remote configured: git fails immediately, which is the contract here
    const pull = await (await fetch(`${base}/api/pull`, { method: 'POST' })).json()
    assert.ok(typeof pull.error === 'string' && pull.error.length > 0)
    const push = await (await fetch(`${base}/api/push`, { method: 'POST' })).json()
    assert.ok(typeof push.error === 'string' && push.error.length > 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('immutable endpoints answer 304 while working-tree reads stay fresh', async (t) => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  const rev = (await (await fetch(`${base}/api/rev`)).json()).rev
  assert.ok(typeof rev === 'string' && rev.length > 0)

  // /log is fully described by the revision → 304
  const again = await fetch(`${base}/api/log?rev=${rev}`)
  assert.equal(again.status, 304)

  // /compare is a commit-graph read, so the same rule holds
  const compared = await fetch(`${base}/api/compare?left=main&right=main&rev=${rev}`)
  assert.equal(compared.status, 304)

  // /status depends on the working tree → never 304, even with the same rev
  const status = await fetch(`${base}/api/status?rev=${rev}`)
  assert.equal(status.status, 200)
  assert.ok(Array.isArray((await status.json()).files))
})

test('the log can be scoped to any branch through ?ref=', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    gitSync(dir, ['commit', '-qam', 'second on main'])
    gitSync(dir, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    gitSync(dir, ['commit', '-qam', 'feature only'])
    gitSync(dir, ['checkout', '-q', 'main'])

    // SourceTree 式：只看某一个分支的历史，不掺入其它分支
    const scoped = await (await fetch(`${base}/api/log?ref=feature&all=0&limit=50`)).json()
    assert.equal(scoped[0].subject, 'feature only')
    assert.equal(scoped[1].subject, 'second on main')
    assert.equal(scoped.length, 3)

    // 同一个 rev 下换 ref 不会串缓存：key 里带上了参数
    const again = await (await fetch(`${base}/api/log?ref=feature&all=0&limit=50`)).json()
    assert.equal(again[0].subject, 'feature only')

    const all = await (await fetch(`${base}/api/log?all=1&limit=50`)).json()
    assert.ok(all.some((entry) => entry.subject === 'feature only'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkout-commit detaches HEAD, delete-branch guards the default branch', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    gitSync(dir, ['commit', '-qam', 'second'])
    const log = await (await fetch(`${base}/api/log?limit=10`)).json()
    const first = log[1]

    const detached = await fetch(`${base}/api/checkout-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, sha: first.hash }),
    })
    assert.equal(detached.status, 200)
    const status = await (await fetch(`${base}/api/status`)).json()
    assert.equal(status.detached, true)

    const badSha = await fetch(`${base}/api/checkout-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, sha: 'not-a-sha' }),
    })
    assert.equal(badSha.status, 500)
    assert.match((await badSha.json()).error, /invalid commit sha/)

    // 默认分支永远拒绝删除，参数怎么传都没用
    for (const branch of ['main', 'master', 'HEAD']) {
      const protect = await fetch(`${base}/api/delete-branch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, branch, force: true }),
      })
      assert.equal(protect.status, 500, `${branch} must be refused`)
      assert.match((await protect.json()).error, /refusing to delete the default branch/)
    }

    const badName = await fetch(`${base}/api/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, branch: '--force' }),
    })
    assert.equal(badName.status, 500)
    assert.match((await badName.json()).error, /invalid branch name/)

    // 未合并分支先 -d 被拒，确认后 -D 才生效
    gitSync(dir, ['checkout', '-q', '-b', 'experiment'])
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n')
    gitSync(dir, ['commit', '-qam', 'experiment only'])
    gitSync(dir, ['checkout', '-q', 'main'])

    const refuse = await fetch(`${base}/api/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, branch: 'experiment' }),
    })
    assert.equal(refuse.status, 500)
    assert.match((await refuse.json()).error, /not fully merged/)

    const forced = await fetch(`${base}/api/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, branch: 'experiment', force: true }),
    })
    assert.equal(forced.status, 200)
    const branches = await (await fetch(`${base}/api/branches`)).json()
    assert.ok(!branches.local.some((branch) => branch.name === 'experiment'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a paused operation is reported and can be aborted; untracked paths can be ignored', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  const post = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir, ...body }) })
    return { status: response.status, body: await response.json() }
  }
  const readStatus = async () => (await (await fetch(`${base}/api/status`)).json())
  try {
    gitSync(dir, ['checkout', '-q', '-b', 'side'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nSIDE\nthree\n')
    gitSync(dir, ['commit', '-q', '-am', 'side edit'])
    const sideSha = gitSync(dir, ['rev-parse', 'side']).trim()
    gitSync(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nMAIN\nthree\n')
    gitSync(dir, ['commit', '-q', '-am', 'main edit'])

    await post('/api/merge', { branch: 'side' })
    const merging = await readStatus()
    assert.equal(merging.operation, 'merge')
    assert.equal(merging.merging, true)
    assert.equal(merging.counts.conflicted, 1)

    assert.deepEqual(await post('/api/abort', {}), { status: 200, body: { ok: true, operation: 'merge' } })
    const aborted = await readStatus()
    assert.equal(aborted.operation, null)
    assert.equal(aborted.merging, false)
    assert.equal(aborted.files.length, 0)
    assert.equal(gitSync(dir, ['rev-parse', 'HEAD']).trim(), gitSync(dir, ['rev-parse', 'main']).trim())

    // Nothing is in progress: the same call must refuse rather than run a stray abort.
    const idle = await post('/api/abort', {})
    assert.ok(idle.status >= 400)
    assert.match(String(idle.body.error), /nothing is in progress/)

    await post('/api/cherry-pick', { hashes: [sideSha] })
    const picking = await readStatus()
    assert.equal(picking.operation, 'cherry-pick')
    assert.equal(picking.counts.conflicted, 1)
    await post('/api/abort', {})
    assert.equal((await readStatus()).files.length, 0)

    await writeFile(path.join(dir, 'scratch.log'), 'noise\n')
    await writeFile(path.join(dir, 'debug.out'), 'noise\n')
    assert.deepEqual(await post('/api/ignore', { files: ['scratch.log', 'scratch.log', 'debug.out'] }), {
      status: 200,
      body: { ok: true, path: '.gitignore', added: 2 },
    })
    assert.equal(await readFile(path.join(dir, '.gitignore'), 'utf8'), 'scratch.log\ndebug.out\n')
    // Repeating the request adds nothing, and an existing file keeps its own rules.
    assert.deepEqual((await post('/api/ignore', { files: ['scratch.log'] })).body, { ok: true, path: '.gitignore', added: 0 })
    await writeFile(path.join(dir, '.gitignore'), 'keep me\n')
    assert.equal((await post('/api/ignore', { files: ['debug.out'] })).body.added, 1)
    assert.equal(await readFile(path.join(dir, '.gitignore'), 'utf8'), 'keep me\ndebug.out\n')

    // Rewriting .gitignore dropped the scratch.log rule, so it is back in the list.
    const ignored = await readStatus()
    assert.deepEqual(ignored.files.map((file) => file.path), ['.gitignore', 'scratch.log'])
    // A name gitignore reads as syntax (`!` negation, `#` comment) is escaped.
    await writeFile(path.join(dir, '!keep.txt'), 'x\n')
    assert.equal((await post('/api/ignore', { files: ['!keep.txt'] })).body.added, 1)
    assert.equal(await readFile(path.join(dir, '.gitignore'), 'utf8'), 'keep me\ndebug.out\n\\!keep.txt\n')
    assert.ok((await post('/api/ignore', { files: ['../escape'] })).status >= 400)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('rename-branch follows HEAD and compare reports each side of the divergence', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  const rename = (body) =>
    fetch(`${base}/api/rename-branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir, ...body }) })
  const compare = async (search) => {
    const res = await fetch(`${base}/api/compare?${search}`)
    return { status: res.status, body: await res.json() }
  }
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    gitSync(dir, ['commit', '-qam', 'second on main'])
    gitSync(dir, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    gitSync(dir, ['commit', '-qam', 'feature only'])
    gitSync(dir, ['branch', 'side', 'feature'])
    gitSync(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nsix\n')
    gitSync(dir, ['commit', '-qam', 'main only'])

    // 名字既要挡住选项注入，也要挡住 git 自己会拒绝的 ref 形状
    for (const name of ['-d', 'a..b', 'refs/x/', 'bad.lock']) {
      const refused = await rename({ branch: 'feature', name })
      assert.equal(refused.status, 500, `${name} must be refused`)
      assert.match((await refused.json()).error, /invalid branch name/)
    }
    assert.match((await (await rename({ branch: 'gone', name: 'who' })).json()).error ?? '', /no such local branch/)
    assert.match((await (await rename({ branch: 'feature', name: 'side' })).json()).error ?? '', /already exists/)
    assert.match((await (await rename({ branch: 'feature', name: 'feature' })).json()).error ?? '', /already called/)

    const renamed = await rename({ branch: 'feature', name: 'feature-next' })
    assert.equal(renamed.status, 200)
    assert.equal((await renamed.json()).branch, 'feature-next')
    const names = (await (await fetch(`${base}/api/branches`)).json()).local.map((branch) => branch.name)
    assert.ok(!names.includes('feature'), 'the old name is gone')
    assert.ok(names.includes('feature-next'), 'the new name is there')

    // 改名的正是当前分支时，HEAD 跟着走，状态里读到的就是新名
    gitSync(dir, ['checkout', '-q', 'side'])
    assert.equal((await rename({ branch: 'side', name: 'side-2' })).status, 200)
    assert.equal((await (await fetch(`${base}/api/status`)).json()).branch, 'side-2')
    gitSync(dir, ['checkout', '-q', 'main'])

    const apart = await compare('left=main&right=side-2&limit=50')
    assert.equal(apart.status, 200)
    assert.equal(apart.body.ahead, 1)
    assert.equal(apart.body.behind, 1)
    assert.deepEqual(apart.body.leftOnly.map((entry) => entry.subject), ['main only'])
    assert.deepEqual(apart.body.rightOnly.map((entry) => entry.subject), ['feature only'])

    const together = await compare('left=main&right=main')
    assert.equal(together.body.ahead, 0)
    assert.equal(together.body.behind, 0)
    assert.deepEqual(together.body.leftOnly, [])

    // 省略左端就是 HEAD；右端不能省，也不许塞 range 或未知 rev
    const defaulted = await compare('right=side-2')
    assert.equal(defaulted.body.left, 'HEAD')
    assert.equal(defaulted.body.ahead, 1)
    assert.match((await compare('left=main')).body.error ?? '', /needs a branch/)
    assert.match((await compare('left=main&right=main~3')).body.error ?? '', /invalid revision/)
    assert.match((await compare('left=main&right=nope')).body.error ?? '', /unknown revision/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('stash push/pop round-trips and the list is never served from a 304', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    const post = (body) =>
      fetch(`${base}/api/stash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, ...body }),
      })

    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo changed\nthree\n')
    assert.equal((await post({ action: 'push' })).status, 200)

    let stashes = await (await fetch(`${base}/api/stash`)).json()
    assert.equal(stashes.length, 1)
    assert.equal(stashes[0].ref, 'stash@{0}')
    assert.match(stashes[0].subject, /two changed|WIP/)
    const clean = await (await fetch(`${base}/api/status`)).json()
    assert.equal(clean.files.length, 0, 'the working tree is clean right after a push')

    const rev = (await (await fetch(`${base}/api/rev`)).json()).rev

    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo changed again\nthree\n')
    assert.equal((await post({ action: 'push' })).status, 200)
    stashes = await (await fetch(`${base}/api/stash`)).json()
    assert.equal(stashes.length, 2)

    // refs/stash 是就地改写的：revision 可能不动，所以 /stash 绝不参与 304
    const conditional = await fetch(`${base}/api/stash?rev=${rev}`)
    assert.equal(conditional.status, 200)
    assert.equal((await conditional.json()).length, 2)

    assert.equal((await post({ action: 'pop', ref: 'stash@{0}' })).status, 200)
    const restored = await (await fetch(`${base}/api/status`)).json()
    assert.equal(restored.files.length, 1, 'the popped change is back in the worktree')
    stashes = await (await fetch(`${base}/api/stash`)).json()
    assert.equal(stashes.length, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('the history walks every ref but never the stash pseudo-commits', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(path.join(dir, 'shelf.txt'), 'untracked\n')
    const pushed = await fetch(`${base}/api/stash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, action: 'push', message: 'shelf work' }),
    })
    assert.equal(pushed.status, 200, await pushed.text())

    gitSync(dir, ['checkout', '-q', '-b', 'side'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    gitSync(dir, ['commit', '-qam', 'side only'])
    gitSync(dir, ['checkout', '-q', 'main'])
    gitSync(dir, ['tag', 'v9.9'])

    const list = await (await fetch(`${base}/api/log?limit=50`)).json()
    const subjects = list.map((entry) => entry.subject)
    assert.ok(subjects.includes('side only'), 'branch commits must stay reachable')
    assert.ok(!subjects.some((subject) => /index on |untracked files on |WIP on |shelf work/.test(subject)), JSON.stringify(subjects))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('panel requests do not fork git per nested call', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo changed\nthree\n')
    // warm the repository-identity cache (the one-time resolveRepo)
    assert.equal((await fetch(`${base}/api/file?file=a.txt`)).status, 200)

    // working-tree diff: 2 git diffs + 1 status, and nothing else
    const beforeFile = gitStats.spawns
    assert.equal((await fetch(`${base}/api/file?file=a.txt`)).status, 200)
    const fileSpawns = gitStats.spawns - beforeFile
    assert.ok(fileSpawns <= 3, `file diff should cost at most 3 git calls, saw ${fileSpawns}`)

    gitSync(dir, ['commit', '-qam', 'second'])
    assert.equal((await fetch(`${base}/api/commit?sha=HEAD`)).status, 200)

    // commit view: meta + patch (or the revision memo — never more)
    const beforeCommit = gitStats.spawns
    assert.equal((await fetch(`${base}/api/commit?sha=HEAD`)).status, 200)
    const commitSpawns = gitStats.spawns - beforeCommit
    assert.ok(commitSpawns <= 2, `commit view should cost at most 2 git calls, saw ${commitSpawns}`)

    // revision negotiation is filesystem-only
    const beforeRev = gitStats.spawns
    assert.equal((await fetch(`${base}/api/rev`)).status, 200)
    assert.equal(gitStats.spawns - beforeRev, 0, '/rev must not fork git at all')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('whole-file context is the host default, so index-based edits cannot drift', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    // 20 lines, changed far apart from each other.
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    await writeFile(path.join(dir, 'big.txt'), `${lines.join('\n')}\n`)
    gitSync(dir, ['add', 'big.txt'])
    gitSync(dir, ['commit', '-q', '-m', 'add big file'])
    const changed = [...lines]
    changed[3] = 'line 4 changed'
    changed[15] = 'line 16 changed'
    await writeFile(path.join(dir, 'big.txt'), `${changed.join('\n')}\n`)

    const full = await (await fetch(`${base}/api/file?file=big.txt`)).json()
    assert.equal(full.unstaged.hunks.length, 1, 'the default view is one whole-file hunk')
    assert.equal(full.unstaged.hunks[0].lines.length, 22, '18 context + 2 del + 2 add')
    const compact = await (await fetch(`${base}/api/file?file=big.txt&full=0`)).json()
    assert.equal(compact.unstaged.hunks.length, 2, 'full=0 splits where three lines of context cannot bridge the gap')

    // A hunk index read off the rendered view has to work without repeating the
    // flag — that is how the panel addresses rows after it re-fetches.
    const target = full.unstaged.hunks[0].lines.findIndex((line) => line.type === 'add' && line.text.includes('line 16'))
    const reverted = await fetch(`${base}/api/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, file: 'big.txt', mode: 'lines', selection: [{ hunk: 0, lines: [target] }] }),
    })
    assert.equal(reverted.status, 200, JSON.stringify(await reverted.json().catch(() => null)))
    const onDisk = await readFile(path.join(dir, 'big.txt'), 'utf8')
    assert.ok(!onDisk.includes('line 16'), 'discarding the added line drops it, like the IDE')
    assert.ok(onDisk.includes('line 4 changed'), 'the other block is untouched')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('listing workspaces does not require the default dir to be a repository', async () => {
  // Regression: the revision was computed for every GET, so a server started in
  // a non-repo directory answered 500 for /workspaces — the very endpoint the
  // client uses to find a repository.
  const outside = await makeTempDir('dsh-git-noworkspace-')
  const { server, base } = await startServer(outside)
  try {
    const response = await fetch(`${base}/api/workspaces`)
    const payload = await response.json()
    assert.equal(response.status, 200, JSON.stringify(payload))
    assert.ok(Array.isArray(payload.workspaces))
    // and the revision-specific endpoints still report the missing repo
    const status = await fetch(`${base}/api/status`)
    assert.equal(status.status, 500)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(outside, { recursive: true, force: true })
  }
})

test('a workspace whose folder disappeared does not break the list', async () => {
  // One stale registry entry (deleted folder, unmounted drive) used to reject
  // the whole /workspaces answer — the endpoint the client starts from.
  const dir = await makeRepo()
  const vanishedParent = await makeTempDir('dsh-git-vanished-')
  const vanished = path.join(vanishedParent, 'gone')
  const ctx = {
    get: (id) => (id === 'workspaceRegistry'
      ? {
          list: () => [
            { id: 'live', title: 'live', path: dir, updatedAt: new Date().toISOString() },
            { id: 'gone', title: 'gone', path: vanished, updatedAt: new Date().toISOString() },
          ],
        }
      : undefined),
  }
  const { server, base } = await startServer(dir, { ctx })
  try {
    const response = await fetch(`${base}/api/workspaces`)
    const payload = await response.json()
    assert.equal(response.status, 200, JSON.stringify(payload))
    assert.equal(payload.workspaces.find((entry) => entry.id === 'gone').isRepo, false)
    assert.equal(payload.workspaces.find((entry) => entry.id === 'live').isRepo, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
    await rm(vanishedParent, { recursive: true, force: true })
  }
})

test('conflict resolution takes a side, and read-only refuses the same write', async () => {
  const dir = await makeRepo()
  try {
    gitSync(dir, ['checkout', '-q', '-b', 'other'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nother\nthree\n')
    gitSync(dir, ['commit', '-q', '-am', 'other side'])
    gitSync(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nmain\nthree\n')
    gitSync(dir, ['commit', '-q', '-am', 'main side'])
    assert.throws(() => gitSync(dir, ['merge', 'other']))

    const { server, base } = await startServer(dir)
    try {
      const status = await (await fetch(`${base}/api/status`)).json()
      assert.equal(status.files[0].kind, 'conflicted')

      const resolved = await fetch(`${base}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'a.txt', strategy: 'ours' }),
      })
      assert.equal(resolved.status, 200)
      // core.autocrlf may rewrite the worktree file on Windows.
      assert.equal((await readFile(path.join(dir, 'a.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'one\nmain\nthree\n')
      // Taking our side leaves no diff against HEAD, but the merge still has
      // to be committed; status exposes that through `merging`.
      const after = await (await fetch(`${base}/api/status`)).json()
      assert.equal(after.merging, true)
      assert.equal(after.files.length, 0)

      const finished = await fetch(`${base}/api/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'merge other' }),
      })
      assert.equal(finished.status, 200)
      const clean = await (await fetch(`${base}/api/status`)).json()
      assert.equal(clean.merging, false)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }

    const readOnly = await startServer(dir, { readOnly: true })
    try {
      const refused = await fetch(`${readOnly.base}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'a.txt', strategy: 'theirs' }),
      })
      assert.equal(refused.status, 403)
    } finally {
      await new Promise((resolve) => readOnly.server.close(resolve))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the merge view reads both sides and answers one conflict at a time', async () => {
  const dir = await makeRepo()
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
    gitSync(dir, ['commit', '-q', '-am', 'ancestor'])
    gitSync(dir, ['checkout', '-q', '-b', 'other'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nOTHER-2\nthree\nfour\nfive\nsix\nOTHER-7\neight\n')
    gitSync(dir, ['commit', '-q', '-am', 'their side'])
    gitSync(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nMAIN-2\nthree\nfour\nfive\nsix\nMAIN-7\neight\n')
    gitSync(dir, ['commit', '-q', '-am', 'our side'])
    assert.throws(() => gitSync(dir, ['merge', 'other']))

    // core.autocrlf may rewrite the worktree file on Windows.
    const worktree = async () => (await readFile(path.join(dir, 'a.txt'), 'utf8')).replaceAll('\r\n', '\n')
    const { server, base } = await startServer(dir)
    const post = poster(base)
    try {
      const view = await (await post('conflict-view', { file: 'a.txt' })).json()
      assert.equal(view.count, 2)
      assert.equal(view.complete, true)
      // the ancestor is read from index stage 1, without the trailing newline
      assert.equal(view.base, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight')
      const blocks = view.segments.filter((segment) => segment.kind === 'conflict')
      assert.deepEqual(blocks.map((block) => block.ours), [['MAIN-2'], ['MAIN-7']])
      assert.deepEqual(blocks.map((block) => block.theirs), [['OTHER-2'], ['OTHER-7']])
      // regions are numbered by order in the file and remember where they start
      assert.deepEqual(blocks.map((block) => block.index), [0, 1])
      assert.equal(blocks[0].line, 2)
      assert.equal(blocks[1].line > blocks[0].line, true)
      // whatever sits outside the markers is already agreed
      assert.deepEqual(view.segments[0].lines, ['one'])

      // answering the second block leaves the first one exactly as git wrote it
      const half = await post('resolve-region', { file: 'a.txt', region: 1, strategy: 'both' })
      assert.deepEqual(await half.json(), { ok: true, strategy: 'both', region: 1, remaining: 1 })
      const afterFirst = await worktree()
      assert.match(afterFirst, /^<<<<<<< HEAD$/m)
      assert.equal(afterFirst.includes('MAIN-2\n=======\nOTHER-2'), true)
      assert.equal(afterFirst.includes('MAIN-7\nOTHER-7'), true)
      // one block left still means the file is listed as conflicted
      const mid = await (await fetch(`${base}/api/status`)).json()
      assert.equal(mid.files.find((file) => file.path === 'a.txt')?.kind, 'conflicted')

      const last = await (await post('resolve-region', { file: 'a.txt', region: 0, strategy: 'ours' })).json()
      assert.equal(last.remaining, 0)
      assert.equal(await worktree(), 'one\nMAIN-2\nthree\nfour\nfive\nsix\nMAIN-7\nOTHER-7\neight\n')
      // the final block stages the file: nothing is left to resolve
      const status = await (await fetch(`${base}/api/status`)).json()
      assert.equal(status.counts.conflicted, 0)
      assert.equal(status.files.find((file) => file.path === 'a.txt')?.staged, true)

      // a file without markers left is refused instead of rewritten
      const gone = await post('resolve-region', { file: 'a.txt', region: 0, strategy: 'ours' })
      assert.equal(gone.status, 500)
      assert.match((await gone.json()).error, /no such conflict region/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a conflict block can be finished with hand-edited text', async () => {
  const dir = await makeRepo()
  try {
    // makeRepo's initial commit is the ancestor: one / two / three.
    gitSync(dir, ['checkout', '-q', '-b', 'other'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nOTHER\nthree\n')
    gitSync(dir, ['commit', '-q', '-am', 'their side'])
    gitSync(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nMAIN\nthree\n')
    gitSync(dir, ['commit', '-q', '-am', 'our side'])
    assert.throws(() => gitSync(dir, ['merge', 'other']))

    const { server, base } = await startServer(dir)
    const post = poster(base)
    try {
      const view = await (await post('conflict-view', { file: 'a.txt' })).json()
      assert.equal(view.count, 1)
      const [block] = view.segments.filter((segment) => segment.kind === 'conflict')
      assert.deepEqual(block.ours, ['MAIN'])
      assert.deepEqual(block.theirs, ['OTHER'])

      // The result replaces the whole block: it can combine both sides however
      // the author writes it, not just concatenate them.
      const custom = await post('resolve-region', { file: 'a.txt', region: 0, strategy: 'custom', result: 'MAIN, then OTHER' })
      assert.equal(custom.status, 200)
      assert.deepEqual(await custom.json(), { ok: true, strategy: 'custom', region: 0, remaining: 0 })
      const text = (await readFile(path.join(dir, 'a.txt'), 'utf8')).replaceAll('\r\n', '\n')
      assert.equal(text, 'one\nMAIN, then OTHER\nthree\n')
      // the last block stages the file, exactly like the side buttons do
      const status = await (await fetch(`${base}/api/status`)).json()
      assert.equal(status.counts.conflicted, 0)
      assert.equal(status.files.find((file) => file.path === 'a.txt')?.staged, true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('/config reports every knob with the host defaults', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    const config = await (await fetch(`${base}/api/config`)).json()
    assert.deepEqual(config, {
      branchPattern: 'session/{date}-{time}',
      diffFullFile: true,
      diffWrap: true,
      diffFoldThreshold: 8,
      diffSideBySide: true,
      listMode: 'last',
      confirmDirtySwitch: true,
      readOnly: false,
      commitLanguage: 'auto',
      llmProvider: '',
      llmModel: '',
      maxLog: 400,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('rollback restores tracked files, un-stages new ones and deletes untracked ones', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(path.join(dir, 'staged-new.txt'), 'added to the index\n')
    await fetch(`${base}/api/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: ['staged-new.txt'], direction: 'stage' }),
    })
    await writeFile(path.join(dir, 'loose.txt'), 'never committed\n')

    const done = await fetch(`${base}/api/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: ['a.txt', 'staged-new.txt', 'loose.txt'] }),
    })
    assert.equal(done.status, 200, await done.text())

    const norm = (text) => text.replace(/\r\n/g, '\n')
    assert.equal(norm(await readFile(path.join(dir, 'a.txt'), 'utf8')), 'one\ntwo\nthree\n')
    assert.equal(await readFile(path.join(dir, 'staged-new.txt'), 'utf8').catch(() => null), 'added to the index\n')
    assert.equal(await readFile(path.join(dir, 'loose.txt'), 'utf8').catch(() => null), null)

    const status = await (await fetch(`${base}/api/status`)).json()
    assert.deepEqual(status.files.map((file) => `${file.path}:${file.kind}`), ['staged-new.txt:untracked'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('revert discards a worktree hunk', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    // worktree change in the middle
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')

    const before = await (await fetch(`${base}/api/file?file=a.txt&full=1`)).json()
    assert.equal(before.unstaged.hunks.length, 1)

    const reverted = await fetch(`${base}/api/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'a.txt', mode: 'hunk', hunk: 0 }),
    })
    assert.equal(reverted.status, 200, await reverted.text())

    // line endings differ per checkout policy (CRLF on Windows), compare normalised
    const restored = (await readFile(path.join(dir, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')
    assert.equal(restored, 'one\ntwo\nthree\n')
    // and the change itself is gone
    const after = await (await fetch(`${base}/api/file?file=a.txt&full=1`)).json()
    assert.equal(after.unstaged ?? null, null)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

/** Small POST helper shared by the endpoints added for the tag / history menus. */
function poster(base) {
  /**
   * @param {string} route
   * @param {Record<string, any>} body
   */
  return (route, body) =>
    fetch(`${base}/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
}

test('tags are created, moved and deleted by the api and reported in the branch payload', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  const post = poster(base)
  try {
    const first = gitSync(dir, ['rev-parse', 'HEAD']).trim()
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    gitSync(dir, ['commit', '-qam', 'second'])
    const second = gitSync(dir, ['rev-parse', 'HEAD']).trim()

    const created = await post('tag', { dir, name: 'v1.0.0', ref: first })
    assert.equal(created.status, 200, await created.text())
    assert.equal(gitSync(dir, ['rev-parse', 'v1.0.0']).trim(), first)

    const listed = await (await fetch(`${base}/api/branches`)).json()
    assert.ok(listed.tags.includes('v1.0.0'), 'branches must expose the tag list')

    // 同名标签没有 force 时由 git 拒绝，错误原样带回
    const clash = await post('tag', { dir, name: 'v1.0.0', ref: second })
    assert.equal(clash.status, 500)
    assert.match((await clash.json()).error, /already exists/)

    const moved = await post('tag', { dir, name: 'v1.0.0', ref: second, force: true })
    assert.equal(moved.status, 200, await moved.text())
    assert.equal(gitSync(dir, ['rev-parse', 'v1.0.0']).trim(), second)

    // 标签名走同一套 ref 校验：空、`-` 开头、带空格都进不了 argv
    for (const name of ['', '--force', 'bad name', 'a;rm']) {
      const refused = await post('tag', { dir, name })
      assert.equal(refused.status, 500, `${JSON.stringify(name)} must be refused`)
      assert.match((await refused.json()).error, /invalid tag name/)
    }

    // 分离头指针检出标签，再切回分支
    const detached = await post('switch', { dir, ref: 'v1.0.0' })
    assert.equal(detached.status, 200, await detached.text())
    assert.equal((await (await fetch(`${base}/api/status`)).json()).detached, true)
    const back = await post('checkout', { dir, branch: 'main' })
    assert.equal(back.status, 200, await back.text())
    assert.equal(gitSync(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main')

    const removed = await post('delete-tag', { dir, names: ['v1.0.0'] })
    const removedBody = await removed.json()
    assert.equal(removed.status, 200)
    assert.equal(removedBody.removed, 1)
    assert.equal(gitSync(dir, ['tag', '-l']).trim(), '')

    const missing = await post('delete-tag', { dir, name: 'v1.0.0' })
    assert.equal(missing.status, 500)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('cherry-pick, revert and reset run real git and guard every destructive path', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  const post = poster(base)
  try {
    const trunk = gitSync(dir, ['rev-parse', 'HEAD']).trim()

    gitSync(dir, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(dir, 'b.txt'), 'feature\n')
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-q', '-m', 'feature work'])
    const feature = gitSync(dir, ['rev-parse', 'HEAD']).trim()
    gitSync(dir, ['checkout', '-q', 'main'])

    const picked = await post('cherry-pick', { dir, hash: feature })
    assert.equal(picked.status, 200, await picked.text())
    assert.equal((await readFile(path.join(dir, 'b.txt'), 'utf8')).trim(), 'feature')

    // 非 sha 的 ref 绝不进 argv，否则 `-p` 之类会被当成选项
    const badRef = await post('cherry-pick', { dir, hash: 'HEAD' })
    assert.equal(badRef.status, 500)
    assert.match((await badRef.json()).error, /invalid commit sha/)

    const reverted = await post('revert-commit', { dir, hash: gitSync(dir, ['rev-parse', 'HEAD']).trim() })
    assert.equal(reverted.status, 200, await reverted.text())
    assert.match(gitSync(dir, ['log', '-1', '--pretty=%s']), /Revert/)
    assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8').catch(() => null), null)

    const hardWithoutConfirm = await post('reset', { dir, mode: 'hard', ref: trunk })
    assert.equal(hardWithoutConfirm.status, 500)
    assert.match((await hardWithoutConfirm.json()).error, /needs an explicit confirmation/)

    const badMode = await post('reset', { dir, mode: 'merge', ref: trunk })
    assert.equal(badMode.status, 500)
    assert.match((await badMode.json()).error, /invalid reset mode/)

    // soft 只动 HEAD，被撤销的提交留在暂存区
    await writeFile(path.join(dir, 'c.txt'), 'stays staged\n')
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-q', '-m', 'third'])
    const soft = await post('reset', { dir, mode: 'soft', ref: 'HEAD~1' })
    assert.equal(soft.status, 200, await soft.text())
    const staged = await (await fetch(`${base}/api/status`)).json()
    assert.ok(staged.files.some((file) => file.path === 'c.txt' && file.staged))

    const hard = await post('reset', { dir, mode: 'hard', ref: trunk, confirm: true })
    assert.equal(hard.status, 200, await hard.text())
    assert.equal(gitSync(dir, ['rev-parse', 'HEAD']).trim(), trunk)
    assert.equal((await (await fetch(`${base}/api/status`)).json()).files.length, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a batch of commits is picked and reverted in the order it was written', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  const post = poster(base)
  try {
    const trunk = gitSync(dir, ['rev-parse', 'HEAD']).trim()

    gitSync(dir, ['checkout', '-q', '-b', 'stack'])
    const shas = []
    for (const name of ['one', 'two', 'three']) {
      await writeFile(path.join(dir, `${name}.txt`), `${name}\n`)
      gitSync(dir, ['add', '-A'])
      gitSync(dir, ['commit', '-q', '-m', `commit ${name}`])
      shas.push(gitSync(dir, ['rev-parse', 'HEAD']).trim())
    }
    gitSync(dir, ['checkout', '-q', 'main'])

    // The log lists newest first, so the client hands the batch over in that
    // order and the host has to replay it oldest first.
    const picked = await post('cherry-pick', { dir, hashes: [...shas].reverse() })
    const pickedBody = await picked.text()
    assert.equal(picked.status, 200, pickedBody)
    assert.equal(JSON.parse(pickedBody).picked, 3)
    // A cherry-pick writes new commits, so compare the tree, not the sha.
    assert.equal(gitSync(dir, ['rev-parse', 'HEAD^{tree}']).trim(), gitSync(dir, ['rev-parse', `${shas[2]}^{tree}`]).trim())
    assert.deepEqual(
      gitSync(dir, ['log', '-3', '--pretty=%s']).trim().split('\n'),
      ['commit three', 'commit two', 'commit one'],
    )

    // Undoing the batch writes the reverts oldest first, so the newest revert
    // sits on top of the log.
    const reverted = await post('revert-commit', { dir, hashes: [...shas].reverse() })
    const revertedBody = await reverted.text()
    assert.equal(reverted.status, 200, revertedBody)
    assert.equal(JSON.parse(revertedBody).reverted, 3)
    assert.deepEqual(
      gitSync(dir, ['log', '-3', '--pretty=%s']).trim().split('\n'),
      ['Revert "commit three"', 'Revert "commit two"', 'Revert "commit one"'],
    )
    assert.equal(gitSync(dir, ['rev-parse', 'HEAD^{tree}']).trim(), gitSync(dir, ['rev-parse', `${trunk}^{tree}`]).trim())

    const empty = await post('cherry-pick', { dir, hashes: [] })
    assert.equal(empty.status, 500)
    assert.match((await empty.json()).error, /no commits selected/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a partial stash shelves only the selected paths, not unrelated staged work', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  const post = poster(base)
  try {
    await writeFile(path.join(dir, 'b.txt'), 'b one\n')
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-q', '-m', 'add b'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(path.join(dir, 'b.txt'), 'b ONE\n')
    gitSync(dir, ['add', 'b.txt'])
    await writeFile(path.join(dir, 'c.txt'), 'untracked\n')

    const pushed = await post('stash', { dir, action: 'push', message: 'only a', paths: ['a.txt'] })
    assert.equal(pushed.status, 200, await pushed.text())

    const listed = await (await fetch(`${base}/api/stash`)).json()
    assert.equal(listed.length, 1)
    assert.match(listed[0].subject, /only a/)
    // The unrelated staged file must not ride along in the stash index parent.
    const shown = await (await fetch(`${base}/api/stash-show?ref=${encodeURIComponent(listed[0].ref)}`)).json()
    assert.deepEqual(shown.files.map((file) => file.path), ['a.txt'])

    const status = await (await fetch(`${base}/api/status`)).json()
    assert.deepEqual(status.files.map((file) => file.path).sort(), ['b.txt', 'c.txt'])
    assert.equal(status.files.find((file) => file.path === 'b.txt').staged, true)
    assert.equal((await readFile(path.join(dir, 'a.txt'), 'utf8')).trim(), 'one\ntwo\nthree')

    // Applying the shelf brings the selected file back and leaves the staged
    // file and the untracked file exactly as they were.
    const applied = await post('stash', { dir, action: 'apply', ref: listed[0].ref })
    assert.equal(applied.status, 200, await applied.text())
    assert.match(await readFile(path.join(dir, 'a.txt'), 'utf8'), /TWO/)
    assert.match(gitSync(dir, ['diff', '--cached', '--', 'b.txt']), /b ONE/)
    assert.equal((await readFile(path.join(dir, 'c.txt'), 'utf8')).trim(), 'untracked')

    const dropped = await post('stash', { dir, action: 'drop', ref: listed[0].ref })
    assert.equal(dropped.status, 200, await dropped.text())

    // A selected file that was staged: the shelf takes it and the real index
    // is unstaged for that path only.
    const stagedPush = await post('stash', { dir, action: 'push', message: 'staged only', paths: ['b.txt'] })
    assert.equal(stagedPush.status, 200, await stagedPush.text())
    const stagedList = await (await fetch(`${base}/api/stash`)).json()
    const stagedShown = await (await fetch(`${base}/api/stash-show?ref=${encodeURIComponent(stagedList[0].ref)}`)).json()
    assert.deepEqual(stagedShown.files.map((file) => file.path), ['b.txt'])
    const afterStaged = await (await fetch(`${base}/api/status`)).json()
    assert.deepEqual(afterStaged.files.map((file) => file.path).sort(), ['a.txt', 'c.txt'])
    assert.deepEqual(gitSync(dir, ['diff', '--cached', '--name-only']).trim(), '')
    const stagedDrop = await post('stash', { dir, action: 'drop', ref: stagedList[0].ref })
    assert.equal(stagedDrop.status, 200, await stagedDrop.text())

    const escape = await post('stash', { dir, action: 'push', paths: ['../outside.txt'] })
    assert.equal(escape.status, 500)
    assert.match((await escape.json()).error, /escapes the repository/)
    const flag = await post('stash', { dir, action: 'push', paths: ['-f'] })
    assert.equal(flag.status, 500)
    assert.match((await flag.json()).error, /looks like a flag/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stash keeps its message, takes untracked files and can be applied or dropped by ref', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir)
  const post = poster(base)
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(path.join(dir, 'new.txt'), 'untracked\n')

    const pushed = await post('stash', { dir, action: 'push', message: 'WIP on main: half finished' })
    assert.equal(pushed.status, 200, await pushed.text())

    const listed = await (await fetch(`${base}/api/stash`)).json()
    assert.equal(listed.length, 1)
    assert.match(listed[0].subject, /half finished/)
    // 未跟踪文件一起进储藏，工作区才能干净
    assert.equal(await readFile(path.join(dir, 'new.txt'), 'utf8').catch(() => null), null)

    // A row click previews the stash instead of touching the worktree. The
    // preview must list the untracked file, which plain `git stash show -p`
    // leaves out of the patch.
    const ref = encodeURIComponent(listed[0].ref)
    const quiet = await readFile(path.join(dir, 'a.txt'), 'utf8')
    const shown = await (await fetch(`${base}/api/stash-show?ref=${ref}`)).json()
    assert.deepEqual(shown.files.map((file) => file.path).sort(), ['a.txt', 'new.txt'])
    const preview = await (await fetch(`${base}/api/stash-file?ref=${ref}&file=new.txt`)).json()
    assert.equal(preview.file, 'new.txt')
    assert.ok((preview.unstaged?.hunks ?? []).length > 0, 'the untracked file has a preview')
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), quiet, 'previewing applies nothing')

    const refused = await fetch(`${base}/api/stash-show?ref=${encodeURIComponent('stash@{9}')}`)
    assert.equal(refused.status, 500)
    assert.match((await refused.json()).error, /no such stash/)
    // A ref that would read as a git option never reaches the subprocess.
    const flagged = await fetch(`${base}/api/stash-file?ref=${encodeURIComponent('-R')}&file=a.txt`)
    assert.equal(flagged.status, 500)
    assert.match((await flagged.json()).error, /invalid revision/)

    const applied = await post('stash', { dir, action: 'apply', ref: listed[0].ref })
    assert.equal(applied.status, 200, await applied.text())
    assert.equal((await readFile(path.join(dir, 'new.txt'), 'utf8')).trim(), 'untracked')
    assert.equal((await (await fetch(`${base}/api/stash`)).json()).length, 1, 'apply must keep the entry')

    const dropped = await post('stash', { dir, action: 'drop', ref: listed[0].ref })
    assert.equal(dropped.status, 200, await dropped.text())
    assert.equal((await (await fetch(`${base}/api/stash`)).json()).length, 0)

    const badAction = await post('stash', { dir, action: 'clear' })
    assert.equal(badAction.status, 500)
    assert.match((await badAction.json()).error, /invalid stash action/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('init turns a plain folder into a repository without touching its files', async () => {
  const dir = await makeTempDir('dsh-git-http-init-')
  await writeFile(path.join(dir, 'note.txt'), 'keep me\n')
  const { server, base } = await startServer(dir)
  const post = (pathname, body) => fetch(`${base}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const before = await fetch(`${base}/api/status`)
    assert.equal(before.status, 500)
    assert.match((await before.json()).error, /not a git repository/)

    const created = await post('/init', { dir })
    const createdText = await created.text()
    assert.equal(created.status, 200, createdText)
    const payload = JSON.parse(createdText)
    assert.equal(payload.ok, true)
    assert.equal(payload.already, undefined)
    assert.ok(sameFolder(payload.root, dir), `${payload.root} is not ${dir}`)

    const status = await (await fetch(`${base}/api/status`)).json()
    assert.deepEqual(status.files.map((file) => [file.path, file.kind]), [['note.txt', 'untracked']])
    assert.equal(await readFile(path.join(dir, 'note.txt'), 'utf8'), 'keep me\n')

    // A second click (or a stale tab) is a refresh, not an error.
    const again = await (await post('/init', { dir })).json()
    assert.equal(again.ok, true)
    assert.equal(again.already, true)
    assert.ok(sameFolder(again.root, dir), `${again.root} is not ${dir}`)

    // A folder already owned by a parent repo must not become a nested repo.
    const nested = path.join(dir, 'sub')
    await mkdir(nested)
    const child = await (await post('/init', { dir: nested })).json()
    assert.equal(child.already, true)
    assert.ok(sameFolder(child.root, dir), `${child.root} is not ${dir}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('interactive rebase previews, reorders, squashes and drops commits', async () => {
  const dir = await makeRepo()
  const commit = (message) => gitSync(dir, ['commit', '-q', '-m', message])
  await writeFile(path.join(dir, 'b.txt'), 'second\n')
  gitSync(dir, ['add', '-A'])
  commit('feat: second')
  await writeFile(path.join(dir, 'c.txt'), 'third\n')
  gitSync(dir, ['add', '-A'])
  commit('feat: third')
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  gitSync(dir, ['add', '-A'])
  commit('fix: a fourth line')
  const base = gitSync(dir, ['rev-parse', 'HEAD~3']).trim()
  const [second, third, fourth] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((ref) => gitSync(dir, ['rev-parse', ref]).trim())
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const plan = await (await fetch(`${url}/api/rebase-plan?base=${base}`)).json()
    assert.deepEqual(plan.commits.map((item) => item.subject), ['feat: second', 'feat: third', 'fix: a fourth line'])
    assert.equal(plan.commits[0].hash, second)

    // Validate the plan before rewriting: after a rebase the old hashes are
    // gone, so "missing commit" and "squash first" would fail for the wrong
    // reason (unknown hash / short count) if checked afterwards.
    const missing = await post('/rebase', { dir, base, entries: [{ hash: second, action: 'pick' }] })
    assert.equal(missing.status, 500)
    assert.match((await missing.json()).error, /every commit exactly once/)
    const badFirst = await post('/rebase', {
      dir,
      base,
      entries: [
        { hash: second, action: 'squash' },
        { hash: third, action: 'pick' },
        { hash: fourth, action: 'drop' },
      ],
    })
    assert.equal(badFirst.status, 500)
    assert.match((await badFirst.json()).error, /first kept commit/)

    // Move the fourth commit before the third, fold it into the second, drop
    // the third. Oldest-first is exactly git's todo order.
    const applied = await post('/rebase', {
      dir,
      base,
      entries: [
        { hash: second, action: 'pick' },
        { hash: fourth, action: 'squash' },
        { hash: third, action: 'drop' },
      ],
    })
    const payload = await applied.json()
    assert.equal(applied.status, 200, JSON.stringify(payload))
    assert.equal(payload.ok, true)
    // Two rows survive, but the squash folds the fourth into the second, so
    // the rewritten history has a single new commit.
    assert.equal(payload.kept, 1)
    assert.equal(payload.folded, 1)
    assert.equal(payload.dropped, 1)
    assert.deepEqual(
      gitSync(dir, ['log', '--reverse', '--format=%s']).trim().split('\n'),
      ['init', 'feat: second'],
    )
    assert.equal(gitSync(dir, ['status', '--porcelain']).trim(), '')
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\n')
    assert.match(gitSync(dir, ['log', '-1', '--format=%B']), /fix: a fourth line/, 'squash keeps both messages')
    await assert.rejects(readFile(path.join(dir, 'c.txt')), /ENOENT/, 'the dropped commit never lands')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('rebase current onto a branch replays its commits and refuses unsafe targets', async () => {
  const dir = await makeRepo()
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    gitSync(dir, ['checkout', '-q', '-b', 'onto-base'])
    await writeFile(path.join(dir, 'base-only.txt'), 'base\n')
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-q', '-m', 'feat: base only'])
    // Topic branches before the base-only commit, so the rebase must replay it.
    gitSync(dir, ['checkout', '-q', '-b', 'onto-topic', 'HEAD~1'])
    await writeFile(path.join(dir, 'topic-only.txt'), 'topic\n')
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-q', '-m', 'feat: topic only'])

    await writeFile(path.join(dir, 'a.txt'), 'dirty\n')
    const dirty = await post('/rebase-onto', { dir, branch: 'onto-base' })
    assert.equal(dirty.status, 500)
    assert.match((await dirty.json()).error, /clean worktree/)
    gitSync(dir, ['checkout', '--', 'a.txt'])

    const self = await post('/rebase-onto', { dir, branch: 'onto-topic' })
    assert.equal(self.status, 500)
    assert.match((await self.json()).error, /onto itself/)
    const unknown = await post('/rebase-onto', { dir, branch: 'no-such-branch' })
    assert.equal(unknown.status, 500)
    assert.match((await unknown.json()).error, /unknown branch/)

    const applied = await post('/rebase-onto', { dir, branch: 'onto-base' })
    const payload = await applied.json()
    assert.equal(applied.status, 200, JSON.stringify(payload))
    assert.equal(payload.ok, true)
    assert.deepEqual(
      gitSync(dir, ['log', '--format=%s']).trim().split('\n'),
      ['feat: topic only', 'feat: base only', 'init'],
    )
    assert.equal(gitSync(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'onto-topic')
    assert.equal(gitSync(dir, ['status', '--porcelain']).trim(), '')
    assert.equal(await readFile(path.join(dir, 'topic-only.txt'), 'utf8'), 'topic\n')
    assert.equal(await readFile(path.join(dir, 'base-only.txt'), 'utf8'), 'base\n')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a changelist commit takes only its own files and leaves the rest staged', async () => {
  const dir = await makeRepo()
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    // Two tracked files, both staged, plus one untracked file.
    await writeFile(path.join(dir, 'b.txt'), 'b0\n')
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-q', '-m', 'feat: base files'])

    await writeFile(path.join(dir, 'a.txt'), 'a1\n')
    await writeFile(path.join(dir, 'b.txt'), 'b1\n')
    await writeFile(path.join(dir, 'new.txt'), 'n1\n')
    gitSync(dir, ['add', 'a.txt', 'b.txt'])

    const empty = await post('/commit-paths', { dir, message: 'feat: only a', files: [] })
    assert.equal(empty.status, 500)
    assert.match((await empty.json()).error, /no files selected/)
    const nothing = await post('/commit-paths', { dir, message: 'feat: only a', files: ['missing.txt'] })
    assert.equal(nothing.status, 500)
    assert.match((await nothing.json()).error, /nothing staged/)

    const done = await post('/commit-paths', { dir, message: 'feat: only a', files: ['a.txt', 'new.txt'] })
    const payload = await done.json()
    assert.equal(done.status, 200, JSON.stringify(payload))
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.files.sort(), ['a.txt', 'new.txt'])
    assert.equal(gitSync(dir, ['log', '-1', '--format=%s']).trim(), 'feat: only a')
    // Only the listed file landed; the other staged file stays staged.
    assert.deepEqual(
      gitSync(dir, ['show', '--name-only', '--format=']).trim().split('\n').sort(),
      ['a.txt', 'new.txt'],
    )
    assert.equal(gitSync(dir, ['status', '--porcelain']).trim(), 'M  b.txt')
    assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), 'b1\n')
    // The committed file is clean, not "staged as a deletion".
    assert.equal(gitSync(dir, ['status', '--porcelain', '--', 'a.txt']).trim(), '')
    assert.equal(await readFile(path.join(dir, 'new.txt'), 'utf8'), 'n1\n')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a changelist commit keeps the staged hunks and leaves the rest of the file unstaged', async () => {
  const dir = await makeRepo()
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    // The first line is staged, the second one stays in the worktree.
    await writeFile(path.join(dir, 'a.txt'), 'ONE\ntwo\nthree\n')
    gitSync(dir, ['add', 'a.txt'])
    await writeFile(path.join(dir, 'a.txt'), 'ONE\nTWO\nthree\n')

    const done = await post('/commit-paths', { dir, message: 'feat: only the staged hunk', files: ['a.txt'] })
    assert.equal(done.status, 200, await done.text())
    assert.equal(gitSync(dir, ['show', 'HEAD:a.txt']).trim(), 'ONE\ntwo\nthree')
    // The unstaged hunk survives as an unstaged modification.
    assert.equal(gitSync(dir, ['status', '--porcelain']), ' M a.txt\n')
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'ONE\nTWO\nthree\n')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a changelist commit leaves a staged rename out of the commit', async () => {
  const dir = await makeRepo()
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    await writeFile(path.join(dir, 'old.txt'), 'old\n')
    await writeFile(path.join(dir, 'a.txt'), 'a0\n')
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-q', '-m', 'feat: base files'])

    // A staged rename plus a staged modification: the rename touches two
    // paths, and half of it must not slip into the other list's commit.
    await writeFile(path.join(dir, 'a.txt'), 'a1\n')
    gitSync(dir, ['add', 'a.txt'])
    gitSync(dir, ['mv', 'old.txt', 'new.txt'])

    const done = await post('/commit-paths', { dir, message: 'feat: only a', files: ['a.txt'] })
    const payload = await done.json()
    assert.equal(done.status, 200, JSON.stringify(payload))
    assert.deepEqual(
      gitSync(dir, ['show', '--name-only', '--format=']).trim().split('\n').sort(),
      ['a.txt'],
    )
    // The rename is still staged, both halves of it.
    const status = gitSync(dir, ['status', '--porcelain'])
    assert.match(status, /new\.txt/)
    assert.match(status, /old\.txt/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a conflicting rebase pauses, refuses continue until resolved, then completes', async () => {
  const dir = await makeRepo()
  const commit = (message) => gitSync(dir, ['commit', '-q', '-m', message])
  const write = async (text, message) => {
    await writeFile(path.join(dir, 'a.txt'), text)
    gitSync(dir, ['add', '-A'])
    commit(message)
  }
  await write('one\n', 'feat: two')
  await write('one\ntwo\n', 'feat: three')
  const base = gitSync(dir, ['rev-parse', 'HEAD~2']).trim()
  const [second, third] = ['HEAD~1', 'HEAD'].map((ref) => gitSync(dir, ['rev-parse', ref]).trim())
  const original = gitSync(dir, ['rev-parse', 'HEAD']).trim()
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    // Replaying the newer edit first makes the older edit conflict.
    const paused = await (await post('/rebase', {
      dir,
      base,
      entries: [
        { hash: third, action: 'pick' },
        { hash: second, action: 'pick' },
      ],
    })).json()
    assert.equal(paused.ok, false)
    assert.equal(paused.paused, true)
    assert.equal(paused.conflicts, 1)
    const conflicted = await (await fetch(`${url}/api/status`)).json()
    assert.equal(conflicted.operation, 'rebase')
    assert.equal(conflicted.files[0].kind, 'conflicted')

    const refused = await post('/continue', { dir })
    assert.equal(refused.status, 500)
    assert.match((await refused.json()).error, /resolve the conflicts first/)

    await writeFile(path.join(dir, 'a.txt'), 'resolved by hand\n')
    gitSync(dir, ['add', 'a.txt'])
    // Reordering same-line edits makes every replayed patch conflict in turn;
    // resolve until the sequencer has nothing left to ask about.
    let resumedPayload = null
    let expected = 'resolved by hand\n'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resumed = await post('/continue', { dir })
      resumedPayload = await resumed.json()
      assert.equal(resumed.status, 200, JSON.stringify(resumedPayload))
      if (resumedPayload.ok === true) break
      expected = `resolved again ${attempt}\n`
      await writeFile(path.join(dir, 'a.txt'), expected)
      gitSync(dir, ['add', 'a.txt'])
    }
    assert.equal(resumedPayload.ok, true, JSON.stringify(resumedPayload))
    assert.ok(gitSync(dir, ['rev-parse', 'HEAD']).trim() !== original)
    assert.equal(gitSync(dir, ['status', '--porcelain']).trim(), '')
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), expected)
    assert.equal(gitSync(dir, ['log', '--format=%s', '--reverse']).trim().split('\n').length, 3)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('continue reports a resumable pause when a replayed commit becomes empty', async () => {
  const dir = await makeRepo()
  const commit = (message) => gitSync(dir, ['commit', '-q', '-m', message])
  await writeFile(path.join(dir, 'a.txt'), 'one\n')
  gitSync(dir, ['add', '-A'])
  commit('feat: two')
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n')
  gitSync(dir, ['add', '-A'])
  commit('feat: three')
  const base = gitSync(dir, ['rev-parse', 'HEAD~2']).trim()
  const [second, third] = ['HEAD~1', 'HEAD'].map((ref) => gitSync(dir, ['rev-parse', ref]).trim())
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const paused = await (await post('/rebase', {
      dir,
      base,
      entries: [
        { hash: third, action: 'pick' },
        { hash: second, action: 'pick' },
      ],
    })).json()
    assert.equal(paused.paused, true)
    assert.equal(paused.conflicts, 1)

    // Resolving to the older commit's exact tree makes its replay empty, so
    // the sequencer pauses again even though nothing is conflicted.
    await writeFile(path.join(dir, 'a.txt'), 'one\n')
    gitSync(dir, ['add', 'a.txt'])
    const emptyPause = await (await post('/continue', { dir })).json()
    assert.equal(emptyPause.ok, false)
    assert.equal(emptyPause.paused, true)
    assert.equal(emptyPause.conflicts, 0)
    assert.equal(emptyPause.empty, true)

    const stillPaused = await (await fetch(`${url}/api/status`)).json()
    assert.equal(stillPaused.operation, 'rebase')
    assert.equal(stillPaused.files.length, 0, 'the empty pause carries no conflicted files')

    const done = await (await post('/continue', { dir })).json()
    assert.equal(done.ok, true)
    assert.equal(gitSync(dir, ['status', '--porcelain']).trim(), '')
    assert.deepEqual(gitSync(dir, ['log', '--format=%s', '--reverse']).trim().split('\n'), ['init', 'feat: three'])
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\n')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('reword amends HEAD and replays older commits without touching the tree', async () => {
  const dir = await makeRepo()
  const commit = (message) => gitSync(dir, ['commit', '-q', '-m', message])
  await writeFile(path.join(dir, 'a.txt'), 'one\n')
  gitSync(dir, ['add', '-A'])
  commit('feat: two')
  await writeFile(path.join(dir, 'b.txt'), 'bee\n')
  gitSync(dir, ['add', '-A'])
  commit('feat: three')
  const head = gitSync(dir, ['rev-parse', 'HEAD']).trim()
  const second = gitSync(dir, ['rev-parse', 'HEAD~1']).trim()
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const empty = await post('/reword', { dir, sha: head, message: '   ' })
    assert.equal(empty.status, 500)
    assert.match((await empty.json()).error, /cannot be empty/)
    const unknown = await post('/reword', { dir, sha: 'deadbeef', message: 'nope' })
    assert.equal(unknown.status, 500)
    assert.match((await unknown.json()).error, /unknown commit/)

    // HEAD is a plain amend: same parent, new message, no replay.
    const amended = await (await post('/reword', { dir, sha: head, message: 'feat: three (edited)' })).json()
    assert.equal(amended.ok, true)
    assert.equal(amended.amended, true)
    assert.notEqual(amended.sha, head)
    assert.equal(gitSync(dir, ['log', '-1', '--format=%s']).trim(), 'feat: three (edited)')

    // An older commit is replayed through a same-order rebase. The whole tree
    // of HEAD must survive untouched, and the commit after it is rewritten.
    const tree = gitSync(dir, ['rev-parse', 'HEAD^{tree}']).trim()
    const reworded = await (await post('/reword', { dir, sha: second, message: 'feat: two (edited)\n\nwith a body' })).json()
    assert.equal(reworded.ok, true, JSON.stringify(reworded))
    assert.equal(reworded.amended, undefined)
    assert.deepEqual(
      gitSync(dir, ['log', '--format=%s', '--reverse']).trim().split('\n'),
      ['init', 'feat: two (edited)', 'feat: three (edited)'],
    )
    assert.equal(gitSync(dir, ['log', '-1', '--format=%B', 'HEAD~1']).trim(), 'feat: two (edited)\n\nwith a body')
    assert.equal(gitSync(dir, ['rev-parse', 'HEAD^{tree}']).trim(), tree)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\n')
    assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), 'bee\n')
    assert.equal(gitSync(dir, ['status', '--porcelain']).trim(), '')

    // A dirty worktree is refused before anything is rewritten: amend would
    // otherwise fold staged edits into the message-only commit.
    await writeFile(path.join(dir, 'a.txt'), 'uncommitted\n')
    const dirty = await post('/reword', { dir, sha: gitSync(dir, ['rev-parse', 'HEAD']).trim(), message: 'feat: three again' })
    assert.equal(dirty.status, 500)
    assert.match((await dirty.json()).error, /clean worktree/)
    assert.equal(gitSync(dir, ['log', '-1', '--format=%s']).trim(), 'feat: three (edited)')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('log marks only HEAD and a soft reset undoes it without touching index or worktree', async () => {
  const dir = await makeRepo()
  const commit = (message) => gitSync(dir, ['commit', '-q', '-m', message])
  await writeFile(path.join(dir, 'a.txt'), 'one\n')
  gitSync(dir, ['add', '-A'])
  commit('feat: two')
  await writeFile(path.join(dir, 'b.txt'), 'bee\n')
  gitSync(dir, ['add', '-A'])
  commit('feat: three')
  const head = gitSync(dir, ['rev-parse', 'HEAD']).trim()
  const { server, base: url } = await startServer(dir)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const log = await (await fetch(`${url}/api/log?dir=${encodeURIComponent(dir)}&all=1`)).json()
    const marked = log.filter((entry) => entry.head === true)
    assert.equal(marked.length, 1)
    assert.equal(marked[0].hash, head)
    assert.equal(marked[0].parents.length, 1)
    // The root commit has no first parent, so the menu must not offer undo there.
    const root = log.find((entry) => entry.parents.length === 0)
    assert.ok(root)
    assert.notEqual(root.head, true)
    // Viewing another branch must not mark anything unless HEAD is in that walk.
    gitSync(dir, ['branch', 'side', 'HEAD~1'])
    const side = await (await fetch(`${url}/api/log?dir=${encodeURIComponent(dir)}&ref=side&all=0`)).json()
    assert.ok(side.every((entry) => entry.head !== true))
    gitSync(dir, ['branch', '-D', 'side'])

    // The worktree is dirty on purpose: a soft reset only moves the branch
    // pointer, so the undone commit's files stay staged and local edits intact.
    await writeFile(path.join(dir, 'c.txt'), 'undo me\n')
    gitSync(dir, ['add', 'c.txt'])
    commit('feat: four')
    await writeFile(path.join(dir, 'a.txt'), 'staged edit\n')
    gitSync(dir, ['add', 'a.txt'])
    await writeFile(path.join(dir, 'b.txt'), 'unstaged edit\n')
    const beforeUnstaged = gitSync(dir, ['diff', '--name-only']).trim()
    // Undo exactly feat:four, i.e. back to the commit HEAD had before it.
    const undone = await post('/reset', { dir, mode: 'soft', ref: head })
    assert.equal(undone.status, 200, await undone.text())
    assert.equal(gitSync(dir, ['rev-parse', 'HEAD']).trim(), head)
    // Exactly one thing changes: the undone commit's files come back into the
    // index. Every worktree byte, including the un-staged edit, stays put.
    assert.equal(gitSync(dir, ['diff', '--name-only']).trim(), beforeUnstaged)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'staged edit\n')
    assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), 'unstaged edit\n')
    assert.equal(await readFile(path.join(dir, 'c.txt'), 'utf8'), 'undo me\n')
    assert.deepEqual(gitSync(dir, ['diff', '--cached', '--name-only']).trim().split('\n'), ['a.txt', 'c.txt'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('console records argv, exit code and output per repository, and polling adds nothing', async () => {
  const dir = await makeRepo()
  const other = await makeRepo()
  const { server, base: url } = await startServer(dir)
  const get = (pathname) => fetch(`${url}/api${pathname}`)
  const post = (pathname, body) => fetch(`${url}/api${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // The console is scoped by the root the host resolved, so the check has to
  // use that spelling as well: the fixture path may be the 8.3 short name
  // while every entry the host kept carries the long one.
  let root = ''
  const inRepo = (entry) => {
    const relative = path.relative(root, entry.cwd)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }
  try {
    const opened = await (await get(`/status?dir=${encodeURIComponent(dir)}`)).json()
    root = opened.repo.root
    const first = await (await get(`/console?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(first.limit, 200)
    const status = first.entries.find((entry) => entry.args[0] === 'status')
    assert.ok(status, 'the status call must be visible')
    assert.equal(status.code, 0)
    assert.ok(status.ms >= 0)
    assert.ok(!Number.isNaN(Date.parse(status.at)))
    // The console shows the user-level argv; the enforced invariants stay hidden.
    assert.ok(!status.args.includes('--no-pager'))
    assert.ok(first.entries.every(inRepo), 'another repository must not leak in')

    // A refused command keeps its stderr and exit code for diagnosis.
    assert.equal((await post('/tag', { dir, name: 'v1.0.0' })).status, 200)
    assert.equal((await post('/tag', { dir, name: 'v1.0.0' })).status, 500)
    const afterFailure = await (await get(`/console?dir=${encodeURIComponent(dir)}`)).json()
    const failed = afterFailure.entries.find((entry) => entry.args[0] === 'tag' && entry.code !== 0)
    assert.ok(failed, 'a failed tag must be recorded')
    assert.match(failed.stderr, /already exists/)
    // Newest first, so the panel can render top-down without sorting.
    assert.ok(afterFailure.entries[0].id > afterFailure.entries.at(-1).id)

    // Reading the console resolves the repo from cache: polling cannot grow it.
    const polled = await (await get(`/console?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(polled.entries.length, afterFailure.entries.length)

    const otherStatus = await (await get(`/status?dir=${encodeURIComponent(other)}`)).json()
    const otherRoot = otherStatus.repo.root
    const scoped = await (await get(`/console?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(scoped.entries.length, afterFailure.entries.length, 'other repo status must not appear here')
    const otherView = await (await get(`/console?dir=${encodeURIComponent(other)}`)).json()
    assert.ok(otherView.entries.length > 0)
    assert.ok(otherView.entries.every((entry) => path.resolve(entry.cwd).toLowerCase().startsWith(path.resolve(otherRoot).toLowerCase())))

    // Clearing is per repository: this repo goes empty, the other keeps its log.
    const cleared = await post('/console/clear', { dir })
    assert.equal(cleared.status, 200)
    assert.ok((await cleared.json()).removed > 0)
    const empty = await (await get(`/console?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(empty.entries.length, 0)
    const untouched = await (await get(`/console?dir=${encodeURIComponent(other)}`)).json()
    assert.equal(untouched.entries.length, otherView.entries.length)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('pre-commit checks discover package scripts and run only the named ones', async () => {
  const dir = await makeRepo()
  const { server, base: url } = await startServer(dir)
  const q = encodeURIComponent
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'checks-fixture',
      private: true,
      scripts: {
        lint: 'node -e "console.log(\'lint clean\')"',
        test: 'node -e "console.error(\'2 tests failed\'); process.exit(3)"',
        start: 'node -e "setTimeout(() => {}, 60000)"',
        'test:unit': 'node -e "process.exit(0)"',
      },
    }))

    const discovery = await (await fetch(`${url}/api/checks?dir=${q(dir)}`)).json()
    assert.equal(discovery.reason, 'ok')
    assert.equal(discovery.manager, 'npm')
    assert.deepEqual(discovery.scripts.map((item) => item.name), ['lint', 'test', 'test:unit'])
    assert.equal(discovery.scripts[0].command, 'node -e "console.log(\'lint clean\')"')

    const lint = await (await fetch(`${url}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, script: 'lint' }),
    })).json()
    assert.equal(lint.ok, true)
    assert.equal(lint.code, 0)
    assert.match(lint.output, /lint clean/)
    assert.equal(lint.command, 'npm run lint')

    const failing = await (await fetch(`${url}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, script: 'test' }),
    })).json()
    assert.equal(failing.ok, false)
    assert.equal(failing.code, 3)
    assert.match(failing.output, /2 tests failed/)

    // A script that was filtered out (or never existed) is refused by name.
    const unknown = await fetch(`${url}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, script: 'start' }),
    })
    assert.equal(unknown.status, 500)
    assert.match((await unknown.json()).error, /unknown check script/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('pre-commit checks stay off in read-only mode and vanish without package.json', async () => {
  const dir = await makeRepo()
  const plain = await startServer(dir)
  try {
    const discovery = await (await fetch(`${plain.base}/api/checks?dir=${encodeURIComponent(dir)}`)).json()
    assert.deepEqual(discovery.scripts, [])
    assert.equal(discovery.reason, 'no-package')
  } finally {
    await new Promise((resolve) => plain.server.close(resolve))
  }

  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'checks-readonly',
    scripts: { lint: 'node -e "process.exit(0)"' },
  }))
  const locked = await startServer(dir, { readOnly: true })
  try {
    const refused = await fetch(`${locked.base}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, script: 'lint' }),
    })
    assert.equal(refused.status, 403)
  } finally {
    await new Promise((resolve) => locked.server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('ignoreWhitespace hides whitespace-only changes in file, commit and stash diffs', async () => {
  const dir = await makeRepo()
  const { server, base: url } = await startServer(dir)
  const q = encodeURIComponent
  const get = (pathname) => fetch(`${url}/api${pathname}`)
  try {
    // Working tree side: indentation only.
    await writeFile(path.join(dir, 'a.txt'), 'one\n  two\nthree\n')
    const normal = await (await get(`/file?dir=${q(dir)}&file=a.txt`)).json()
    assert.equal(normal.unstaged.hunks.length, 1)
    const ignored = await (await get(`/file?dir=${q(dir)}&file=a.txt&ignoreWhitespace=1`)).json()
    assert.equal(ignored.unstaged, null, 'a whitespace-only edit must vanish')
    assert.equal(ignored.entry.kind, 'modified')
    const plainDiff = await (await get(`/diff?dir=${q(dir)}&ignoreWhitespace=1`)).json()
    assert.equal(plainDiff.files.length, 0)

    // Staged and worktree sides are filtered independently.
    gitSync(dir, ['add', 'a.txt'])
    await writeFile(path.join(dir, 'a.txt'), 'one\n    two\nthree\n')
    const both = await (await get(`/file?dir=${q(dir)}&file=a.txt&ignoreWhitespace=1`)).json()
    assert.equal(both.staged, null)
    assert.equal(both.unstaged, null)

    // A commit that only changes whitespace: its file list and its file diff
    // both empty out.
    gitSync(dir, ['commit', '-q', '-m', 'ws'])
    const sha = gitSync(dir, ['rev-parse', 'HEAD']).trim()
    const commitNormal = await (await get(`/commit?dir=${q(dir)}&sha=${sha}`)).json()
    assert.equal(commitNormal.files.length, 1)
    const commitIgnored = await (await get(`/commit?dir=${q(dir)}&sha=${sha}&ignoreWhitespace=1`)).json()
    assert.equal(commitIgnored.files.length, 0)
    const commitFileNormal = await (await get(`/commit-file?dir=${q(dir)}&sha=${sha}&file=a.txt`)).json()
    assert.ok(commitFileNormal.unstaged.hunks.length > 0)
    const commitFileIgnored = await (await get(`/commit-file?dir=${q(dir)}&sha=${sha}&file=a.txt&ignoreWhitespace=1`)).json()
    assert.equal(commitFileIgnored.unstaged, null)

    // Stash previews share the switch, including the per-file endpoint.
    await writeFile(path.join(dir, 'a.txt'), 'one\n      two\nthree\n')
    gitSync(dir, ['stash', 'push', '-q', '-m', 'ws-only'])
    const ref = gitSync(dir, ['stash', 'list', '--format=%gd']).trim()
    const stashNormal = await (await get(`/stash-show?dir=${q(dir)}&ref=${q(ref)}`)).json()
    assert.equal(stashNormal.files.length, 1)
    const stashIgnored = await (await get(`/stash-show?dir=${q(dir)}&ref=${q(ref)}&ignoreWhitespace=1`)).json()
    assert.equal(stashIgnored.files.length, 0)
    const stashFileIgnored = await (await get(`/stash-file?dir=${q(dir)}&ref=${q(ref)}&file=a.txt&ignoreWhitespace=1`)).json()
    assert.equal(stashFileIgnored.unstaged, null)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('remotes can be listed, added, edited and removed, and a first push targets them', async () => {
  const dir = await makeRepo()
  const bare = await makeTempDir('dsh-git-remote-')
  gitSync(bare, ['init', '-q', '--bare'])
  const { server, base } = await startServer(dir)
  const post = async (route, body) => {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, ...body }),
    })
    return { status: response.status, payload: await response.json() }
  }
  try {
    // A fresh repository has no remotes, and says so with an empty list.
    const empty = await (await fetch(`${base}/api/remotes?dir=${encodeURIComponent(dir)}`)).json()
    assert.deepEqual(empty.remotes, [])

    // Add one: it shows up with the url it was given.
    const added = await post('/remote-add', { name: 'mirror', url: bare })
    assert.equal(added.status, 200)
    const listed = await (await fetch(`${base}/api/remotes?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(listed.remotes.length, 1)
    assert.equal(listed.remotes[0].name, 'mirror')
    assert.equal(listed.remotes[0].url, bare)

    // A duplicate name is git's refusal, reported as an error.
    const duplicate = await post('/remote-add', { name: 'mirror', url: bare })
    assert.equal(duplicate.status, 500)
    assert.match(duplicate.payload.error, /already exists/i)

    // Edit the url in place.
    const edited = await post('/remote-url', { name: 'mirror', url: `${bare}-edited` })
    assert.equal(edited.status, 200)
    const afterEdit = await (await fetch(`${base}/api/remotes?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(afterEdit.remotes[0].url, `${bare}-edited`)
    await post('/remote-url', { name: 'mirror', url: bare })

    // Names and urls are argv entries: option injection is refused.
    const evilName = await post('/remote-add', { name: '--upload-pack=touch /tmp/pwn', url: bare })
    assert.equal(evilName.status, 500)
    assert.match(evilName.payload.error, /invalid remote name/i)
    const evilUrl = await post('/remote-add', { name: 'evil', url: '--upload-pack=touch /tmp/pwn' })
    assert.equal(evilUrl.status, 500)
    assert.match(evilUrl.payload.error, /invalid remote url/i)
    const stillOne = await (await fetch(`${base}/api/remotes?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(stillOne.remotes.length, 1)

    // A first push has no upstream: it must use the remote that is there
    // instead of assuming `origin` exists.
    const pushed = await post('/push', {})
    assert.equal(pushed.status, 200, JSON.stringify(pushed.payload))
    assert.equal(gitSync(dir, ['rev-parse', '--abbrev-ref', 'mirror/main']).trim(), 'mirror/main')
    assert.equal(gitSync(bare, ['rev-parse', 'main']).trim(), gitSync(dir, ['rev-parse', 'HEAD']).trim())

    // With an upstream in place the push goes there.
    const again = await post('/push', {})
    assert.equal(again.status, 200, JSON.stringify(again.payload))

    // Remove it again.
    const removed = await post('/remote-remove', { name: 'mirror' })
    assert.equal(removed.status, 200)
    const afterRemove = await (await fetch(`${base}/api/remotes?dir=${encodeURIComponent(dir)}`)).json()
    assert.deepEqual(afterRemove.remotes, [])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
    await rm(bare, { recursive: true, force: true })
  }
})

test('remotes stay read-only when the workbench is read-only', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir, { readOnly: true })
  try {
    const response = await fetch(`${base}/api/remote-add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, name: 'origin', url: 'https://example.com/o/r.git' }),
    })
    assert.equal(response.status, 403)
    const listed = await (await fetch(`${base}/api/remotes?dir=${encodeURIComponent(dir)}`)).json()
    assert.deepEqual(listed.remotes, [])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a branch can be pointed at a remote branch and released again', async () => {
  const dir = await makeRepo()
  const bare = await makeTempDir('dsh-git-upstream-')
  gitSync(bare, ['init', '-q', '--bare'])
  const { server, base } = await startServer(dir)
  const post = async (route, body) => {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, ...body }),
    })
    return { status: response.status, payload: await response.json() }
  }
  try {
    gitSync(dir, ['remote', 'add', 'mirror', bare])
    gitSync(dir, ['push', '-q', 'mirror', 'main'])
    gitSync(dir, ['branch', 'feature'])

    // A branch without an upstream: the branch list says so.
    const before = await (await fetch(`${base}/api/branches?dir=${encodeURIComponent(dir)}`)).json()
    const feature = before.local.find((entry) => entry.name === 'feature')
    assert.equal(feature.upstream, null)

    // Point it at the remote branch.
    const set = await post('/set-upstream', { branch: 'feature', upstream: 'mirror/main' })
    assert.equal(set.status, 200, JSON.stringify(set.payload))
    assert.equal(gitSync(dir, ['rev-parse', '--abbrev-ref', 'feature@{upstream}']).trim(), 'mirror/main')
    const after = await (await fetch(`${base}/api/branches?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(after.local.find((entry) => entry.name === 'feature').upstream, 'mirror/main')

    // Both refs have to exist: a tracking config pointing at nothing breaks
    // every later pull.
    const unknownRemote = await post('/set-upstream', { branch: 'feature', upstream: 'mirror/nope' })
    assert.equal(unknownRemote.status, 500)
    assert.match(unknownRemote.payload.error, /no such remote branch/i)
    const unknownLocal = await post('/set-upstream', { branch: 'nope', upstream: 'mirror/main' })
    assert.equal(unknownLocal.status, 500)
    assert.match(unknownLocal.payload.error, /no such local branch/i)

    // The upstream is an argv entry: option injection is refused.
    const evil = await post('/set-upstream', { branch: 'feature', upstream: '--upload-pack=touch /tmp/pwn' })
    assert.equal(evil.status, 500)
    assert.match(evil.payload.error, /invalid upstream branch/i)
    assert.equal(gitSync(dir, ['rev-parse', '--abbrev-ref', 'feature@{upstream}']).trim(), 'mirror/main')

    // Release it again: the branch and its commits stay.
    const unset = await post('/unset-upstream', { branch: 'feature' })
    assert.equal(unset.status, 200, JSON.stringify(unset.payload))
    assert.equal(gitMaybe(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', 'feature@{upstream}']), '')
    const released = await (await fetch(`${base}/api/branches?dir=${encodeURIComponent(dir)}`)).json()
    assert.equal(released.local.find((entry) => entry.name === 'feature').upstream, null)

    // Releasing a branch that has no upstream says so instead of failing silently.
    const twice = await post('/unset-upstream', { branch: 'feature' })
    assert.equal(twice.status, 500)
    assert.match(twice.payload.error, /has no upstream/i)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
    await rm(bare, { recursive: true, force: true })
  }
})

test('the upstream of a branch cannot be changed when the workbench is read-only', async () => {
  const dir = await makeRepo()
  const { server, base } = await startServer(dir, { readOnly: true })
  try {
    const response = await fetch(`${base}/api/set-upstream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, branch: 'main', upstream: 'origin/main' }),
    })
    assert.equal(response.status, 403)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
