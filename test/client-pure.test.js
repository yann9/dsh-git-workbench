/**
 * Client chunk tests.
 *
 * The client half is split into native DSH module chunks (client.*.js next to
 * browser.js). These tests load every chunk through a stub module loader —
 * the same registration/materialisation contract the host implements — which
 * both exercises the chunk wiring (missing imports blow up here) and gives
 * access to the pure helpers each chunk exports.
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(HERE, '../src/client')
const OWNER = '@yann9/dsh-git-workbench'

/** Materialisation order: each chunk may require any earlier one. */
const ORDER = ['i18n', 'styles', 'core', 'ui', 'shell', 'panes', 'diff']

/** Execute every registration script (entry + chunks); nothing materialises. */
async function loadRegistry(language = 'zh-CN') {
  /** @type {Map<string, { factory: Function }>} */
  const registered = new Map()

  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Component: class Component {},
    Fragment: 'fragment',
    lazy: (fn) => ({ lazy: fn }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }

  const storage = new Map()
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { language },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    document: {
      head: { appendChild() {} },
      body: { appendChild() {} },
      createElement: () => ({
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {},
        append() {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        remove() {},
        focus() {},
      }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  }
  sandbox.window = {
    __ModuleLoader__: {
      load(registration) {
        const id = registration.chunk === undefined ? registration.id : `${registration.id}/${registration.chunk}`
        registered.set(id, registration)
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1440,
    innerHeight: 900,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  const files = (await readdir(CLIENT_DIR)).filter((f) => f === 'browser.js' || /^client\..+\.js$/.test(f))
  assert.ok(files.length >= 8, `expected the entry plus chunks, found ${files.join(', ')}`)
  for (const file of files.sort()) {
    const source = await readFile(path.join(CLIENT_DIR, file), 'utf8')
    vm.runInContext(source, sandbox, { filename: file })
  }
  return { registered, ReactStub, sandboxModules: sandbox }
}

/** The materialisation contract: sync require of arrived modules, async for chunks. */
function makeMaterializer(registered, ReactStub) {
  /** @type {Map<string, any>} */
  const loadCache = new Map()
  const materialize = (id) => {
    if (loadCache.has(id)) return loadCache.get(id)
    const registration = registered.get(id)
    if (!registration) throw new Error(`not registered: ${id}`)
    const require_ = (spec) => {
      if (spec === 'react') return ReactStub
      const normalized = spec.endsWith('/client') ? spec.slice(0, -7) : spec
      if (!loadCache.has(normalized) && !registered.has(normalized)) {
        throw new Error(`require("${spec}") missed the module table`)
      }
      return materialize(normalized)
    }
    require_.async = async (spec) => {
      const fileName = spec.startsWith('./') ? spec.slice(2) : spec
      return materialize(`${OWNER}/${fileName}`)
    }
    const exports = registration.factory(require_)
    loadCache.set(id, exports)
    return exports
  }
  return materialize
}

async function loadClient(language = 'zh-CN') {
  const { registered, ReactStub } = await loadRegistry(language)
  const materialize = makeMaterializer(registered, ReactStub)

  const modules = {}
  for (const name of ORDER) modules[name] = materialize(`${OWNER}/client.${name}.js`)
  modules.entry = materialize(OWNER)
  return modules
}

test('every chunk registers and materialises against the module contract', async () => {
  const modules = await loadClient()
  for (const name of ORDER) {
    assert.equal(typeof modules[name], 'object', `client.${name}.js must export an object`)
    assert.ok(Object.keys(modules[name]).length > 0, `client.${name}.js exports nothing`)
  }
  assert.equal(typeof modules.entry.apply, 'function')
  assert.equal(modules.entry.name, 'git-workbench-client')
  // the kit carries cross-chunk services and the shared ctx slot
  assert.equal(typeof modules.core.openDiff, 'function')
  assert.equal(typeof modules.core.Api.status, 'function')
  assert.equal('ctx' in modules.core, true)
})

test('tt falls back through zh/en and substitutes parameters', async () => {
  const zh = (await loadClient('zh-CN')).i18n
  assert.equal(zh.tt('tab.commit'), '提交')
  assert.equal(zh.tt('commit.staged', { count: 3 }), '3 个文件已暂存')

  const en = (await loadClient('en-US')).i18n
  assert.equal(en.tt('tab.commit'), 'Commit')
  assert.equal(en.tt('log.count', { count: 1 }), '1 commits')

  // an unknown key is shown as-is, never blank
  assert.equal(zh.tt('nope.missing'), 'nope.missing')
})

// tt falls back to Chinese for a key missing from `en`, which would silently
// put Chinese into the English UI — the two tables must stay key-identical.
test('the zh and en dictionaries carry the same keys', async () => {
  const { i18n } = await loadClient('zh-CN')
  const zh = Object.keys(i18n.STRINGS.zh).sort()
  const en = Object.keys(i18n.STRINGS.en).sort()
  assert.deepEqual(en, zh)
})

test('attachLocale follows the DSH preference and live language switches', async () => {
  const { i18n } = await loadClient('zh-CN')
  assert.equal(i18n.tt('tab.commit'), '提交')

  let active = 'en'
  const listeners = new Set()
  const registered = []
  const service = {
    getSnapshot: () => ({ active }),
    register: (ns, locale, dict) => {
      registered.push([ns, locale, dict])
      return () => {}
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }

  const detach = i18n.attachLocale(service)
  assert.deepEqual(registered.map(([ns, locale]) => [ns, locale]), [['gitWorkbench', 'zh'], ['gitWorkbench', 'en']])
  assert.equal(registered[0][2], i18n.STRINGS.zh)
  assert.equal(i18n.tt('tab.commit'), 'Commit')

  active = 'zh'
  for (const fn of listeners) fn()
  assert.equal(i18n.tt('tab.commit'), '提交')

  // Without a service the browser language takes over again.
  detach()
  assert.equal(i18n.tt('tab.commit'), '提交')
})

test('buildTree collapses single-chain folders the way the IDE does', async () => {
  const { core } = await loadClient()
  const tree = core.buildTree([
    { path: 'src/main/java/App.java' },
    { path: 'src/main/java/Util.java' },
    { path: 'README.md' },
  ])
  assert.equal(tree.files.length, 1)
  assert.equal(tree.files[0].path, 'README.md')
  // src → main → java has no files until the leaf: one merged folder entry
  assert.deepEqual(Array.from(tree.dirs.keys()), ['src/main/java'])
  const merged = tree.dirs.get('src/main/java')
  assert.equal(merged.files.length, 2)
  assert.equal(core.countFiles(tree), 3)
  // Array.from: the helpers run in the stub realm, whose arrays have another
  // prototype than this test's
  assert.deepEqual(Array.from(core.collectPaths(tree)).sort(), ['README.md', 'src/main/java/App.java', 'src/main/java/Util.java'])
})

// The status hue is applied inline, so it must be an ink token (mixed toward
// --gwb-text) rather than the raw host hue: #22c55e on a white panel is 2.3:1.
test('statusColor follows the IDE convention', async () => {
  const { core } = await loadClient()
  assert.match(core.statusColor('added'), /success-ink/)
  assert.match(core.statusColor('deleted'), /del-ink/)
  assert.match(core.statusColor('untracked'), /warn-ink/)
  assert.match(core.statusColor('conflicted'), /error-ink/)
  assert.match(core.statusColor('modified'), /accent-ink/)
  for (const kind of ['added', 'deleted', 'untracked', 'conflicted', 'modified']) {
    assert.doesNotMatch(core.statusColor(kind), /#[0-9a-fA-F]{3,8}/)
  }
})

test('computeGraph keeps children above parents in one lane', async () => {
  const { panes } = await loadClient()
  const rows = panes.computeGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  assert.equal(rows.length, 3)
  assert.ok(rows.every((row) => row.lane === 0))
  assert.equal(rows[0].after[0], 'b')
  assert.equal(rows[2].after.length, 0)
})

test('the log search reads structured conditions and keeps the rest as free text', async () => {
  const { panes } = await loadClient()
  const parsed = panes.parseLogQuery('author:ada message:fix')
  assert.deepEqual(
    Array.from(parsed.terms).map((term) => term.key),
    ['author', 'message'],
  )
  assert.equal(parsed.terms[0].value, 'ada')
  assert.equal(parsed.free.length, 0)

  // A quoted value keeps its spaces in one piece.
  const quoted = panes.parseLogQuery('author:"Ada Lovelace"')
  assert.equal(quoted.terms[0].value, 'Ada Lovelace')

  // An unknown key is free text: a commit may well read "fix: crash".
  const unknown = panes.parseLogQuery('fix: crash')
  assert.equal(unknown.terms.length, 0)
  assert.equal(unknown.free.length, 1)
  assert.equal(unknown.free[0].value, 'fix: crash')

  // Words and conditions live side by side; the words stay a substring search.
  const mixed = panes.parseLogQuery('wording author:ada')
  assert.equal(mixed.terms.length, 1)
  assert.equal(mixed.free.length, 1)
  assert.equal(mixed.free[0].value, 'wording')

  // Words separated by a condition are two searches, not one glued string.
  const split = panes.parseLogQuery('wording author:ada more')
  assert.equal(split.free.length, 2)
  assert.deepEqual(
    Array.from(split.free).map((part) => part.value),
    ['wording', 'more'],
  )
})

test('the log conditions match the way the IDE filters', async () => {
  const { panes } = await loadClient()
  const entry = {
    hash: '9f2c1ab',
    subject: 'feat(notes): paginate the list endpoint',
    author: 'Ada Lovelace',
    email: 'ada@example.com',
    date: '2026-10-14T09:30:00+08:00',
    refs: ['HEAD -> feature/diff-review', 'feature/diff-review', 'tag: v0.2.0'],
  }
  const hit = (query) => panes.matchLogQuery(entry, panes.parseLogQuery(query))

  assert.equal(hit('author:ada'), true)
  assert.equal(hit('author:ada@example.com'), true)
  assert.equal(hit('author:lovelace'), true)
  assert.equal(hit('author:grace'), false)
  assert.equal(hit('message:paginate'), true)
  assert.equal(hit('message:retire'), false)
  assert.equal(hit('hash:9f2c'), true)
  assert.equal(hit('hash:1ab'), false)
  assert.equal(hit('tag:v0.2.0'), true)
  assert.equal(hit('tag:v9.9.9'), false)
  assert.equal(hit('branch:diff-review'), true)
  assert.equal(hit('branch:diff-review'), true)
  assert.equal(hit('branch:main'), false)
  // a tag is not a branch
  assert.equal(hit('branch:v0.2.0'), false)

  // dates: a day, a month and the edges of both
  assert.equal(hit('date:2026-10-14'), true)
  assert.equal(hit('date:2026-10-15'), false)
  assert.equal(hit('date:2026-10'), true)
  assert.equal(hit('date:2026-09'), false)
  assert.equal(hit('date:>=2026-10-14'), true)
  assert.equal(hit('date:>2026-10-14'), false)
  assert.equal(hit('date:<=2026-10-14'), true)
  assert.equal(hit('date:<2026-10-14'), false)

  // conditions combine with AND
  assert.equal(hit('author:ada message:paginate'), true)
  assert.equal(hit('author:ada message:retire'), false)

  // free text still searches the subject, the author and the hash
  assert.equal(hit('paginate'), true)
  assert.equal(hit('nothing here'), false)
})

test('the log groups commits the way the IDE groups them', async () => {
  const { panes } = await loadClient()
  const list = [
    {
      hash: 'aaa111',
      subject: 'feat(notes): paginate the list endpoint',
      author: 'Ada Lovelace',
      email: 'ada@example.com',
      date: '2026-10-14T09:30:00+08:00',
      refs: ['HEAD -> feature/diff-review', 'feature/diff-review'],
    },
    {
      hash: 'bbb222',
      subject: 'fix(app): seed loading follows the retry policy',
      author: 'Grace Hopper',
      email: 'grace@example.com',
      date: '2026-10-14T11:00:00+08:00',
      refs: ['feature/retry-policy'],
    },
    {
      hash: 'ccc333',
      subject: 'docs: our wording for the demo rules',
      author: 'Ada Lovelace',
      email: 'ada@example.com',
      date: '2026-10-12T08:00:00+08:00',
      refs: ['feature/diff-review'],
    },
  ]

  // no grouping: one flat bucket that keeps every commit
  const flat = panes.groupLogEntries(list, 'none')
  assert.equal(flat.length, 1)
  assert.equal(flat[0].entries.length, 3)

  // by branch: the branch a commit points at, the tag is not a branch
  const byBranch = panes.groupLogEntries(list, 'branch')
  assert.deepEqual(Array.from(byBranch, (group) => group.key), ['feature/diff-review', 'feature/retry-policy'])
  assert.equal(byBranch[0].entries.length, 2)
  assert.equal(byBranch[1].entries.length, 1)

  // by author: one bucket per person
  const byAuthor = panes.groupLogEntries(list, 'author')
  assert.deepEqual(Array.from(byAuthor, (group) => group.label), ['Ada Lovelace', 'Grace Hopper'])
  assert.equal(byAuthor[0].entries.length, 2)

  // two people with one name are told apart by the mail address
  const sameName = panes.groupLogEntries(
    [
      { hash: 'd1', author: 'Robin', email: 'robin@a.test', date: '2026-10-14', refs: [] },
      { hash: 'd2', author: 'Robin', email: 'robin@b.test', date: '2026-10-14', refs: [] },
    ],
    'author',
  )
  assert.equal(sameName.length, 2)
  assert.equal(sameName[0].label, 'Robin <robin@a.test>')

  // by day: the day a commit was authored
  const byDate = panes.groupLogEntries(list, 'date')
  assert.deepEqual(Array.from(byDate, (group) => group.key), ['2026-10-14', '2026-10-12'])
  assert.equal(byDate[0].entries.length, 2)

  // a commit without a ref still belongs somewhere
  const orphan = panes.groupLogEntries([{ hash: 'e1', author: 'Ada', email: 'a@b.test', date: '2026-10-14', refs: [] }], 'branch')
  assert.equal(orphan.length, 1)
  assert.equal(orphan[0].key, '')

  assert.equal(panes.logDayKey('2026-10-04T09:30:00+08:00'), '2026-10-04')
  assert.equal(panes.logDayKey('not a date'), '')
  assert.equal(panes.localDayKey(new Date(2026, 9, 4)), '2026-10-04')
})

test('the log sorts by a column the way the IDE table does', async () => {
  const { panes } = await loadClient()
  const list = [
    { hash: 'aaa111', subject: 'feat(notes): paginate the list endpoint', author: 'Grace Hopper', email: 'grace@example.com', date: '2026-10-14T09:30:00+08:00' },
    { hash: 'bbb222', subject: 'docs: our wording for the demo rules', author: 'Ada Lovelace', email: 'ada@example.com', date: '2026-10-12T08:00:00+08:00' },
    { hash: 'ccc333', subject: 'fix(app): seed loading follows the retry policy', author: 'Ada Lovelace', email: 'ada@example.com', date: '2026-10-16T11:00:00+08:00' },
  ]

  // The history order is the one the log already has: newest first.
  assert.equal(panes.logGraphVisible({ key: 'date', dir: 'desc' }), true)
  assert.equal(panes.sortLogEntries(list, { key: 'date', dir: 'desc' })[0].hash, 'ccc333')

  // A column sorts ascending first, then flips.
  const bySubject = panes.sortLogEntries(list, { key: 'subject', dir: 'asc' })
  assert.deepEqual(Array.from(bySubject, (entry) => entry.hash), ['bbb222', 'aaa111', 'ccc333'])
  const flipped = panes.sortLogEntries(list, { key: 'subject', dir: 'desc' })
  assert.deepEqual(Array.from(flipped, (entry) => entry.hash), ['ccc333', 'aaa111', 'bbb222'])

  // Authors sort by name, not by the order they happen to appear in. Two
  // commits by one author keep the order they came in with.
  const byAuthor = panes.sortLogEntries(list, { key: 'author', dir: 'asc' })
  assert.deepEqual(Array.from(byAuthor, (entry) => entry.hash), ['bbb222', 'ccc333', 'aaa111'])

  // Two time zones must not order the dates by their text: 09:00+08:00 is
  // earlier than 02:00+00:00, even though its text sorts later.
  const zones = [
    { hash: 'z1', subject: 'a', author: 'A', email: 'a@a.test', date: '2026-10-14T09:00:00+08:00' },
    { hash: 'z2', subject: 'b', author: 'B', email: 'b@b.test', date: '2026-10-14T02:00:00+00:00' },
  ]
  const byDate = panes.sortLogEntries(zones, { key: 'date', dir: 'asc' })
  assert.deepEqual(Array.from(byDate, (entry) => entry.hash), ['z1', 'z2'])

  // A column that is not the history order has no graph to draw.
  assert.equal(panes.logGraphVisible({ key: 'subject', dir: 'asc' }), false)
  assert.equal(panes.logGraphVisible({ key: 'date', dir: 'asc' }), false)
  assert.equal(panes.logSortValue(list[0], 'subject'), 'feat(notes): paginate the list endpoint')
  assert.equal(typeof panes.logSortValue(list[0], 'date'), 'number')
})

test('the branch labels of a row fit the room the row has', async () => {
  const { panes } = await loadClient()
  const chip = (count) => 22 + count * 6

  // A roomy row spells every label out — three at most, the rest fold away.
  const roomy = panes.fitLogRefs([60, 90, 70, 60, 60], 400, chip)
  assert.equal(roomy.shown, 3)
  assert.equal(roomy.cut, 0)

  // A narrow row keeps the labels that fit in full and folds the rest into
  // the chip: the room has to hold the labels and the chip that names the
  // ones that are hidden.
  const narrow = panes.fitLogRefs([60, 90, 70], 120, chip)
  assert.equal(narrow.shown, 1)

  // The label that names the branch is never dropped: when even one label
  // does not fit it is cut short instead, and the row says how much of it
  // is left.
  const cut = panes.fitLogRefs([300], 200, chip)
  assert.equal(cut.shown, 1)
  assert.ok(cut.cut > 0 && cut.cut < 300)

  // A row with no room at all keeps only the chip: a label that is cut to
  // nothing is the fragment this is meant to avoid.
  const none = panes.fitLogRefs([300], 30, chip)
  assert.equal(none.shown, 0)
  assert.equal(none.cut, 0)
})

test('localizeError maps the server contracts back to the UI language', async () => {
  const zh = (await loadClient('zh-CN')).i18n
  assert.match(zh.localizeError(new Error('refusing to delete the default branch main')), /默认分支/)
  assert.match(zh.localizeError(new Error('nothing staged: stage the changes first')), /暂存区为空/)
  assert.match(zh.localizeError(new Error('the branch is not fully merged')), /未合并/)
  // unknown errors are never swallowed
  assert.equal(zh.localizeError(new Error('weird upstream failure')), 'weird upstream failure')

  const en = (await loadClient('en-US')).i18n
  assert.match(en.localizeError(new Error('refusing to delete the default branch main')), /cannot be deleted/)
})

test("git's own refusals answer in the UI language", async () => {
  const zh = (await loadClient('zh-CN')).i18n
  const answers = {
    // a branch that was never pushed, asked to pull
    'There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.': /上游/,
    "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository, or the lock file may be stale": /锁/,
    "fatal: 'C:/somewhere/not-a-repo.git' does not appear to be a git repository": /远程仓库/,
    "fatal: unable to access 'https://x.invalid/y.git/': Could not resolve host: x.invalid": /远程仓库/,
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled": /登录/,
    'Committer identity unknown\n\n*** Please tell me who you are.': /作者信息/,
    'error: cannot pull with rebase: You have unstaged changes.': /未提交/,
    // the states a work tree gets into without anyone meaning to
    'You are not currently on a branch.\nPlease specify which branch you want to merge with.': /分离 HEAD/,
    'error: The destination you provided is not a full refname (i.e., starting with "refs/").': /分离 HEAD/,
    "Your configuration specifies to merge with the ref 'refs/heads/feature'\nfrom the remote, but no such ref was fetched.": /上游/,
    "error: cannot delete branch 'wt' used by worktree at 'C:/repo/worktree'": /工作区/,
    "fatal: 'bad name' is not a valid tag name.": /标签名/,
    "fatal: 'b.lock' is not a valid branch name\nhint: See 'git help check-ref-format'": /分支名/,
    'fatal: invalid reference: gone': /找不到本地分支/,
    'merge: nosuch - not something we can merge': /找不到本地分支/,
    "fatal: Failed to resolve 'HEAD' as a valid ref.": /第一次提交/,
    'You do not have the initial commit yet': /第一次提交/,
    // what the host itself answers
    'nothing is in progress': /没有进行中/,
    'finish the merge with a commit': /提交/,
    'resolve the conflicts first': /冲突/,
    'invalid branch name: two words': /分支名/,
    'invalid tag name: 版本 .lock': /标签名/,
    'the branch is already called main': /已经叫/,
    'the rebase plan must include every commit exactly once': /重新发起/,
    'the first kept commit cannot be squashed': /第一条/,
    'a branch called main already exists': /已存在/,
    // the per-turn snapshot is the host's own record, and it can be gone
    'this turn is no longer available: summaries live only while the session lives in this host process': /快照/,
    'this harness build does not expose workspace changes (workspaceChanges service missing)': /本轮改动/,
    'missing session id': /坐标/,
    'missing or invalid event sequence': /坐标/,
  }
  for (const [raw, expected] of Object.entries(answers)) {
    const text = zh.localizeError(new Error(raw))
    assert.match(text, expected, `${raw.split('\n')[0]} must not stay in git's English: ${text}`)
  }
})

test('a delivery card sends Git to the working tree; a changes card to its turn', async () => {
  const { shell, core } = await loadClient()
  const opened = []
  core.ctx = {
    get: (id) => (id === 'sidebarRight' ? { openTab: (kind) => opened.push(kind) } : undefined),
    slots: { inject: () => () => {}, register: () => () => {} },
  }
  const click = (actionUrl) => shell.CardAction({ actionUrl }).props.onClick()

  // The host only answers a turn snapshot for a `workspace/changes` event, and
  // a delivery card carries the coordinates of its `deliverables/presented`
  // one — asking with that seq could only ever end in an error page.
  click('api/present.open?sessionId=s-1&seq=42&index=0')
  assert.deepEqual(opened, ['dsh-git-commit'])

  click('api/changes.open?sessionId=s-1&seq=42&index=1')
  // Field by field: the store's object was built inside the chunk's realm, so
  // it does not share this test's Object.prototype.
  const target = core.diffTargetStore.target
  assert.deepEqual(
    [target.source, target.session, target.seq, target.index],
    ['turn', 's-1', '42', '1'],
  )
})

test('walkFileTree renders flat or tree and honours folder collapse state', async () => {
  const { core } = await loadClient()
  const files = [{ path: 'a/1.txt' }, { path: 'a/2.txt' }, { path: 'b.txt' }]
  const fileEl = (file, depth) => ({ file: file.path, depth })
  const folderEl = ({ folder, open, depth }) => ({ folder: folder.path, open, depth })

  const flat = core.walkFileTree({ files, listMode: 'flat', folders: {}, fileEl, folderEl })
  assert.equal(flat.length, 3)
  assert.deepEqual(Array.from(flat), [
    { file: 'a/1.txt', depth: 0 },
    { file: 'a/2.txt', depth: 0 },
    { file: 'b.txt', depth: 0 },
  ])

  const tree = core.walkFileTree({ files, listMode: 'tree', folders: {}, fileEl, folderEl })
  assert.equal(tree.length, 4) // folder a + its 2 files + b.txt
  assert.deepEqual(Array.from(tree)[0], { folder: 'a', open: true, depth: 0 })

  const closed = core.walkFileTree({ files, listMode: 'tree', folders: { a: false }, fileEl, folderEl })
  assert.equal(closed.length, 2) // folder a (closed) + b.txt
})

test('the list-mode store syncs every pane and survives a reload', async () => {
  const { core } = await loadClient()
  const seen = []
  const unsubscribe = core.listModeStore.subscribe(() => seen.push(core.listModeStore.value))
  core.listModeStore.set('tree')
  core.listModeStore.set('tree') // idempotent: no second notification
  core.listModeStore.set('flat')
  unsubscribe()
  assert.deepEqual(Array.from(seen), ['tree', 'flat'])
  assert.equal(core.listModeStore.value, 'flat')
})

test('entry applies against the real arrival contract (async chunks, no pre-materialisation)', async () => {
  // Regression: chunk scripts only arrive via require.async — a synchronous
  // require from the entry factory ("missed the module table") blew up boot.
  // Materialise the entry FIRST, exactly like the host, and let apply await.
  const { registered, ReactStub } = await loadRegistry()
  const materialize = makeMaterializer(registered, ReactStub)
  const entry = materialize(OWNER)

  const slotCalls = []
  const ctx = {
    slots: {
      register: (options, component) => {
        slotCalls.push({ options, component })
        return () => {}
      },
      inject: (name, factory) => factory(),
    },
    effect: () => {},
    get: (id) => (id === 'sidebarRightTabs' ? { register: () => () => {} } : undefined),
  }
  await entry.apply(ctx)

  const names = slotCalls.map((call) => call.options.name)
  assert.ok(names.includes('sidebar.right.pane.tab'), `panes registered, got ${names.join(', ')}`)
  assert.ok(names.includes('conversation.session.header.actions'))
  // the branch picker is only on the new-session (hero) screen
  assert.ok(names.includes('conversation.hero.options'))
  assert.ok(names.includes('settings.plugins.tab'))
  // the detail page form lives in the bundle slot (above 包含的组件), keyed so
  // the host only renders it on this package's page
  const bundleConfig = slotCalls.find((call) => call.options.name === 'plugins.bundle.config')
  assert.ok(bundleConfig, `bundle config registered, got ${names.join(', ')}`)
  assert.equal(bundleConfig.options.key, '@yann9/dsh-git-workbench')
  assert.equal(names.includes('plugins.detail.section'), false, 'the form must not render twice')
  assert.ok(names.includes('deliverables.file.actions'))
  assert.ok(names.includes('sidebar.right.tab.files.actions'))
  // every registered component renders — the guarded wrappers must not throw
  for (const call of slotCalls) {
    assert.equal(typeof call.component, 'function', `${call.options.name} component must be a function`)
  }
})

test('better-sidebar is offered the panes in its own bar, and a refusal is swallowed', async () => {
  const { registered, ReactStub } = await loadRegistry()
  const materialize = makeMaterializer(registered, ReactStub)
  const entry = materialize(OWNER)

  const offered = []
  const makeCtx = (get) => ({
    slots: { register: () => () => {}, inject: () => () => {} },
    // Only the effect under test is run; the locale and style effects need a
    // fuller host context than this stub provides.
    effect: (fn, label) => {
      if (String(label ?? '').includes('better-sidebar')) fn()
    },
    get,
    // cordis refuses every service the bundle did not declare in `inject`, and
    // `sessions` is not ours to demand — reading it must never be the price of
    // an optional integration.
    get sessions() {
      throw new Error('cannot get property "sessions" without inject')
    },
  })
  const ctx = makeCtx((id) =>
    id === 'betterSidebar'
      ? {
          registerTab: (descriptor) => {
            offered.push(descriptor)
            return () => {}
          },
        }
      : undefined,
  )
  await entry.apply(ctx)

  // bottomOnly keeps them in that plugin's bar: without the flag it mints a
  // native right-sidebar type per registration and shadows our own ones.
  assert.deepEqual(
    offered.map((descriptor) => [descriptor.id, descriptor.bottomOnly, descriptor.single]),
    [
      ['git-workbench:commit', true, true],
      ['git-workbench:log', true, true],
      ['git-workbench:console', true, true],
    ],
  )
  assert.equal(offered[0].title(), '提交')
  // The bar hands a scope rather than the host slot's store hooks, so the pane
  // reads its directory straight out of that scope.
  const vnode = offered[0].component({ scope: { sessionId: 's-1', cwd: '/repo/a' } })
  assert.equal(vnode.props.sessionId, 's-1')
  assert.equal(vnode.props.useSessions((sessions) => sessions.byId['s-1'].cwd), '/repo/a')
  assert.equal(offered[0].component({ scope: undefined }).props.useSessions, undefined)

  const refused = []
  const hostile = makeCtx((id) => (id === 'betterSidebar' ? { registerTab: (descriptor) => { refused.push(descriptor.id); throw new Error('unknown field') } } : undefined))
  await entry.apply(hostile)
  assert.deepEqual(refused, ['git-workbench:commit', 'git-workbench:log', 'git-workbench:console'], 'one refusal must not stop the others')
})

test('highlightTokens colours keywords, strings, comments, numbers and annotations', async () => {
  const { diff } = await loadClient()
  const line = '@Autowired private String name = "x" + 42; // note'
  const tokens = diff.highlightTokens(line, 'clike')
  const of = (cls) => tokens.filter((token) => token.cls === cls).map((token) => token.text)
  assert.ok(of('ann').includes('@Autowired'))
  assert.ok(of('kw').includes('private'))
  assert.ok(of('str').includes('"x"'))
  assert.ok(of('num').includes('42'))
  assert.deepEqual(Array.from(of('com')), ['// note'])
  // the text is only ever split, never rewritten
  assert.equal(tokens.map((token) => token.text).join(''), line)

  // python comments and strings
  const py = diff.highlightTokens('def f(x):  # hi', 'python')
  assert.deepEqual(Array.from(py.filter((token) => token.cls === 'com').map((token) => token.text)), ['# hi'])
  assert.ok(py.some((token) => token.cls === 'kw' && token.text === 'def'))

  // a javadoc body line is a comment even without the opener
  assert.equal(diff.highlightTokens('     * paging moved', 'clike')[0].cls, 'com')
  // binary-ish/unknown content is left alone
  const plain = diff.highlightTokens('plain text', 'text')
  assert.equal(plain.length, 1)
  assert.equal(plain[0].text, 'plain text')
  assert.equal(plain[0].cls, undefined)
})

test('langOf maps the extensions a repo actually carries', async () => {
  const { diff } = await loadClient()
  assert.equal(diff.langOf('src/main/java/A.java'), 'clike')
  assert.equal(diff.langOf('web/app.tsx'), 'clike')
  assert.equal(diff.langOf('scripts/deploy.sh'), 'shell')
  assert.equal(diff.langOf('tools/check.py'), 'python')
  assert.equal(diff.langOf('db/schema.sql'), 'sql')
  assert.equal(diff.langOf('pom.xml'), 'clike')
  assert.equal(diff.langOf('README.md'), 'text')
  assert.equal(diff.langOf('config/app.yml'), 'yaml')
})

test('lineDiffSpans finds the changed middle of a replacement pair', async () => {
  const { diff } = await loadClient()
  const spans = diff.lineDiffSpans('  list(1, 10, args)', '  list(page, size, args)')
  assert.equal(spans.prefix, '  list('.length)
  assert.equal(spans.suffix, ', args)'.length)
  // identical lines have no changed middle
  const same = diff.lineDiffSpans('same', 'same')
  assert.equal(same.prefix, 4)
  assert.equal(same.suffix, 0)
})

test('wordDiffRanges reports every changed run, not just the middle one', async () => {
  const { diff } = await loadClient()
  // chunk objects live in a vm realm, so normalise before a strict compare
  const plain = (value) => JSON.parse(JSON.stringify(value))
  const left = '  return compute(page, size) * factor'
  const right = '  return compute(page, size) / factor'
  const single = plain(diff.wordDiffRanges(left, right))
  assert.deepEqual(single.left, [[left.indexOf('*'), left.indexOf('*') + 1]])
  assert.deepEqual(single.right, [[right.indexOf('/'), right.indexOf('/') + 1]])

  // two distant edits → two runs per side
  const two = plain(diff.wordDiffRanges('alpha one beta two gamma', 'alpha 1 beta 2 gamma'))
  assert.deepEqual(two.left, [[6, 9], [15, 18]])
  assert.deepEqual(two.right, [[6, 7], [13, 14]])

  assert.deepEqual(plain(diff.wordDiffRanges('same text here', 'same text here')), { left: [], right: [] })
})

test('unifiedMarks pairs each deletion with the addition that replaces it', async () => {
  const { diff } = await loadClient()
  const plain = (value) => JSON.parse(JSON.stringify(value))
  const items = [
    { line: { type: 'context', text: 'unchanged' }, index: 0 },
    { line: { type: 'del', text: 'const a = 1', oldLine: 2 }, index: 1 },
    { line: { type: 'add', text: 'const a = 2', newLine: 2 }, index: 2 },
  ]
  const marks = diff.unifiedMarks(items)
  assert.equal(marks.has(0), false)
  assert.deepEqual(plain(marks.get(1)), [[10, 11]])
  assert.deepEqual(plain(marks.get(2)), [[10, 11]])

  // an uneven run leaves the unpaired lines as plain additions/deletions
  const uneven = diff.unifiedMarks([
    { line: { type: 'del', text: 'aa', oldLine: 1 }, index: 0 },
    { line: { type: 'del', text: 'bb', oldLine: 2 }, index: 1 },
    { line: { type: 'add', text: 'cc', newLine: 1 }, index: 2 },
  ])
  assert.deepEqual(plain(uneven.get(0)), [[0, 2]])
  assert.equal(uneven.has(1), false)
})

test('unified rows wrap only the changed words and keep the line text intact', async () => {
  const { diff } = await loadClient()
  const items = [
    { line: { type: 'context', text: 'unchanged line', oldLine: 1, newLine: 1 }, index: 0 },
    { line: { type: 'del', text: 'const total = price * count', oldLine: 2 }, index: 1 },
    { line: { type: 'add', text: 'const total = price * quantity', newLine: 2 }, index: 2 },
  ]
  const rows = diff.unifiedRows(items, 0, { side: 'unstaged', selection: new Set(), readOnly: true, lang: 'clike', fileIndex: 0 })

  const walk = (node, visit) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit)
      return
    }
    if (!node || typeof node !== 'object') return
    visit(node)
    walk(node.children ?? [], visit)
  }
  const marked = (row) => {
    const words = []
    let text = ''
    walk(row.children, (node) => {
      const first = node.children?.[0]
      if (typeof first !== 'string') return
      text += first
      if (/gwb-word/.test(node.props.className ?? '')) words.push(first)
    })
    return { words, text }
  }
  assert.deepEqual(marked(rows[1]).words, ['count'])
  assert.deepEqual(marked(rows[2]).words, ['quantity'])
  assert.equal(marked(rows[1]).text, 'const total = price * count')
  assert.equal(marked(rows[2]).text, 'const total = price * quantity')
})

test('foldSegments collapses long unchanged runs and countChanges counts blocks', async () => {
  const { diff } = await loadClient()
  const lines = []
  for (let i = 1; i <= 12; i += 1) lines.push({ type: 'context', text: `ctx ${i}`, oldLine: i, newLine: i, id: `h0l${i}` })
  lines.push({ type: 'del', text: 'old', oldLine: 13, newLine: null, id: 'h0l12' })
  lines.push({ type: 'add', text: 'new', oldLine: null, newLine: 13, id: 'h0l13' })
  for (let i = 14; i <= 30; i += 1) lines.push({ type: 'context', text: `ctx ${i}`, oldLine: i, newLine: i, id: `h0l${i}` })

  const segments = diff.foldSegments(lines, 0, { side: 'unstaged' })
  assert.equal(segments[0].type, 'fold') // 12 unchanged lines collapse
  assert.equal(segments[0].count, 12)
  assert.equal(segments[1].type, 'lines') // the changed block
  assert.equal(segments[1].items.filter((item) => item.line.type !== 'context').length, 2)
  assert.equal(segments[2].type, 'fold')

  // expanding one run renders it line by line again
  const expanded = diff.foldSegments(lines, 0, { side: 'unstaged', expandedFolds: new Set(['unstaged:0:0']) })
  assert.equal(expanded[0].type, 'lines')
  assert.equal(expanded[0].items.length, 12)

  // short runs stay visible
  const short = diff.foldSegments(
    [
      { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'context', text: 'b', oldLine: 2, newLine: 2 },
      { type: 'add', text: 'c', oldLine: null, newLine: 3 },
    ],
    0,
    { side: 'unstaged' },
  )
  assert.equal(short[0].type, 'lines')
  assert.equal(short[0].items.length, 2) // context run stays visible
  assert.equal(short[1].items.length, 1) // the change is its own segment

  // one change block, no matter how many lines it spans
  assert.equal(diff.countChanges([{ lines }]), 1)
})

test('GraphSvg renders a row without missing globals', async () => {
  // Regression: LANE_COLORS was dropped by the chunk split and only blew up in
  // the browser, where the log pane crashed on the first commit row.
  const { panes } = await loadClient()
  const rows = panes.computeGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  const svg = panes.GraphSvg({ row: rows[0] })
  assert.equal(svg.type, 'svg')
  const shapes = (svg.children ?? []).flat(Infinity).filter(Boolean)
  assert.ok(shapes.length >= 2, 'a row draws at least a lane line and a dot')
  // every stroke/fill must be a colour string, never undefined
  for (const shape of shapes) {
    const props = shape.props ?? {}
    if (props.stroke !== undefined) assert.equal(typeof props.stroke, 'string')
    if (props.fill !== undefined) assert.equal(typeof props.fill, 'string')
  }
})

test('session branch names follow the default pattern', async () => {
  const { shell } = await loadClient()
  // default: session/{date}-{time} → session/20261021-1354
  assert.match(shell.sessionBranchName('demo'), /^session\/\d{8}-\d{4}$/)
  // the repo placeholder only resolves when a pattern asks for it
  assert.equal(shell.sessionBranchName('demo').includes('demo'), false)
})

test('the plugin settings section renders the page form under its own heading', async () => {
  const { shell } = await loadClient()
  const section = shell.GitPluginSection({ view: 'page' })
  assert.equal(section.type, 'div')
  const [heading, form] = section.children
  assert.equal(heading.type, 'h4')
  assert.equal(form.type, shell.GitSettingsTab)
  assert.equal(form.props.page, true, 'the page form drops the dialog sticky footer')
})

test('ui chunk exports every overlay and atom the other chunks import', async () => {
  const { ui } = await loadClient()
  for (const name of ['showToast', 'reportError', 'showConfirm', 'copyText', 'openContextMenu', 'openNamePrompt', 'Badge', 'IconBtn', 'Menu', 'MenuRow', 'FilePath', 'Safe', 'GitIcon', 'Chip']) {
    assert.equal(typeof ui[name], 'function', `ui.${name} must be a function`)
  }
})

test('the stylesheet text parses as CSS, so no rule is silently dropped', async () => {
  const { styles } = await loadClient()
  for (const [name, css] of [['STYLES', styles.STYLES], ['DARK_OVERRIDES', styles.DARK_OVERRIDES]]) {
    assert.equal(typeof css, 'string')
    // A `//` comment is JS syntax: inside the CSS string the parser reads it as
    // the start of a selector and discards the whole rule that follows.
    const bad = css.split('\n').findIndex((line) => /^\s*\/\//.test(line))
    assert.equal(bad, -1, `${name} line ${bad + 1} uses a // comment inside the CSS`)
    assert.equal((css.match(/{/g) ?? []).length, (css.match(/}/g) ?? []).length, `${name} has unbalanced braces`)
  }
})

test('every branch-menu operation reaches a real Api method', async () => {
  const { core } = await loadClient()
  const originals = {}
  for (const [name, value] of Object.entries(core.Api)) {
    if (typeof value === 'function') originals[name] = value
  }
  const calls = []
  for (const name of Object.keys(originals)) {
    core.Api[name] = async () => {
      calls.push(name)
      return { ok: true, output: 'one\ntwo\nthree\nfour' }
    }
  }
  try {
    for (const kind of ['pull', 'push', 'fetch', 'merge', 'switchTo', 'pushTag', 'createTag', 'deleteTag']) {
      calls.length = 0
      const text = await core.runNetOp('/repo', kind, 'main', { ref: 'HEAD' })
      // A kind that dispatches on its own name hits a method that does not exist
      // (fetch vs fetchAll), the caller catches the TypeError and the user just
      // watched a button do nothing.
      assert.deepEqual(calls, [`${kind === 'fetch' ? 'fetchAll' : kind}`], `${kind} must hit exactly one Api method`)
      assert.ok(typeof text === 'string' && text.length > 0, `${kind} returned no toast text`)
    }
    // git tells its story on stderr; the toast keeps the last three lines.
    assert.equal(await core.runNetOp('/repo', 'pull'), 'two\nthree\nfour')
  } finally {
    Object.assign(core.Api, originals)
  }
})

test('a git failure reaches the toast without its hint block', async () => {
  const { i18n } = await loadClient('zh-CN')
  const rejected = {
    message: [
      'To ../dsh-git-workbench-fixture-origin.git',
      ' ! [rejected]        feature/x -> feature/x (fetch first)',
      "error: failed to push some refs to '../dsh-git-workbench-fixture-origin.git'",
      'hint: Updates were rejected because the remote contains work that you do not',
      "hint: 'git pull' before pushing again.",
    ].join('\n'),
  }
  // A rejected push has a sentence of its own, so the git narrative — the
  // advice lines and the diff-stat noise — never reaches the toast.
  assert.match(i18n.localizeError(rejected), /推送被拒绝/)
  // A failure no rule claims keeps the line that names it, minus the advice.
  const unmapped = { message: ['error: a failure nobody has mapped yet', 'hint: try it with --foo'].join('\n') }
  assert.equal(i18n.localizeError(unmapped), 'a failure nobody has mapped yet')
  // A wall of text would cover the composer: six lines, then an ellipsis.
  const long = { message: Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n') }
  const capped = i18n.localizeError(long).split('\n')
  assert.equal(capped.length, 7)
  assert.equal(capped[6], '…')
})
