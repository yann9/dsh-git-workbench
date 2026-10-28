import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.join(import.meta.dirname, '..')

/**
 * The documents that ship in both languages. `README.md`/`README.zh.md` set the
 * convention: the bare name is English, the `.zh.md` name is Chinese.
 */
const PAIRS = [
  ['README.md', 'README.zh.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.zh.md'],
  ['SECURITY.md', 'SECURITY.zh.md'],
  ...['api', 'architecture', 'development', 'features', 'jetbrains-parity']
    .map((name) => [`docs/${name}.md`, `docs/${name}.zh.md`]),
]

const read = (file) => readFileSync(path.join(root, file), 'utf8')

/** Split a document into lines, flagging which ones sit inside a fenced block. */
function lines(file) {
  const out = []
  let fenced = false
  for (const line of read(file).split(/\r?\n/)) {
    if (/^```/.test(line)) {
      out.push({ line, fenced: true })
      fenced = !fenced
      continue
    }
    out.push({ line, fenced })
  }
  return out
}

/** GitHub's heading anchors, near enough: inline markup removed, punctuation dropped, spaces hyphenated. */
function slug(text) {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** Headings, outside fenced blocks, in document order, with the anchor each one gets. */
function headings(file) {
  const seen = new Map()
  const out = []
  for (const { line, fenced } of lines(file)) {
    if (fenced) continue
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line)
    if (!match) continue
    let anchor = slug(match[2])
    const count = seen.get(anchor) ?? 0
    seen.set(anchor, count + 1)
    if (count > 0) anchor = `${anchor}-${count}`
    out.push({ level: match[1].length, anchor })
  }
  return out
}

/** Inline links and images, outside fenced blocks: [text](target) and ![alt](target). */
function links(file) {
  const out = []
  for (const { line, fenced } of lines(file)) {
    if (fenced) continue
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      out.push(match[1])
    }
  }
  return out
}

const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')

test('every document ships in both languages with the same structure', () => {
  for (const [en, zh] of PAIRS) {
    for (const file of [en, zh]) assert.ok(existsSync(path.join(root, file)), `${file} is missing`)

    const enHeadings = headings(en)
    const zhHeadings = headings(zh)
    assert.deepEqual(
      zhHeadings.map((h) => h.level),
      enHeadings.map((h) => h.level),
      `${zh} must repeat the section structure of ${en}`,
    )

    // A translation neither adds nor drops code samples or tables.
    const shape = (file) => ({
      fences: lines(file).filter(({ line }) => /^```/.test(line)).length,
      tables: lines(file).filter(({ line, fenced }) => !fenced && /^\|[\s:|-]+\|$/.test(line)).length,
    })
    assert.deepEqual(shape(zh), shape(en), `${zh} must carry the same code blocks and tables as ${en}`)
  }
})

test('every relative link in the docs resolves, anchors included', () => {
  const files = PAIRS.flat()
  const problems = []
  for (const file of files) {
    for (const target of links(file)) {
      if (isExternal(target)) continue
      const [rawPath, rawAnchor] = target.split('#')
      const resolved = rawPath === '' ? file : path.join(path.dirname(file), rawPath)
      if (!existsSync(path.join(root, resolved))) {
        problems.push(`${file}: ${target} → ${resolved} does not exist`)
        continue
      }
      if (rawAnchor === undefined || !resolved.endsWith('.md')) continue
      const anchor = decodeURIComponent(rawAnchor).toLowerCase()
      const anchors = new Set(headings(resolved).map((h) => h.anchor))
      if (!anchors.has(anchor)) problems.push(`${file}: ${target} → no "#${anchor}" heading in ${resolved}`)
    }
  }
  assert.deepEqual(problems, [])
})

test('an English document never sends the reader into a Chinese one', () => {
  const bilingual = new Set(PAIRS.flat())
  const problems = []
  for (const file of bilingual) {
    const zhSource = file.endsWith('.zh.md')
    for (const target of links(file)) {
      if (isExternal(target) || target.startsWith('#')) continue
      const [rawPath] = target.split('#')
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), rawPath))
      // Only targets that exist in both languages have a language to get wrong.
      if (!bilingual.has(resolved)) continue
      if (resolved.endsWith('.zh.md') === zhSource) continue
      // The language switcher is the one link that is supposed to cross over.
      if (rawPath === (zhSource ? 'README.md' : 'README.zh.md') && file.startsWith('README')) continue
      problems.push(`${file}: ${target} crosses languages`)
    }
  }
  assert.deepEqual(problems, [])
})
