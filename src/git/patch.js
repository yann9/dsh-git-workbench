/**
 * Partial staging.
 *
 * JetBrains' "stage hunk" / "stage line" is implemented the same way
 * `git add -p` is: crop the diff to the selected lines, then apply the cropped
 * patch to the index. Nothing touches the working tree.
 *
 * Direction matters, because the index is the *post*-image when unstaging:
 *
 * | line     | stage (index = pre-image) | unstage (index = post-image) |
 * |----------|---------------------------|------------------------------|
 * | + chosen | `+`                       | `+`                          |
 * | + skipped| dropped                   | ` ` (still in the index)     |
 * | - chosen | `-`                       | `-`                          |
 * | - skipped| ` ` (keep it in the index)| dropped                      |
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { git } from './exec.js'

/**
 * @typedef {import('./diff.js').FileDiff} FileDiff
 * @typedef {import('./diff.js').DiffHunk} DiffHunk
 * @typedef {import('./diff.js').DiffLine} DiffLine
 */

/**
 * @param {FileDiff} file
 * @param {Set<string>} selectedIds line ids, or hunk ids (`h0`) meaning "all lines"
 * @param {'stage'|'unstage'} direction
 * @returns {string | null} patch text, or null when nothing is selected
 */
export function buildPatch(file, selectedIds, direction) {
  if (file.binary) return null

  /** @type {string[]} */
  const body = []
  let delta = 0

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    const hunkId = `h${hunkIndex}`
    const wholeHunk = selectedIds.has(hunkId)
    /** @type {{ marker: string, text: string, source: DiffLine }[]} */
    const kept = []

    for (const line of hunk.lines) {
      const selected = wholeHunk || selectedIds.has(line.id)
      if (line.type === 'context') {
        kept.push({ marker: ' ', text: line.text, source: line })
        continue
      }
      if (line.type === 'add') {
        if (selected) kept.push({ marker: '+', text: line.text, source: line })
        else if (direction === 'unstage') kept.push({ marker: ' ', text: line.text, source: line })
        continue
      }
      if (selected) kept.push({ marker: '-', text: line.text, source: line })
      else if (direction === 'stage') kept.push({ marker: ' ', text: line.text, source: line })
    }

    const changed = kept.some((entry) => entry.marker !== ' ')
    if (!changed) continue

    const oldLines = kept.filter((entry) => entry.marker !== '+').length
    const newLines = kept.filter((entry) => entry.marker !== '-').length
    const oldStart = direction === 'stage' ? hunk.oldStart : hunk.newStart - delta
    const newStart = direction === 'stage' ? hunk.oldStart + delta : hunk.newStart

    body.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${hunk.section ? ` ${hunk.section}` : ''}`)
    for (const [index, entry] of kept.entries()) {
      body.push(entry.marker + entry.text)
      const missing = entry.source.noNewline
      const isLast = index === kept.length - 1
      if (missing && isLast && (missing === 'both' || (missing === 'new' && entry.marker !== '-') || (missing === 'old' && entry.marker !== '+'))) {
        body.push('\\ No newline at end of file')
      }
    }
    delta += newLines - oldLines
  }

  if (body.length === 0) return null

  const oldPath = quotePath(file.oldPath)
  const newPath = quotePath(file.path)
  const header = [`diff --git a/${oldPath} b/${newPath}`, `--- a/${oldPath}`, `+++ b/${newPath}`]
  return `${header.join('\n')}\n${body.join('\n')}\n`
}

/**
 * Discard exactly the selected lines of a worktree diff.
 *
 * A cropped `git apply --reverse` cannot express a partial hunk: dropping the
 * unselected `+` lines leaves a hole the worktree does not match any more, and
 * the unselected `-` lines would have to appear as context that was never in
 * the worktree. So rebuild each touched hunk block instead — keep the context,
 * keep the additions that were not selected, put back the deletions that were —
 * and write the result. This is the IDE's "Revert Selected Changes".
 * @param {string} root
 * @param {FileDiff} file
 * @param {Set<string>} selectedIds
 * @returns {Promise<boolean>} false when the selection touched nothing
 */
export async function revertSelectedLines(root, file, selectedIds) {
  const repoRoot = resolve(root)
  const target = resolve(repoRoot, file.path)
  if (!target.startsWith(repoRoot + sep)) throw new Error(`path escapes the repository: ${file.path}`)

  const original = await readFile(target, 'utf8')
  let endsWithNewline = original.endsWith('\n')
  const body = endsWithNewline ? original.slice(0, -1) : original
  const lines = body.split('\n')

  /** @type {{ start: number, end: number, block: string[], tail: DiffLine | null }[]} */
  const regions = []
  for (const hunk of file.hunks) {
    const touched = hunk.lines.filter((line) => line.type !== 'context' && selectedIds.has(line.id))
    if (touched.length === 0) continue

    // The worktree side of the hunk is every line but the deletions.
    const start = hunk.newLines > 0 ? hunk.newStart - 1 : hunk.newStart
    const current = hunk.lines.filter((line) => line.type !== 'del')
    const region = lines.slice(start, start + hunk.newLines)
    const same = region.length === current.length && region.every((text, offset) => stripEol(text) === stripEol(current[offset].text))
    if (!same) throw new Error(`the file changed since the diff was read: ${file.path}`)

    // Lines that stay put are copied from the worktree, so a CRLF file is not
    // quietly rewritten with LF endings.
    const restored = region.some((text) => text.endsWith('\r')) || (region.length === 0 && lines.some((text) => text.endsWith('\r')))
    const block = []
    let tail = null
    let cursor = 0
    for (const line of hunk.lines) {
      if (line.type === 'del') {
        if (!selectedIds.has(line.id)) continue
        block.push(`${stripEol(line.text)}${restored ? '\r' : ''}`)
        tail = line
        continue
      }
      const existing = region[cursor]
      cursor += 1
      if (line.type === 'add' && selectedIds.has(line.id)) continue
      block.push(existing)
      tail = line
    }
    regions.push({ start, end: start + hunk.newLines, block, tail })
  }
  if (regions.length === 0) return false

  // Descending order keeps the offsets of the regions above valid.
  const total = lines.length
  regions.sort((left, right) => right.start - left.start)
  for (const region of regions) {
    lines.splice(region.start, region.end - region.start, ...region.block)
    if (region.end >= total && region.tail) {
      const marker = region.tail.type
      const missing = region.tail.noNewline
      endsWithNewline = !(missing === 'both' || (marker === 'del' ? missing === 'old' : missing === 'new'))
    }
  }

  await writeFile(target, `${lines.join('\n')}${endsWithNewline && lines.length > 0 ? '\n' : ''}`, 'utf8')
  return true
}

/**
 * Apply a patch to the worktree (not the index). With `reverse` this discards
 * the patched lines — the workbench' "还原" (revert) action.
 * @param {string} root
 * @param {string} patch
 * @param {{ reverse?: boolean }} [options]
 */
export async function applyToWorktree(root, patch, options = {}) {
  const args = ['apply', '--whitespace=nowarn', '--recount']
  if (options.reverse) args.push('--reverse')
  args.push('-')
  await git(root, args, { input: patch })
}

/**
 * Apply an index-only patch. `git apply --cached` never writes the worktree.
 * @param {string} root
 * @param {string} patch
 * @param {{ reverse?: boolean }} [options]
 */
export async function applyToIndex(root, patch, options = {}) {
  const args = ['apply', '--cached', '--whitespace=nowarn', '--recount']
  if (options.reverse) args.push('--reverse')
  args.push('-')
  await git(root, args, { input: patch })
}

/**
 * Stage or unstage whole files. Used for untracked / added / renamed entries
 * where a partial patch has no valid pre-image.
 * @param {string} root
 * @param {string[]} paths
 * @param {'stage'|'unstage'} direction
 * @param {boolean} unborn
 */
export async function applyWholeFiles(root, paths, direction, unborn) {
  if (paths.length === 0) return
  if (direction === 'stage') {
    await git(root, ['add', '-A', '--', ...paths])
    return
  }
  if (unborn) {
    await git(root, ['rm', '--cached', '-r', '--quiet', '--', ...paths])
    return
  }
  await git(root, ['restore', '--staged', '--', ...paths])
}

/**
 * Git reports line content without its line ending; the worktree keeps it.
 * @param {string} value
 */
function stripEol(value) {
  return value.endsWith('\r') ? value.slice(0, -1) : value
}

/**
 * Git's C-style path quoting for the patch header.
 * @param {string} value
 */
function quotePath(value) {
  if (!/["\\\n\t\u0000-\u001f]/.test(value) && !/[^\x20-\x7e]/.test(value)) return value
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}
