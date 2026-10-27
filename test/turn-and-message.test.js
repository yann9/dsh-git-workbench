import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTurnDiff, readTurn, resolvePresentedTurn } from '../src/git/turns.js'
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

const CARD_EVENTS = [
  { seq: 40, type: 'workspace/changes', data: { turn: 3 } },
  { seq: 41, type: 'workspace/changes', data: { turn: 2 } },
  // The later announcement for the same turn wins.
  { seq: 44, type: 'workspace/changes', data: { turn: 3 } },
  { seq: 50, type: 'deliverables/presented', data: { turn: 3, callId: 'call-1', files: [{ path: 'src/Button.js' }, { path: 'C:\\repo\\src\\store.js' }] } },
]

/** @param {Map<number, any>} summaries - the host's live snapshots, by event seq. */
function cardCtx(summaries) {
  return {
    get(name) {
      if (name === 'workspaceChanges') {
        return {
          summary: (_session, seq) => summaries.get(seq),
          diff: async (_session, _seq, index) => (index === 0 ? TEXT_DIFF : { kind: 'text', before: false, after: true, hunks: [] }),
        }
      }
      if (name === 'sessions') return { get: () => ({ snapshotEvents: () => CARD_EVENTS }) }
      return undefined
    },
  }
}

test('a delivery card resolves to the turn snapshot behind its own event', async () => {
  const turn = await readTurn(cardCtx(new Map([[44, SUMMARY]])), { session: 'session-1', seq: '50', index: '1' })
  assert.equal(turn.seq, 44)
  // The card's second file is the summary's first: matching paths, not numbers.
  assert.equal(turn.focus, 0)
  assert.equal(turn.files.length, 2)
})

test('an unmatchable card index still opens the turn, at its first file', async () => {
  const turn = await readTurn(cardCtx(new Map([[44, SUMMARY]])), { session: 'session-1', seq: '50', index: '9' })
  assert.equal(turn.seq, 44)
  assert.equal(turn.focus, 0)
})

test('resolvePresentedTurn bridges the two event sequences', () => {
  assert.deepEqual(resolvePresentedTurn(CARD_EVENTS, 50, 1), { seq: 44, path: 'C:\\repo\\src\\store.js' })
  // A turned index or another event type resolves nothing.
  assert.deepEqual(resolvePresentedTurn(CARD_EVENTS, 50, 7), { seq: 44, path: '' })
  assert.equal(resolvePresentedTurn(CARD_EVENTS, 41, 0), null)
})

test('a card whose snapshot is gone still fails with the localized explanation', async () => {
  await assert.rejects(
    () => readTurn(cardCtx(new Map()), { session: 'session-1', seq: '50', index: '0' }),
    /no longer available/,
  )
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

test('an account that is not signed in says so in the UI language', async () => {
  const ctx = llmCtx(async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in to DeepSeek to use the account provider.' } } }
  })
  const result = await draftCommitMessage(ctx, STAGED_DIFF, {})
  assert.equal(result.source, 'heuristic')
  assert.match(result.warning, /未登录/)
  assert.doesNotMatch(result.warning, /Sign in/)
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

test("an official-account login uses the session's selected route", async () => {
  // The first registered provider on an official login has no catalog of its
  // own; the route chat uses is the selection, and only that one is usable.
  const seen = []
  const ctx = {
    get: (name) => {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
          listModels: async () => [],
          stream: async function* (request) {
            seen.push(`${request.provider}/${request.model}`)
            yield { type: 'text-delta', index: 0, text: 'chore: x' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
      }
      return undefined
    },
    logger: { warn: () => {} },
  }
  const result = await draftCommitMessage(ctx, STAGED_DIFF, {})
  assert.equal(result.source, 'model')
  assert.equal(result.model, 'deepseek-account/deepseek-flash')
  assert.deepEqual(seen, ['deepseek-account/deepseek-flash'])
})

test('a configured provider and model still win over the selection', async () => {
  const seen = []
  const ctx = {
    get: (name) => {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-account' }],
          listModels: async () => [],
          stream: async function* (request) {
            seen.push(`${request.provider}/${request.model}`)
            yield { type: 'text-delta', index: 0, text: 'chore: x' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
      }
      return undefined
    },
    logger: { warn: () => {} },
  }
  const result = await draftCommitMessage(ctx, STAGED_DIFF, { provider: 'my-proxy', model: 'big-model' })
  assert.equal(result.model, 'my-proxy/big-model')
  assert.deepEqual(seen, ['my-proxy/big-model'])
})

test("a provider override does not borrow another provider's model id", async () => {
  const seen = []
  const ctx = {
    get: (name) => {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'some-other-provider', defaultModel: 'their-default' }],
          listModels: async () => [],
          stream: async function* (request) {
            seen.push(`${request.provider}/${request.model}`)
            yield { type: 'text-delta', index: 0, text: 'chore: x' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
      }
      return undefined
    },
    logger: { warn: () => {} },
  }
  await draftCommitMessage(ctx, STAGED_DIFF, { provider: 'some-other-provider' })
  assert.deepEqual(seen, ['some-other-provider/their-default'])
})

test('prompts and warnings follow the requested language', async () => {
  const en = await draftCommitMessage({ get: () => undefined }, STAGED_DIFF, { language: 'en' })
  assert.match(en.message, /^fix\(src\): update store\.js$/)
  assert.match(en.warning, /no model route is available/)

  const zh = await draftCommitMessage({ get: () => undefined }, STAGED_DIFF, { language: 'zh' })
  assert.match(zh.message, /^fix\(src\): 更新 store\.js$/)
  assert.match(zh.warning, /没有可用的模型路由/)
})

test('the prompt names the language to answer in', async () => {
  // The rules used to imply the language through their own wording; a model
  // reading an all-English diff then answered in English under a Chinese UI.
  const prompts = []
  const ctx = {
    get: (name) =>
      name === 'llm'
        ? {
            listProviders: () => [{ id: 'deepseek-account', defaultModel: 'deepseek-flash' }],
            listModels: async () => [],
            stream: async function* (request) {
              prompts.push(request.messages?.[0]?.content?.[0]?.text ?? '')
              yield { type: 'text-delta', index: 0, text: 'chore: x' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        : undefined,
    logger: { warn: () => {} },
  }
  await draftCommitMessage(ctx, STAGED_DIFF, { language: 'zh' })
  await draftCommitMessage(ctx, STAGED_DIFF, { language: 'en' })
  assert.match(prompts[0], /提交信息用中文书写/)
  assert.match(prompts[1], /Write the message in English/)
})
