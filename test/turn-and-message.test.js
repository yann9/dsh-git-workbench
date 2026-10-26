import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTurnDiff, readTurn } from '../src/git/turns.js'
import { draftCommitMessage, heuristic } from '../src/llm/commit-message.js'

/** Minimal stand-in for the harness's `ctx.workspaceChanges` service. */
function fakeCtx(summary, diffs) {
  return {
    get(name) {
      if (name !== 'workspaceChanges') return undefined
      return {
        summary: () => summary,
        diff: async (_session, _seq, index) => diffs[index],
      }
    },
  }
}

const SUMMARY = {
  turn: 3,
  total: 2,
  files: [
    { path: 'src/store.js', display: 'src/store.js', added: 2, deleted: 1 },
    { path: 'src/Button.js', display: 'src/Button.js', added: 1, deleted: 0 },
  ],
}

const TEXT_DIFF = {
  kind: 'text',
  path: 'src/store.js',
  display: 'src/store.js',
  before: true,
  after: true,
  coarse: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
      lines: [' const listeners = new Set()', '-  const history = []', '+  const history = []', '+  const undo = () => {}', '   return { getState }'],
    },
  ],
}

test('turn diff is normalized into the workbench FileDiff shape', () => {
  const file = normalizeTurnDiff(TEXT_DIFF, SUMMARY.files[0])
  assert.equal(file.path, 'src/store.js')
  assert.equal(file.status, 'modified')
  assert.equal(file.hunks.length, 1)

  const lines = file.hunks[0].lines
  assert.equal(lines[0].type, 'context')
  assert.equal(lines[0].oldLine, 1)
  assert.equal(lines[0].newLine, 1)
  assert.equal(lines[1].type, 'del')
  assert.equal(lines[1].oldLine, 2)
  assert.equal(lines[1].newLine, null)
  assert.equal(lines[2].type, 'add')
  assert.equal(lines[2].newLine, 2)
  assert.equal(file.additions, 2)
  assert.equal(file.deletions, 1)
})

test('added and deleted turn files report their status', () => {
  const added = normalizeTurnDiff({ kind: 'text', before: false, after: true, hunks: [] }, { path: 'a.js', added: 3, deleted: 0 })
  assert.equal(added.status, 'added')
  const deleted = normalizeTurnDiff({ kind: 'text', before: true, after: false, hunks: [] }, { path: 'b.js', added: 0, deleted: 4 })
  assert.equal(deleted.status, 'deleted')
  const binary = normalizeTurnDiff({ kind: 'binary', path: 'x.png', display: 'x.png' }, { path: 'x.png' })
  assert.equal(binary.binary, true)
})

test('readTurn returns every file of the turn with its diff', async () => {
  const ctx = fakeCtx(SUMMARY, [TEXT_DIFF, { kind: 'text', before: false, after: true, hunks: [] }])
  const turn = await readTurn(ctx, { session: 'session-1', seq: '42' })
  assert.equal(turn.turn, 3)
  assert.equal(turn.seq, 42)
  assert.equal(turn.files.length, 2)
  assert.equal(turn.files[0].index, 0)
  assert.equal(turn.files[1].diff.status, 'added')
  assert.equal(turn.total, 2)
})

test('readTurn explains a missing turn instead of failing silently', async () => {
  const ctx = fakeCtx(undefined, [])
  await assert.rejects(() => readTurn(ctx, { session: 'session-1', seq: '42' }), /no longer available/)
  await assert.rejects(() => readTurn({ get: () => undefined }, { session: 's', seq: '1' }), /does not expose workspace changes/)
  await assert.rejects(() => readTurn(fakeCtx(SUMMARY, []), { seq: '1' }), /missing session id/)
})

test('commit message fallback stays conventional and specific', () => {
  const docs = heuristic([{ path: 'README.md', status: 'modified' }, { path: 'docs/a.md', status: 'modified' }], 'zh')
  assert.match(docs, /^docs/)

  const created = heuristic([{ path: 'src/a.js', status: 'added' }], 'zh')
  assert.match(created, /^feat\(src\): 更新 a\.js$/)

  const many = heuristic(
    [
      { path: 'src/api/a.js', status: 'modified' },
      { path: 'src/api/b.js', status: 'modified' },
      { path: 'src/api/c.js', status: 'modified' },
      { path: 'src/api/d.js', status: 'modified' },
    ],
    'zh',
  )
  assert.match(many, /^fix\(api\): 更新 a\.js、b\.js、c\.js 等 4 个文件$/)
})

const STAGED_DIFF = {
  files: [
    {
      path: 'src/store.js',
      status: 'modified',
      additions: 2,
      deletions: 0,
      hunks: [{ lines: [{ type: 'add', text: '  const history = []' }, { type: 'context', text: '' }] }],
    },
  ],
}

function llmCtx(stream) {
  // A provider that declares its default model — the resolution path the
  // implementation relies on instead of guessing ids.
  const llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek', defaultModel: 'deepseek-v4-flash' }],
    listModels: async () => [],
    stream,
  }
  return { get: (name) => (name === 'llm' ? llm : undefined), logger: { warn: () => {} } }
}

test('the model route is used and the reply is cleaned up', async () => {
  const ctx = llmCtx(async function* () {
    yield { type: 'block-start', index: 0 }
    yield { type: 'text-delta', index: 0, text: '```\n' }
    yield { type: 'text-delta', index: 0, text: 'feat(store): 支持撤销上一状态\n\n- 记录历史快照\n' }
    yield { type: 'text-delta', index: 0, text: '```' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const result = await draftCommitMessage(ctx, STAGED_DIFF, {})
  assert.equal(result.source, 'model')
  assert.equal(result.model, 'deepseek-official/deepseek-v4-flash')
  assert.equal(result.message, 'feat(store): 支持撤销上一状态\n\n- 记录历史快照')
})

test('a missing credential falls back with an actionable message', async () => {
  const ctx = llmCtx(async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: 'no API key' } } }
  })
  const result = await draftCommitMessage(ctx, STAGED_DIFF, {})
  assert.equal(result.source, 'heuristic')
  assert.match(result.warning, /凭据/)
  assert.match(result.message, /^fix\(src\)/)
})

test('without any model route the local rules still answer', async () => {
  const result = await draftCommitMessage({ get: () => undefined }, STAGED_DIFF, {})
  assert.equal(result.source, 'heuristic')
  assert.match(result.warning, /没有可用的模型路由/)
})

test('the model comes from the provider, never from a hard-coded list', async (t) => {
  const seen = []
  const ctx = {
    get: (name) =>
      name === 'llm'
        ? {
            listProviders: () => [{ id: 'some-other-provider', defaultModel: 'their-model' }],
            listModels: async () => [{ id: 'their-model' }],
            stream: async function* (request) {
              seen.push(`${request.provider}/${request.model}`)
              yield { type: 'text-delta', index: 0, text: 'chore: x' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        : undefined,
    logger: { warn: () => {} },
  }
  const result = await draftCommitMessage(ctx, STAGED_DIFF, {})
  assert.equal(result.source, 'model')
  assert.deepEqual(seen, ['some-other-provider/their-model'])
})

test('prompts and warnings follow the requested language', async () => {
  const en = await draftCommitMessage({ get: () => undefined }, STAGED_DIFF, { language: 'en' })
  assert.match(en.message, /^fix\(src\): update store\.js$/)
  assert.match(en.warning, /no model route is available/)

  const zh = await draftCommitMessage({ get: () => undefined }, STAGED_DIFF, { language: 'zh' })
  assert.match(zh.message, /^fix\(src\): 更新 store\.js$/)
  assert.match(zh.warning, /没有可用的模型路由/)
})
