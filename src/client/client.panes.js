// dsh-git-workbench — client chunk (native DSH module chunk).
// Registered as a chunk of the plugin's client entry; see browser.js.

window.__ModuleLoader__.load({
  id: '@yann9/dsh-git-workbench',
  chunk: 'client.panes.js',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React
    const kit = require('@yann9/dsh-git-workbench/client.core.js')
    const { Api, baseName, collectPaths, compareStore, config, countFiles, fileHistoryStore, listModeStore, LOG_KIND, logColumnsStore, logGroupStore, logSortStore, openDiff, openTab, preloadedCommits, runNetOp, statusColor, switchBranch, useCompact, useCompare, useFileHistory, useListMode, useLogColumns, useLogGroup, useLogSort, useRepoChanges, useSessionDirectory, walkFileTree } = kit
    const { Badge, FilePath, FolderIcon, GitIcons, IconBtn, Menu, MenuRow, copyText, iconMarkup, openContextMenu, openNamePrompt, reportError, showCheckFailure, showConfirm, showIdentityDialog, showRebaseDialog, showRewordDialog, showToast } = require('@yann9/dsh-git-workbench/client.ui.js')
    const { GitOperationsMenu, sessionBranchName, busyLabel } = require('@yann9/dsh-git-workbench/client.shell.js')
    const { isZh, localizeError, tt } = require('@yann9/dsh-git-workbench/client.i18n.js')

    /**
     * Track the width of the log list column. A column that is too narrow
     * cannot show everything, so the stylesheet drops what does not fit.
     * @param {{ current: Element | null }} ref
     * @param {number} narrow
     * @param {number} tight
     */
    function useNarrowColumn(ref, narrow, tight) {
      useEffect(() => {
        const node = ref.current
        if (!node || typeof ResizeObserver !== 'function') return
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const width = entry.contentRect.width
            node.dataset.narrow = width < narrow ? '1' : '0'
            node.dataset.tight = width < tight ? '1' : '0'
          }
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [ref, narrow, tight])
    }

    /**
     * The width the subject cell has in the log list. A row needs it to
     * decide how many branch labels it can spell out in full: the labels
     * keep their width, so the ones that do not fit fold into a "+N" chip.
     * @param {{ current: Element | null }} ref
     */
    function useSubjectWidth(ref) {
      const [width, setWidth] = useState(0)
      const measure = useCallback(() => {
        const node = ref.current
        if (!node) return
        const cell = node.querySelector('.gwb-logrow .gwb-subject')
        const next = cell ? Math.round(cell.getBoundingClientRect().width) : 0
        setWidth((current) => (current === next ? current : next))
      }, [ref])
      useEffect(() => {
        const node = ref.current
        if (!node || typeof ResizeObserver !== 'function') return
        const observer = new ResizeObserver(() => measure())
        observer.observe(node)
        measure()
        return () => observer.disconnect()
      }, [ref, measure])
      return [width, measure]
    }

    /**
     * Compact commit date for the log list: clock time today, "yesterday",
     * "n days ago" this week, then month-day, then full date.
     */
    function shortDate(value) {
      const text = String(value ?? '')
      const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
      if (!match) return text.slice(0, 10)
      const [, year, month, day, hour, minute] = match
      const now = new Date()
      const then = new Date(`${year}-${month}-${day}T00:00:00`)
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const days = Math.round((today - then) / 86400000)
      if (days === 0) return `${hour}:${minute}`
      if (days === 1) return tt('date.yesterday')
      if (days > 1 && days < 7) return tt('date.daysAgo', { count: days })
      return Number(year) === now.getFullYear() ? `${month}-${day}` : `${year}-${month}-${day}`
    }

    /**
     * The fields the log search understands as `key:value`. The IDE offers the
     * same set in its log toolbar, and the names are the ones a user already
     * knows from `git log --author/--grep`.
     */
    const LOG_QUERY_FIELDS = ['author', 'message', 'hash', 'tag', 'branch', 'date']

    /**
     * Split a search string into tokens. Double quotes keep a value with
     * spaces in one piece, so `author:"Ada Lovelace"` is a single condition.
     * @param {string} text
     * @returns {string[]}
     */
    function tokenizeLogQuery(text) {
      const source = String(text ?? '')
      const tokens = []
      let buffer = ''
      let quoted = false
      let started = false
      for (const char of source) {
        if (char === '"') {
          quoted = !quoted
          started = true
          continue
        }
        if (!quoted && /\s/.test(char)) {
          if (started) {
            tokens.push(buffer)
            buffer = ''
            started = false
          }
          continue
        }
        buffer += char
        started = true
      }
      if (started) tokens.push(buffer)
      return tokens
    }

    /**
     * Parse the search box into conditions. A recognised `key:value` becomes a
     * condition; anything else stays free text over the subject, the author
     * and the hash — the plain substring search it has always been. An unknown
     * `key:value` is free text too, because a commit message may well read
     * `fix: crash` and silently dropping it would hide commits.
     *
     * Words next to each other are one search string, words separated by a
     * condition are two: each part is what a chip removes, so a part has to be
     * exactly what the match uses.
     * @param {string} text
     * @returns {{ parts: Array<{ kind: string, key: string, value: string, raw: string }>, terms: Array<{ kind: string, key: string, value: string, raw: string }>, free: Array<{ kind: string, key: string, value: string, raw: string }> }}
     */
    function parseLogQuery(text) {
      const parts = []
      for (const token of tokenizeLogQuery(text)) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*):([\s\S]*)$/.exec(token)
        const key = match ? match[1].toLowerCase() : ''
        if (match && LOG_QUERY_FIELDS.includes(key)) {
          const value = match[2].trim()
          parts.push({ kind: 'term', key, value, raw: value.includes(' ') ? `${key}:"${value}"` : `${key}:${value}` })
          continue
        }
        const last = parts[parts.length - 1]
        if (last && last.kind === 'free') {
          last.value = `${last.value} ${token}`.trim()
          last.raw = last.value
        } else {
          parts.push({ kind: 'free', key: '', value: token, raw: token })
        }
      }
      return {
        parts,
        terms: parts.filter((part) => part.kind === 'term'),
        free: parts.filter((part) => part.kind === 'free'),
      }
    }

    /** The commit date as YYYYMMDD, so periods compare as plain numbers. */
    function logDateNumber(value) {
      const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value ?? ''))
      if (!match) return null
      return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3])
    }

    /**
     * The period a `date:` condition names. `2026`, `2026-10` and `2026-10-22`
     * stand for the year, the month and the day; a leading operator shifts the
     * comparison to the edges of that period.
     * @param {string} value
     */
    function logDatePeriod(value) {
      const match = /^(>=|<=|>|<|=)?\s*(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(String(value ?? '').trim())
      if (!match) return null
      const op = match[1] || '='
      const year = Number(match[2])
      const month = match[3] ? Number(match[3]) : null
      const day = match[4] ? Number(match[4]) : null
      if (month === null) return { op, from: year * 10000 + 101, to: year * 10000 + 1231 }
      if (day === null) {
        const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
        return { op, from: year * 10000 + month * 100 + 1, to: year * 10000 + month * 100 + last }
      }
      return { op, from: year * 10000 + month * 100 + day, to: year * 10000 + month * 100 + day }
    }

    /** @param {string} value */
    function matchLogDate(entryDate, value) {
      const number = logDateNumber(entryDate)
      const period = logDatePeriod(value)
      // An unreadable date must not hide every commit.
      if (number === null || !period) return true
      if (period.op === '>') return number > period.to
      if (period.op === '>=') return number >= period.from
      if (period.op === '<') return number < period.from
      if (period.op === '<=') return number <= period.to
      return number >= period.from && number <= period.to
    }

    /**
     * @param {object} entry
     * @param {{ key: string, value: string }} term
     */
    function matchLogTerm(entry, term) {
      const value = String(term.value ?? '').toLowerCase()
      if (value === '') return true
      const refs = (entry.refs ?? []).map((ref) => String(ref))
      if (term.key === 'author') {
        return [entry.author, entry.email].some((field) => String(field ?? '').toLowerCase().includes(value))
      }
      if (term.key === 'message') return String(entry.subject ?? '').toLowerCase().includes(value)
      if (term.key === 'hash') return String(entry.hash ?? '').toLowerCase().startsWith(value)
      if (term.key === 'tag') {
        return refs.some((ref) => ref.toLowerCase().startsWith('tag: ') && ref.slice(5).toLowerCase().includes(value))
      }
      if (term.key === 'branch') {
        return refs.some((ref) => {
          const name = ref.toLowerCase()
          if (name.startsWith('tag: ')) return false
          return name.replace(/^head -> /, '').includes(value)
        })
      }
      if (term.key === 'date') return matchLogDate(entry.date, term.value)
      return true
    }

    /**
     * Every condition has to hold — the IDE combines them with AND.
     * @param {object} entry
     * @param {{ terms: Array<{ key: string, value: string }>, free: Array<{ value: string }> }} parsed
     */
    function matchLogQuery(entry, parsed) {
      for (const term of parsed.terms) {
        if (!matchLogTerm(entry, term)) return false
      }
      if (parsed.free.length > 0) {
        // NUL separators keep a needle from matching across two fields.
        const haystack = [entry.subject, entry.author, entry.email, entry.hash, (entry.refs ?? []).join(' ')]
          .join(String.fromCharCode(0))
          .toLowerCase()
        for (const part of parsed.free) {
          if (!haystack.includes(part.value.toLowerCase())) return false
        }
      }
      return true
    }

    /**
     * The ways the log can be grouped, the way the IDE's "Group by" menu
     * offers them: a flat list, or one section per branch, author or day.
     */
    const LOG_GROUP_MODES = ['none', 'branch', 'author', 'date']

    /** The day a commit was authored, as YYYY-MM-DD. */
    function logDayKey(value) {
      const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value ?? ''))
      if (!match) return ''
      return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    }

    /** A day in the reader's own timezone, as YYYY-MM-DD. */
    function localDayKey(date) {
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /**
     * The group a commit belongs to. A commit lands in exactly one group:
     * one commit can carry several refs, and showing it under every one of
     * them would repeat it in the list.
     * @param {object} entry
     * @param {string} mode
     * @returns {{ key: string, label: string, detail: string }}
     */
    function logGroupOf(entry, mode) {
      if (mode === 'branch') {
        const ref = (entry.refs ?? [])
          .map((value) => String(value).replace(/^HEAD -> /, ''))
          .find((value) => value !== '' && !value.startsWith('tag: '))
        return { key: ref ?? '', label: ref ?? '', detail: '' }
      }
      if (mode === 'author') {
        const name = String(entry.author ?? '').trim()
        const email = String(entry.email ?? '').trim()
        return { key: email ? `${name} <${email}>` : name, label: name, detail: email }
      }
      if (mode === 'date') {
        const key = logDayKey(entry.date)
        return { key, label: key, detail: '' }
      }
      return { key: '', label: '', detail: '' }
    }

    /**
     * Split the log into the sections it shows. The order is the order the
     * groups first appear in the log, which for a newest-first log is the
     * order of each group's most recent commit.
     * @param {object[]} list
     * @param {string} mode
     * @returns {Array<{ key: string, label: string, detail: string, entries: object[] }>}
     */
    function groupLogEntries(list, mode) {
      if (!mode || mode === 'none') return [{ key: '', label: '', detail: '', entries: list }]
      const groups = []
      const index = new Map()
      for (const entry of list) {
        const group = logGroupOf(entry, mode)
        let bucket = index.get(group.key)
        if (!bucket) {
          bucket = { key: group.key, label: group.label, detail: group.detail, entries: [] }
          index.set(group.key, bucket)
          groups.push(bucket)
        }
        bucket.entries.push(entry)
      }
      // Two authors can share a name; the email is what tells them apart.
      const names = new Map()
      for (const group of groups) names.set(group.label, (names.get(group.label) ?? 0) + 1)
      for (const group of groups) {
        if (names.get(group.label) > 1 && group.detail) group.label = `${group.label} <${group.detail}>`
      }
      return groups
    }

    /** The glyph that says what a group is. */
    function groupIcon(mode) {
      if (mode === 'branch') return GitIcons.branch
      if (mode === 'author') return GitIcons.user
      if (mode === 'date') return GitIcons.calendar
      return GitIcons.changelist
    }

    /** What a group header reads: the branch, the author, or the day. */
    function groupLabel(group, mode) {
      if (mode === 'branch') return group.key === '' ? tt('log.group.noBranch') : group.key
      if (mode === 'author') return group.label
      if (group.key === localDayKey(new Date())) return tt('log.group.today')
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      if (group.key === localDayKey(yesterday)) return tt('log.group.yesterday')
      return group.key
    }

    /**
     * The columns the log table can be sorted by — the IDE sorts by clicking a
     * header, and the date column is the one it starts on.
     */
    const LOG_SORT_KEYS = ['date', 'subject', 'author', 'hash']

    /**
     * The columns the user can switch off. The subject stays: a log row
     * without a subject says nothing.
     */
    const LOG_COLUMN_KEYS = ['author', 'date', 'hash']

    /**
     * How many branch/tag labels one log row shows. The rest fold into a
     * "+N" chip: a row that lists six labels has no room left for the
     * message, and a message you cannot read is worse than a count.
     */
    const LOG_REF_LIMIT = 3

    /**
     * The room a log row divides up. The labels name the branch, so they
     * keep their width and the message is what gives way — but the message
     * still keeps enough to be worth reading.
     */
    const LOG_MSG_FLOOR = 72
    const LOG_REF_GAP = 4
    const LOG_REF_SPACE = 5
    const LOG_REF_MAX = 220
    const LOG_REF_CUT_MIN = 40
    const LOG_REF_SLACK = 6

    /**
     * How many branch labels a row can spell out in the room it has. A label
     * that does not fit folds into the "+N" chip instead of being cut in
     * half: "or…" says nothing, "+2" at least says there are two more. The
     * label that names the branch stays even when it has to be cut short.
     *
     * @param {number[]} widths the measured width of every label
     * @param {number} room the width the labels may use
     * @param {(count: number) => number} chipWidth the width of a chip that
     *   names that many hidden labels
     */
    function fitLogRefs(widths, room, chipWidth) {
      let used = 0
      let shown = 0
      let cut = 0
      for (let index = 0; index < widths.length && shown < LOG_REF_LIMIT; index += 1) {
        const gap = shown > 0 ? LOG_REF_GAP : 0
        const rest = widths.length - index - 1
        // The chip that names the labels which do not fit takes its own room.
        const chip = rest > 0 ? chipWidth(rest) : 0
        if (used + gap + widths[index] + chip > room) {
          const left = room - chip
          if (shown === 0 && left >= LOG_REF_CUT_MIN) {
            shown = 1
            // A name that is cut by two pixels reads worse than a message
            // that is two pixels shorter, so the label may keep a little
            // more than the room it asked for.
            cut = Math.min(widths[0], left + LOG_REF_SLACK)
          }
          break
        }
        used += gap + widths[index]
        shown += 1
      }
      return { shown, cut }
    }

    let labelCtx = null
    let labelFont = ''
    let labelFamily = ''

    /**
     * The font the labels are drawn in. The canvas has to measure with the
     * same one, or the row fits labels that do not fit.
     */
    function refFamily(node) {
      if (!node || typeof window.getComputedStyle !== 'function') return labelFamily
      const family = window.getComputedStyle(node).fontFamily
      if (family && family !== labelFamily) labelFamily = family
      return labelFamily
    }

    /**
     * The width a branch label takes. The canvas measures the same font the
     * stylesheet gives the label, so a row knows before it draws whether the
     * label fits.
     */
    function refTextWidth(text, family, cap) {
      if (!labelCtx) {
        const canvas = document.createElement('canvas')
        labelCtx = canvas.getContext ? canvas.getContext('2d') : null
      }
      const ctx = labelCtx
      let measured = text.length * 6
      if (ctx) {
        const font = `500 11px ${family || 'system-ui, sans-serif'}`
        if (labelFont !== font) {
          ctx.font = font
          labelFont = font
        }
        measured = ctx.measureText(text).width
      }
      // The padding around the label text, plus a pixel of slack.
      const width = Math.ceil(measured) + 14
      return cap ? Math.min(width, cap) : width
    }

    /**
     * The value a commit is compared by. The date is compared as a moment, not
     * as text: two commits can carry different time zones, and their text
     * would order them wrong.
     */
    function logSortValue(entry, key) {
      if (key === 'date') {
        const parsed = Date.parse(String(entry?.date ?? ''))
        return Number.isNaN(parsed) ? 0 : parsed
      }
      if (key === 'author') {
        return `${String(entry?.author ?? '')} ${String(entry?.email ?? '')}`.trim().toLowerCase()
      }
      if (key === 'hash') return String(entry?.hash ?? '')
      return String(entry?.subject ?? '').toLowerCase()
    }

    /**
     * Order the log by one column. The plain history order (newest first) is
     * what the log already is, so it is returned untouched.
     * @param {object[]} list
     * @param {{ key: string, dir: string }} sort
     * @returns {object[]}
     */
    function sortLogEntries(list, sort) {
      if (!sort || !LOG_SORT_KEYS.includes(sort.key)) return list
      const dir = sort.dir === 'asc' ? 1 : -1
      return [...list].sort((a, b) => {
        const left = logSortValue(a, sort.key)
        const right = logSortValue(b, sort.key)
        if (left === right) return 0
        return (left < right ? -1 : 1) * dir
      })
    }

    /**
     * The commit graph draws history: a lane means "this commit is the parent
     * of that one". Once the list is sorted by anything else the lanes would
     * lie, so the graph is only drawn in the history order.
     */
    function logGraphVisible(sort) {
      return !sort || sort.key === 'date' && sort.dir === 'desc'
    }

    /** Describe why the sequencer is still paused, in the user's language. */
    function pauseMessage(result) {
      const count = result?.conflicts ?? 0
      if (count > 0) return tt('rebase.paused', { count })
      if (result?.empty === true) return tt('rebase.emptyPaused')
      return tt('rebase.pausedPlain')
    }

    /**
     * Pane-level error rendering. "Not a git repository" is an everyday state
     * (a notes folder, a freshly added workspace), so it gets the calm empty
     * view with the path; everything else is an actual failure and stays a
     * red row — but always in the user's language, never git's raw stderr.
     */
    /**
     * A folder without a repository is an everyday state, and the next step
     * belongs here rather than in a terminal. JetBrains offers "Create Git
     * Repository" in this exact spot; the button only appears while the pane
     * is in this state, so it cannot be clicked over an existing repo.
     */
    function NoRepoState({ dir, onInit }) {
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState('')
      const init = async () => {
        if (busy) return
        setBusy(true)
        setFailed('')
        try {
          const result = await Api.initRepo(dir)
          showToast(tt(result?.already === true ? 'repo.initExists' : 'repo.initDone'))
          await onInit?.()
        } catch (error) {
          setFailed(localizeError(error))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'gwb-body-empty' },
        h(
          'div',
          { className: 'gwb-empty-state' },
          h('span', { className: 'gwb-empty-icon' }, h(GitIcons.branch)),
          h('span', null, tt('repo.notGit')),
          dir ? h('span', { className: 'gwb-empty-hint' }, dir) : null,
          h('span', { className: 'gwb-empty-hint' }, tt('repo.notGitHint')),
          h(
            'button',
            { className: 'gwb-btn primary', disabled: busy, onClick: () => void init() },
            busy ? tt('repo.initBusy') : tt('repo.init'),
          ),
          failed ? h('span', { className: 'gwb-empty-error' }, failed) : null,
        ),
      )
    }

    function gitErrorView(cause, dir, onInit) {
      const message = String(cause?.message ?? cause ?? '')
      if (/not a git repository/i.test(message)) {
        return h(NoRepoState, { dir, onInit })
      }
      return h('div', { className: 'gwb-error' }, localizeError(cause))
    }

    function computeGraph(entries) {
      const lanes = []
      const rows = []
      for (const entry of entries) {
        let lane = lanes.indexOf(entry.hash)
        if (lane === -1) {
          lane = lanes.indexOf(null)
          if (lane === -1) {
            lane = lanes.length
            lanes.push(entry.hash)
          } else {
            lanes[lane] = entry.hash
          }
        }
        const before = lanes.slice()
        const edges = []
        const parents = entry.parents
        if (parents.length === 0) {
          lanes[lane] = null
        } else {
          lanes[lane] = parents[0]
          for (const parent of parents.slice(1)) {
            let target = lanes.indexOf(parent)
            if (target === -1) {
              target = lanes.indexOf(null)
              if (target === -1) {
                lanes.push(parent)
                target = lanes.length - 1
              } else {
                lanes[target] = parent
              }
            }
            edges.push({ from: lane, to: target })
          }
        }
        const after = lanes.slice()
        while (after.length > 0 && after[after.length - 1] === null) after.pop()
        rows.push({ lane, before, after, edges })
      }
      const width = Math.max(2, ...rows.map((row) => Math.max(row.before.length, row.after.length)))
      for (const row of rows) row.width = width
      return rows
    }

    /**
     * Commit-graph lane colours. Six lanes, all derived from the host palette so
     * the graph reads as part of the app instead of an imported rainbow.
     */
    const LANE_COLORS = [
      'var(--dsw-alias-state-business-primary, #4176e6)',
      'var(--dsw-alias-state-success-primary, #22c55e)',
      'var(--dsw-alias-state-warn-primary, #dd8629)',
      'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 55%, var(--dsw-alias-state-success-primary, #22c55e))',
      'color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 55%, var(--dsw-alias-state-warn-primary, #dd8629))',
      'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 55%, var(--dsw-alias-state-warn-primary, #dd8629))',
    ]

    function GraphSvg({ row }) {
      const step = 12
      const height = 26
      const x = (lane) => 8 + lane * step
      const children = []
      for (let lane = 0; lane < row.before.length; lane += 1) {
        if (row.before[lane] === null) continue
        const continues = row.after[lane] !== null && row.after[lane] !== undefined
        children.push(
          h('line', { key: `l${lane}`, x1: x(lane), y1: 0, x2: x(lane), y2: continues ? height : height / 2, stroke: LANE_COLORS[lane % 6], strokeWidth: 1.4, opacity: 0.85 }),
        )
      }
      for (const edge of row.edges) {
        children.push(
          h('path', {
            key: `e${edge.from}-${edge.to}`,
            d: `M${x(edge.from)},${height / 2} C${x(edge.from)},${height} ${x(edge.to)},${height / 2} ${x(edge.to)},${height}`,
            fill: 'none',
            stroke: LANE_COLORS[edge.to % 6],
            strokeWidth: 1.4,
            opacity: 0.85,
          }),
        )
      }
      children.push(h('circle', { key: 'dot', cx: x(row.lane), cy: height / 2, r: 3.2, fill: LANE_COLORS[row.lane % 6] }))
      const width = Math.max(row.width * step + 8, 20)
      return h('svg', { width, height, viewBox: `0 0 ${width} ${height}` }, children)
    }

    /* ------------------------------------------------------------ panes: commit */

    const CHECK_SELECTION_KEY = 'dsh-git.checks.v1'

    /** Picked check scripts per repository root; unknown names are filtered on load. */
    function readCheckSelection(root) {
      try {
        const table = JSON.parse(localStorage.getItem(CHECK_SELECTION_KEY) ?? '{}')
        const value = table?.[root]
        return Array.isArray(value) ? value.filter((name) => typeof name === 'string') : []
      } catch {
        return []
      }
    }

    function saveCheckSelection(root, names) {
      try {
        const table = JSON.parse(localStorage.getItem(CHECK_SELECTION_KEY) ?? '{}')
        table[root] = names
        localStorage.setItem(CHECK_SELECTION_KEY, JSON.stringify(table))
      } catch {
        /* storage unavailable: the selection still works for this session */
      }
    }

    const CHANGELIST_KEY = 'dsh-git.changelists.v1'

    /**
     * Changelists organise the work, they are not repository state: they live
     * in the browser, one map per repository root. The default list holds every
     * file that was not moved into a named one.
     * @returns {{ id: string, name: string, paths: string[] }[]}
     */
    function readChangelists(root) {
      try {
        const table = JSON.parse(localStorage.getItem(CHANGELIST_KEY) ?? '{}')
        const value = table?.[root]
        if (!Array.isArray(value)) return []
        return value
          .filter((list) => list && typeof list.name === 'string' && Array.isArray(list.paths))
          .map((list) => ({
            id: String(list.id ?? list.name),
            name: list.name,
            paths: list.paths.filter((item) => typeof item === 'string'),
          }))
      } catch {
        return []
      }
    }

    function saveChangelists(root, lists) {
      try {
        const table = JSON.parse(localStorage.getItem(CHANGELIST_KEY) ?? '{}')
        table[root] = lists
        localStorage.setItem(CHANGELIST_KEY, JSON.stringify(table))
      } catch {
        /* storage unavailable: the grouping still works for this session */
      }
    }

    function CommitPane(props) {
      const dir = useSessionDirectory(props)
      const dirRef = useRef(dir)
      dirRef.current = dir
      const loadSeq = useRef(0)
      const logSeq = useRef(0)
      const [info, setInfo] = useState(null)
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      const [amend, setAmend] = useState(false)
      const [expanded, setExpanded] = useState({ conflicts: true })
      const [log, setLog] = useState([])
      const [aiBusy, setAiBusy] = useState(false)
      const [checks, setChecks] = useState(null)
      const [pickedChecks, setPickedChecks] = useState([])
      const [checking, setChecking] = useState(null)
      const [checkResults, setCheckResults] = useState({})
      const [changelists, setChangelists] = useState([])
      const checksSeq = useRef(0)
      const listMode = useListMode()
      const [folders, setFolders] = useState({})
      const textareaRef = useRef(null)
      const rootRef = useRef(null)
      useCompact(rootRef)
      const selectedChecks = (checks?.scripts ?? []).filter((item) => pickedChecks.includes(item.name))

      // JetBrains lets 空提交框 ↑ 召回上一条提交信息。at 是走到第几条，draft 是
      // 进召回前用户写的内容；只有光标停在开头才响应方向键——那意味着"我在翻历史"
      // 而不是"我在改字"。
      const recall = useRef({ at: -1, draft: '' })
      const recallMessage = (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        const el = event.currentTarget
        if (el.selectionStart !== 0 || el.selectionEnd !== 0) return
        const state = recall.current
        if (log.length === 0) { void loadLog(); return }
        if (state.at < 0) {
          if (event.key === 'ArrowDown' || message.trim() !== '') return
          state.draft = message
          state.at = 0
        } else if (event.key === 'ArrowUp') {
          state.at = Math.min(state.at + 1, log.length - 1)
        } else {
          state.at -= 1
        }
        event.preventDefault()
        const back = state.at
        setMessage(back < 0 ? state.draft : log[back]?.subject ?? '')
        if (back < 0) recall.current = { at: -1, draft: '' }
        // React rewrites value on the next render; put the caret back at the
        // start so one more ↑ keeps walking instead of landing mid-text.
        requestAnimationFrame(() => {
          const box = textareaRef.current
          if (box) { box.focus(); box.setSelectionRange(0, 0) }
        })
      }

      const load = useCallback(async () => {
        const wanted = dir
        const seq = ++loadSeq.current
        if (!wanted) return
        try {
          const [i, s] = await Promise.all([Api.info(wanted), Api.status(wanted)])
          if (seq !== loadSeq.current || dirRef.current !== wanted) return
          setInfo(i)
          setStatus(s)
          setError(null)
        } catch (cause) {
          if (seq !== loadSeq.current || dirRef.current !== wanted) return
          setError(cause)
          setStatus(null)
        }
      }, [dir])

      const loadLog = useCallback(async () => {
        const wanted = dir
        const seq = ++logSeq.current
        if (!wanted) {
          setLog([])
          return
        }
        try {
          const entries = await Api.log(wanted)
          if (seq !== logSeq.current || dirRef.current !== wanted) return
          setLog(Array.isArray(entries) ? entries : [])
        } catch {
          if (seq === logSeq.current && dirRef.current === wanted) setLog([])
        }
      }, [dir])

      const loadChecks = useCallback(async () => {
        const wanted = dir
        const seq = ++checksSeq.current
        if (!wanted) return
        try {
          const found = await Api.checks(wanted)
          if (seq !== checksSeq.current || dirRef.current !== wanted) return
          setChecks(found)
          const available = new Set((found?.scripts ?? []).map((item) => item.name))
          setPickedChecks(readCheckSelection(found.root).filter((name) => available.has(name)))
        } catch {
          if (seq !== checksSeq.current || dirRef.current !== wanted) return
          setChecks(null)
          setPickedChecks([])
        }
      }, [dir])

      useEffect(() => {
        // A new session/repo must never paint the previous repository's state.
        setInfo(null)
        setStatus(null)
        setError(null)
        setLog([])
        setMessage('')
        setAmend(false)
        setFolders({})
        setChecks(null)
        setPickedChecks([])
        setChecking(null)
        setCheckResults({})
        void load()
        void loadLog()
        void loadChecks()
      }, [load, loadLog, loadChecks])

      // The change feed (SSE from the server's .git watcher, 3s revision poll
      // as backup) drives refresh; a timer poll would only add git calls.
      useRepoChanges(dir, load)

      async function reloadAll() {
        await load()
        await loadLog()
      }

      async function move(direction, files) {
        if (busy || files.length === 0) return
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        setBusy(true)
        try {
          await Api.stage(dir, { files, direction })
          await load()
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      function toggleCheck(name) {
        if (!checks?.root) return
        const next = pickedChecks.includes(name)
          ? pickedChecks.filter((value) => value !== name)
          : [...pickedChecks, name]
        setPickedChecks(next)
        saveCheckSelection(checks.root, next)
      }

      /**
       * Run the picked scripts in package.json order. A failure opens the
       * output dialog; `manual` runs are reports only, while a commit flow
       * returns `proceed:true` solely when the user explicitly overrides.
       * @param {string[]} names
       * @param {boolean} manual
       */
      async function executeChecks(names, manual) {
        const results = []
        for (let index = 0; index < names.length; index += 1) {
          setChecking({ name: names[index], index: index + 1, total: names.length })
          let result
          try {
            result = await Api.runCheck(dir, names[index])
          } catch (cause) {
            setChecking(null)
            reportError(cause)
            return { ok: false, proceed: false }
          }
          setCheckResults((previous) => ({ ...previous, [result.script]: result }))
          results.push(result)
          if (!result.ok) {
            setChecking(null)
            const proceed = await showCheckFailure({
              result,
              results,
              okLabel: manual ? '' : tt('checks.commitAnyway'),
              danger: !manual,
            })
            return { ok: false, proceed: manual ? false : proceed }
          }
        }
        setChecking(null)
        if (manual) showToast(tt('checks.passed', { count: names.length }))
        return { ok: true, proceed: true }
      }

      async function runChecksNow() {
        if (busy || checking || selectedChecks.length === 0) return
        setBusy(true)
        try {
          await executeChecks(selectedChecks.map((item) => item.name), true)
        } finally {
          setBusy(false)
        }
      }

      /** Commit first; push only when the commit actually landed. */
      async function commitThenPush(force) {
        if (busy) return
        if (force) {
          const confirmed = await showConfirm(tt('commit.forceConfirm'), { ok: tt('confirm.forcePush'), danger: true })
          if (!confirmed) return
        }
        const committed = await commitNow()
        if (!committed) return
        try {
          showToast(await runNetOp(dir, 'push', undefined, { force }))
          await reloadAll()
        } catch (cause) {
          reportError(cause)
        }
      }

      /** A commit git refused for want of `user.name` / `user.email`. */
      function missingIdentity(cause) {
        return /git identity is not configured|Author identity unknown|unable to auto-detect email address/i.test(String(cause?.message ?? cause))
      }

      /** Collect the identity git asked for, write it, and say whether to retry. */
      async function ensureIdentity() {
        const known = await Api.identity(dir).catch(() => null)
        const identity = await showIdentityDialog({
          name: known?.name ?? '',
          email: known?.email ?? '',
          scope: known?.configured === true ? known.scope : 'local',
        })
        if (!identity) return false
        try {
          await Api.saveIdentity(dir, identity)
          return true
        } catch (cause) {
          reportError(cause)
          return false
        }
      }

      /** @returns {Promise<boolean>} whether a commit was created */
      async function commitNow(retried = false) {
        if (busy) return false
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return false
        }
        if (status?.operation && status.operation !== 'merge') {
          showToast(tt('commit.useContinue'), true)
          return false
        }
        const text = message.trim()
        if (text === '') {
          showToast(tt('commit.need'), true)
          textareaRef.current?.focus()
          return false
        }
        if (stagedCount === 0 && status?.merging !== true && (!amend || info?.unborn === true)) {
          showToast(tt('commit.empty'), true)
          return false
        }
        setBusy(true)
        let needsIdentity = false
        try {
          // Checks belong inside the busy section: the button must not offer a
          // second commit while tests are still running.
          if (selectedChecks.length > 0) {
            const outcome = await executeChecks(selectedChecks.map((item) => item.name), false)
            if (!outcome.proceed) return false
          }
          const result = await Api.commit(dir, { message: text, amend })
          if (!result?.ok || !result.hash) throw new Error(tt('commit.failed'))
          setMessage('')
          setAmend(false)
          showToast(tt('commit.done', { hash: String(result.hash).slice(0, 8) }))
          await reloadAll()
          return true
        } catch (cause) {
          if (missingIdentity(cause) && !retried) {
            needsIdentity = true
          } else {
            reportError(cause)
            return false
          }
        } finally {
          setBusy(false)
        }
        // Git refused before touching the index, so asking for the identity and
        // retrying cannot commit anything twice.
        if (!needsIdentity || !(await ensureIdentity())) return false
        return commitNow(true)
      }

      /* ---------------------------------------------------------- changelists */

      // JetBrains groups the pending changes into changelists, each with its
      // own commit. The grouping lives in the browser: it organises the work,
      // it does not change the repository.
      const changelistRoot = info?.root ?? dir ?? ''

      useEffect(() => {
        setChangelists(readChangelists(changelistRoot))
      }, [changelistRoot])

      const persistChangelists = (next) => {
        // A path that is no longer pending has nothing to group: committed
        // or reverted files leave their changelist behind.
        const alive = status?.files ? new Set(status.files.map((file) => file.path)) : null
        const clean = alive
          ? next.map((list) => ({ ...list, paths: list.paths.filter((path) => alive.has(path)) }))
          : next
        setChangelists(clean)
        saveChangelists(changelistRoot, clean)
      }

      const ownerOf = new Map()
      for (const list of changelists) for (const path of list.paths) ownerOf.set(path, list.id)
      const listIdOf = (path) => ownerOf.get(path) ?? 'default'

      const moveToList = (paths, listId) => {
        const wanted = [...paths]
        const next = changelists.map((list) => ({
          ...list,
          paths: list.paths.filter((path) => !wanted.includes(path)),
        }))
        const target = next.find((list) => list.id === listId)
        if (target) target.paths = [...target.paths, ...wanted]
        persistChangelists(next)
        const name = listId === 'default' ? tt('changelist.default') : target?.name ?? ''
        showToast(tt('changelist.moved', { count: wanted.length, name }))
      }

      const createChangelist = (name, paths = []) => {
        const id = `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const next = [
          ...changelists.map((list) => ({ ...list, paths: list.paths.filter((path) => !paths.includes(path)) })),
          { id, name, paths: [...paths] },
        ]
        persistChangelists(next)
        return id
      }

      const renameChangelist = (id, name) =>
        persistChangelists(changelists.map((list) => (list.id === id ? { ...list, name } : list)))

      async function deleteChangelist(id) {
        const target = changelists.find((list) => list.id === id)
        if (!target) return
        const confirmed = await showConfirm(tt('changelist.deleteConfirm', { name: target.name }), {
          ok: tt('changelist.delete'),
          danger: true,
        })
        if (!confirmed) return
        persistChangelists(changelists.filter((list) => list.id !== id))
        showToast(tt('changelist.deleted', { name: target.name }))
      }

      /** Pick the changelist a file belongs to, or make a new one on the spot. */
      function openChangelistPicker(x, y, paths) {
        openContextMenu(
          x,
          y,
          [
            {
              iconSvg: iconMarkup('changelist', 13),
              label: tt('changelist.default'),
              onClick: () => moveToList(paths, 'default'),
            },
            ...changelists.map((list) => ({
              iconSvg: iconMarkup('changelist', 13),
              label: list.name,
              onClick: () => moveToList(paths, list.id),
            })),
            { sep: true },
            {
              iconSvg: iconMarkup('plus', 13),
              label: tt('changelist.create'),
              onClick: () =>
                openNamePrompt(
                  x,
                  y,
                  tt('changelist.createTitle'),
                  tt('changelist.name'),
                  (name) => {
                    createChangelist(name, paths)
                    showToast(tt('changelist.moved', { count: paths.length, name }))
                  },
                  '',
                  tt('prompt.create'),
                ),
            },
          ],
          { width: 220 },
        )
      }

      /** Commit the staged files of one changelist; the rest stays staged. */
      async function commitChangelist(list, retried = false) {
        if (busy) return
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        if (status?.operation) {
          showToast(tt('commit.useContinue'), true)
          return
        }
        if (conflicts.length > 0) {
          showToast(tt('changelist.conflictFirst'), true)
          return
        }
        const text = message.trim()
        if (text === '') {
          showToast(tt('changelist.needMessage'), true)
          textareaRef.current?.focus()
          return
        }
        const paths = (status?.files ?? [])
          .filter((file) => file.staged && listIdOf(file.path) === list.id)
          .map((file) => file.path)
        if (paths.length === 0) {
          showToast(tt('changelist.nothingStaged'), true)
          return
        }
        setBusy(true)
        let needsIdentity = false
        try {
          if (selectedChecks.length > 0) {
            const outcome = await executeChecks(selectedChecks.map((item) => item.name), false)
            if (!outcome.proceed) return
          }
          const result = await Api.commitPaths(dir, paths, text)
          if (!result?.ok || !result.hash) throw new Error(tt('commit.failed'))
          setMessage('')
          showToast(tt('changelist.committed', { name: list.name }))
          await reloadAll()
        } catch (cause) {
          if (missingIdentity(cause) && !retried) needsIdentity = true
          else reportError(cause)
        } finally {
          setBusy(false)
        }
        if (!needsIdentity || !(await ensureIdentity())) return
        await commitChangelist(list, true)
      }

      /** Amend pre-fills the current HEAD message, like the IDE. */
      async function toggleAmend(next) {
        setAmend(next)
        if (!next || message.trim() !== '' || info?.unborn === true) return
        const wanted = dir
        try {
          const head = await Api.commitMessage(wanted)
          if (dirRef.current !== wanted || typeof head?.message !== 'string') return
          setMessage((previous) => (previous.trim() === '' ? head.message : previous))
        } catch (cause) {
          reportError(cause)
        }
      }

      async function generateMessage() {
        if (aiBusy) return
        setAiBusy(true)
        try {
          const preferred = config().commitLanguage
          const language = preferred === 'zh' || preferred === 'en' ? preferred : isZh() ? 'zh' : 'en'
          const result = await Api.draftMessage(dir, {
            language,
            provider: config().llmProvider || undefined,
            model: config().llmModel || undefined,
          })
          if (result.message) {
            setMessage(result.message)
            textareaRef.current?.focus()
          }
          showToast(result.source === 'model' ? tt('commit.aiBy', { model: result.model }) : result.warning ?? tt('commit.aiFallback'), result.source !== 'model')
        } catch (cause) {
          reportError(cause)
        } finally {
          setAiBusy(false)
        }
      }

      function toggleFolder(path) {
        setFolders((value) => ({ ...value, [path]: !(value[path] !== false) }))
      }

      async function checkout(name, create) {
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        try {
          await switchBranch(dir, name, create)
          showToast(tt(create ? 'toast.created' : 'toast.switched', { branch: name }))
          await reloadAll()
        } catch (cause) {
          reportError(cause)
        }
      }

      function openFileDiff(file) {
        openDiff(kit.ctx, { dir, file, source: 'working' })
      }

      /** A conflicted file opens the merge view, the way the IDE does. */
      function openMergeDiff(file) {
        openDiff(kit.ctx, { dir, file, source: 'working', mode: 'merge' })
      }

      /** JetBrains "Rollback": throw away the uncommitted changes of these paths. */
      async function discardFiles(files) {
        if (busy || files.length === 0) return
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        if (!(await showConfirm(tt('ctx.discardConfirm', { count: files.length }), { ok: tt('confirm.discard'), danger: true }))) return
        setBusy(true)
        try {
          await Api.rollback(dir, { files })
          showToast(tt('ctx.discardDone', { count: files.length }))
          await load()
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      /** Leaving a paused sequencer must be one click, not a terminal. */
      async function abortOperation(operation) {
        if (busy || !operation) return
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        const name = tt(`opName.${operation}`)
        if (!(await showConfirm(tt('op.abortConfirm', { opName: name }), { ok: tt('confirm.abort'), danger: true }))) return
        setBusy(true)
        try {
          await Api.abort(dir)
          await load()
          showToast(tt('op.aborted', { opName: name }))
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      /** Resume a paused sequencer once its conflicts are resolved and staged. */
      async function resumeOperation(operation) {
        if (busy || !operation || operation === 'merge') return
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        setBusy(true)
        try {
          const result = await Api.continueOperation(dir)
          if (result?.paused === true) {
            showToast(pauseMessage(result), (result.conflicts ?? 0) > 0)
          } else {
            showToast(tt('op.continueDone', { opName: tt(`opName.${operation}`) }))
          }
          await reloadAll()
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      /** JetBrains offers this on unversioned files; here it writes the repo's own .gitignore. */
      async function ignoreFiles(files) {
        if (busy || files.length === 0) return
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        setBusy(true)
        try {
          const result = await Api.ignore(dir, files)
          showToast(result.added === 0 ? tt('ignore.already') : tt('ignore.done', { count: result.added }))
          await load()
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      async function resolveFile(file, strategy) {
        if (busy) return
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        if (strategy !== 'mark' && strategy !== 'both') {
          // "Accept both" keeps every line, so it needs no confirmation.
          const side = tt(strategy === 'ours' ? 'conflict.oursSide' : 'conflict.theirsSide')
          if (!(await showConfirm(tt('conflict.takeConfirm', { side }), { ok: tt('confirm.takeSide', { side }), danger: true }))) return
        }
        setBusy(true)
        try {
          await Api.resolve(dir, { file: file.path, strategy })
          showToast(tt('conflict.marked', { file: baseName(file.path) }))
          await load()
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      async function resolveAllConflicts(conflictFiles) {
        if (busy || conflictFiles.length === 0) return
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        if (!(await showConfirm(tt('conflict.markAllConfirm', { count: conflictFiles.length }), { ok: tt('confirm.markResolved'), danger: true }))) return
        setBusy(true)
        try {
          for (const file of conflictFiles) await Api.resolve(dir, { file: file.path, strategy: 'mark' })
          showToast(tt('conflict.allMarked', { count: conflictFiles.length }))
          await load()
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      function resolveMenu(x, y, file) {
        const entries = [
          { iconSvg: iconMarkup('merge', 13), label: tt('merge.open'), onClick: () => openMergeDiff(file.path) },
          { iconSvg: iconMarkup('diff', 13), label: tt('ctx.openDiff'), onClick: () => openFileDiff(file.path) },
        ]
        if (config().readOnly !== true) {
          entries.push(
            { sep: true },
            { iconSvg: iconMarkup('check', 13), label: tt('conflict.mark'), onClick: () => void resolveFile(file, 'mark') },
            { iconSvg: iconMarkup('chevLeft', 13), label: tt('conflict.ours'), onClick: () => void resolveFile(file, 'ours') },
            { iconSvg: iconMarkup('chevRight', 13), label: tt('conflict.theirs'), onClick: () => void resolveFile(file, 'theirs') },
            { iconSvg: iconMarkup('merge', 13), label: tt('merge.takeBoth'), onClick: () => void resolveFile(file, 'both') },
          )
        }
        entries.push(
          { sep: true },
          {
            iconSvg: iconMarkup('copy', 13),
            label: tt('ctx.copyPath'),
            onClick: () => {
              copyText(file.path)
              showToast(tt('ctx.copied'))
            },
          },
        )
        openContextMenu(x, y, entries)
      }

      const files = status?.files ?? []
      const conflicts = files.filter((file) => file.kind === 'conflicted')
      const staged = files.filter((file) => file.staged)
      const stagedPaths = new Set(staged.map((file) => file.path))
      const total = new Set(files.map((file) => file.path)).size

      function groupBlock(key, label, groupFiles, action) {
        if (groupFiles.length === 0) return null
        const open = expanded[key] !== false
        const fileEl = (file, depth) =>
          h(
            'div',
            {
              key: file.path,
              className: 'gwb-file',
              title: file.path,
              style: { paddingLeft: 8 + depth * 12 },
              onClick: () => openFileDiff(file.path),
              onContextMenu: (event) => {
                event.preventDefault()
                const stagedNow = file.staged === true
                const at = { x: event.clientX, y: event.clientY }
                openContextMenu(at.x, at.y, [
                  { iconSvg: iconMarkup('diff', 13), label: tt('ctx.openDiff'), onClick: () => openFileDiff(file.path) },
                  {
                    iconSvg: iconMarkup('history', 13),
                    label: tt('ctx.fileHistory'),
                    onClick: () => {
                      fileHistoryStore.set(file.path)
                      openTab(kit.ctx, LOG_KIND)
                    },
                  },
                  // Grouping is an organisation of the work, not a change to
                  // the repository: it stays available in read-only mode.
                  {
                    iconSvg: iconMarkup('changelist', 13),
                    label: tt('changelist.move'),
                    onClick: () => openChangelistPicker(at.x, at.y, [file.path]),
                  },
                  ...(config().readOnly === true
                    ? []
                    : [
                        {
                          iconSvg: iconMarkup(stagedNow ? 'chevDown' : 'chevUp', 13),
                          label: tt(stagedNow ? 'ctx.unstage' : 'ctx.stage'),
                          onClick: () => void move(stagedNow ? 'unstage' : 'stage', [file.path]),
                        },
                        {
                          iconSvg: iconMarkup('rollback', 13),
                          label: tt('ctx.discard'),
                          danger: true,
                          onClick: () => void discardFiles([file.path]),
                        },
                        file.kind === 'untracked'
                          ? {
                              iconSvg: iconMarkup('ignore', 13),
                              label: tt('ctx.ignore'),
                              onClick: () => void ignoreFiles([file.path]),
                            }
                          : null,
                        { sep: true },
                      ].filter(Boolean)),
                  {
                    iconSvg: iconMarkup('copy', 13),
                    label: tt('ctx.copyPath'),
                    onClick: () => {
                      copyText(file.path)
                      showToast(tt('ctx.copied'))
                    },
                  },
                ])
              },
            },
            config().readOnly === true
              ? null
              : h('input', {
                  type: 'checkbox',
                  checked: action === 'unstage',
                  title: tt(action === 'unstage' ? 'ctx.unstage' : 'ctx.stage'),
                  onClick: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void move(action === 'unstage' ? 'unstage' : 'stage', [file.path])
                  },
                  onChange: () => {},
                }),
            h(Badge, { kind: file.kind }),
            listMode === 'tree'
              ? h(FilePath, { path: file.path, hideDir: true, from: file.origPath, color: statusColor(file.kind) })
              : h(FilePath, { path: file.path, from: file.origPath, color: statusColor(file.kind) }),
            h(
              'span',
              { className: 'gwb-rowacts' },
              IconBtn({ title: tt('ctx.openDiff'), onClick: (event) => { event.stopPropagation(); openFileDiff(file.path) } }, h(GitIcons.diff)),
              config().readOnly === true
                ? null
                : IconBtn(
                    {
                      className: 'gwb-iconbtn danger',
                      title: tt('ctx.discard'),
                      onClick: (event) => {
                        event.stopPropagation()
                        void discardFiles([file.path])
                      },
                    },
                    h(GitIcons.rollback),
                  ),
            ),
          )

        const rows = open
          ? walkFileTree({
              files: groupFiles,
              listMode,
              folders,
              fileEl,
              folderEl: ({ folder, open: folderOpen, depth }) =>
                h(
                  'div',
                  {
                    key: `dir:${folder.path}`,
                    className: 'gwb-folder',
                    style: { paddingLeft: 8 + depth * 12 },
                    onClick: () => toggleFolder(folder.path),
                  },
                  config().readOnly === true
                    ? null
                    : h('input', {
                        type: 'checkbox',
                        checked: action === 'unstage',
                        title: tt(action === 'unstage' ? 'group.unstageAll' : 'group.stageAll'),
                        onClick: (event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void move(action === 'unstage' ? 'unstage' : 'stage', collectPaths(folder))
                        },
                        onChange: () => {},
                      }),
                  h('span', { className: 'gwb-glyph' }, h('span', { className: 'gwb-caret' }, folderOpen ? '▾' : '▸'), h(FolderIcon)),
                  h('span', { className: 'gwb-grow', title: folder.name }, folder.name),
                  h('span', { className: 'gwb-count' }, countFiles(folder)),
                ),
            })
          : null
        return h(
          React.Fragment,
          { key },
          h(
            'div',
            { className: 'gwb-group', onClick: () => setExpanded((value) => ({ ...value, [key]: !(value[key] !== false) })) },
            h('span', { className: 'gwb-caret' }, open ? '▾' : '▸'),
            h('span', null, label),
            h('span', { className: 'gwb-count' }, groupFiles.length),
            h('span', { className: 'gwb-spacer' }),
            config().readOnly === true ? null : h(
              'button',
              {
                className: 'gwb-link',
                onClick: (event) => {
                  event.stopPropagation()
                  void move(action === 'unstage' ? 'unstage' : 'stage', groupFiles.map((file) => file.path))
                },
              },
              tt(action === 'stage' ? 'group.stageAll' : 'group.unstageAll'),
            ),
          ),
          rows,
        )
      }

      /**
       * One changelist node: the files it owns, grouped the way the IDE does,
       * plus the commit action that takes only this list.
       */
      function changelistBlock(list, own) {
        const key = `cl:${list.id}`
        const open = expanded[key] !== false
        const listStaged = own.filter((file) => file.staged)
        const listUntracked = own.filter((file) => file.kind === 'untracked')
        const listUnstaged = own.filter(
          (file) => file.kind !== 'untracked' && file.kind !== 'conflicted' && file.unstaged,
        )
        return h(
          'div',
          { className: 'gwb-cl', key },
          h(
            'div',
            {
              className: 'gwb-cl-head',
              onClick: () => setExpanded((value) => ({ ...value, [key]: !(value[key] !== false) })),
            },
            h('span', { className: 'gwb-caret' }, open ? '▾' : '▸'),
            h('span', { className: 'gwb-cl-ico' }, h(GitIcons.changelist)),
            h('span', { className: 'gwb-cl-name', title: list.name }, list.name),
            h('span', { className: 'gwb-count' }, own.length),
            h('span', { className: 'gwb-spacer' }),
            config().readOnly === true || listStaged.length === 0
              ? null
              : h(
                  'button',
                  {
                    className: 'gwb-link',
                    title: tt('changelist.commit'),
                    onClick: (event) => {
                      event.stopPropagation()
                      void commitChangelist(list)
                    },
                  },
                  tt('changelist.commit'),
                ),
            list.id === 'default'
              ? null
              : IconBtn(
                  {
                    title: tt('changelist.rename'),
                    onClick: (event) => {
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      openContextMenu(rect.left, rect.bottom + 4, [
                        {
                          iconSvg: iconMarkup('rename', 13),
                          label: tt('changelist.rename'),
                          onClick: () =>
                            openNamePrompt(
                              rect.left,
                              rect.bottom + 4,
                              tt('changelist.rename'),
                              tt('changelist.name'),
                              (name) => renameChangelist(list.id, name),
                              list.name,
                              tt('prompt.rename'),
                            ),
                        },
                        { sep: true },
                        {
                          iconSvg: iconMarkup('trash', 13),
                          label: tt('changelist.delete'),
                          danger: true,
                          onClick: () => void deleteChangelist(list.id),
                        },
                      ])
                    },
                  },
                  h(GitIcons.more),
                ),
          ),
          open
            ? [
                groupBlock(`staged:${list.id}`, tt('group.staged'), listStaged, 'unstage'),
                groupBlock(`unstaged:${list.id}`, tt('group.unstaged'), listUnstaged, 'stage'),
                groupBlock(`untracked:${list.id}`, tt('group.untracked'), listUntracked, 'stage'),
              ]
            : null,
        )
      }

      /** The default list first, then the named ones; empty ones stay visible. */
      function changelistSections() {
        const lists = [
          { id: 'default', name: tt('changelist.default') },
          ...changelists.map((list) => ({ id: list.id, name: list.name })),
        ]
        const out = []
        for (const list of lists) {
          const own = files.filter((file) => listIdOf(file.path) === list.id)
          if (own.length === 0 && list.id === 'default') continue
          out.push(changelistBlock(list, own))
        }
        return out
      }

      function conflictBlock(groupFiles) {
        if (groupFiles.length === 0) return null
        const key = 'conflicts'
        const open = expanded[key] !== false
        const fileEl = (file, depth) =>
          h(
            'div',
            {
              key: file.path,
              className: 'gwb-file',
              title: file.path,
              style: { paddingLeft: 8 + depth * 12 },
              onClick: () => openMergeDiff(file.path),
              onContextMenu: (event) => {
                event.preventDefault()
                resolveMenu(event.clientX, event.clientY, file)
              },
            },
            h(Badge, { kind: file.kind }),
            listMode === 'tree'
              ? h(FilePath, { path: file.path, hideDir: true, from: file.origPath, color: statusColor(file.kind) })
              : h(FilePath, { path: file.path, from: file.origPath, color: statusColor(file.kind) }),
            h('span', { className: 'gwb-grow' }),
            config().readOnly === true
              ? null
              : [
                  IconBtn(
                    {
                      key: 'm',
                      className: 'gwb-iconbtn',
                      title: tt('merge.open'),
                      onClick: (event) => {
                        event.stopPropagation()
                        openMergeDiff(file.path)
                      },
                    },
                    h(GitIcons.merge, { size: 12 }),
                  ),
                  IconBtn(
                    {
                      key: 'ok',
                      className: 'gwb-iconbtn success',
                      title: tt('conflict.mark'),
                      onClick: (event) => {
                        event.stopPropagation()
                        void resolveFile(file, 'mark')
                      },
                    },
                    h(GitIcons.check, { size: 12 }),
                  ),
                ],
          )

        const rows = open
          ? walkFileTree({
              files: groupFiles,
              listMode,
              folders,
              fileEl,
              folderEl: ({ folder, open: folderOpen, depth }) =>
                h(
                  'div',
                  {
                    key: `dir:${folder.path}`,
                    className: 'gwb-folder',
                    style: { paddingLeft: 8 + depth * 12 },
                    onClick: () => toggleFolder(folder.path),
                  },
                  h('span', { className: 'gwb-glyph' }, h('span', { className: 'gwb-caret' }, folderOpen ? '▾' : '▸'), h(FolderIcon)),
                  h('span', { className: 'gwb-grow', title: folder.name }, folder.name),
                  h('span', { className: 'gwb-count' }, countFiles(folder)),
                ),
            })
          : null

        return h(
          React.Fragment,
          { key },
          h(
            'div',
            { className: 'gwb-group', onClick: () => setExpanded((value) => ({ ...value, [key]: !(value[key] !== false) })) },
            h('span', { className: 'gwb-caret' }, open ? '▾' : '▸'),
            h('span', null, tt('group.conflicts')),
            h('span', { className: 'gwb-count' }, groupFiles.length),
            h('span', { className: 'gwb-spacer' }),
            config().readOnly === true
              ? null
              : h(
                  'button',
                  {
                    className: 'gwb-link',
                    onClick: (event) => {
                      event.stopPropagation()
                      void resolveAllConflicts(groupFiles)
                    },
                  },
                  tt('conflict.markAll'),
                ),
          ),
          rows,
        )
      }

      const stagedCount = stagedPaths.size
      const subjectLen = message.split('\n')[0].length
      // A paused sequencer owns the next commit: continuing it is what turns the
      // staged resolution into the replayed commit. Letting the commit bar fire
      // here would strand the rebase midway with an unrelated commit on top.
      const sequencer = status?.operation && status.operation !== 'merge' ? status.operation : ''
      const canCommit = sequencer === '' && (stagedCount > 0 || status?.merging === true || (amend && info?.unborn !== true)) && conflicts.length === 0
      const checkRuns = selectedChecks.map((item) => checkResults[item.name]).filter(Boolean)
      const checkState = checking
        ? 'running'
        : checkRuns.some((item) => !item.ok)
          ? 'fail'
          : checkRuns.length > 0
            ? 'pass'
            : ''
      // A folder without a repository is an everyday state, not a failure: the
      // branch chip, the status pill row and the commit box would all promise
      // something this pane cannot deliver.
      const noRepo = /not a git repository/i.test(String(error?.message ?? error ?? ''))

      if (!dir) {
        return h(
          'div',
          { className: 'gwb', ref: rootRef, tabIndex: -1 },
          h('div', { className: 'gwb-head' }, h('span', { className: 'gwb-title' }, tt('tab.commit'))),
          h('div', { className: 'gwb-body' }, h('div', { className: 'gwb-empty' }, tt('repo.unbound'))),
        )
      }

      return h(
        'div',
        {
          className: 'gwb',
          ref: rootRef,
          tabIndex: -1,
          'data-norepo': noRepo ? '1' : undefined,
          onKeyDown: (event) => {
            if (event.key === 'F5') {
              event.preventDefault()
              void reloadAll()
            } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              void commitNow()
            } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
              event.preventDefault()
              void generateMessage()
            } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
              event.preventDefault()
              textareaRef.current?.focus()
            }
          },
        },
        h(
          'div',
          { className: 'gwb-head' },
          h(
            'span',
            { className: 'gwb-repo', title: info?.root ?? dir },
            h(GitIcons.repo),
            h('span', { className: 'gwb-repo-name' }, info?.name ?? baseName(dir)),
          ),
          // Mounting the menu before the first status answer makes it fetch
          // branches for a folder we do not yet know is a repo, and renders a
          // "—" chip for a beat. Wait for the answer instead.
          noRepo || status === null
            ? null
            : h(GitOperationsMenu, { dir, button: (branch, status, busy) => h(
            'button',
            {
              className: 'gwb-chip',
              'aria-busy': busy ? '1' : undefined,
              title: busy
                ? busyLabel(busy)
                : status?.upstream
                  ? tt('chip.tracking', { upstream: status.upstream })
                  : undefined,
            },
            h('span', { style: { display: 'inline-flex', alignItems: 'center' } }, h(GitIcons.branch)),
            h('span', { className: 'gwb-chip-label' }, busy ? busyLabel(busy) : branch),
            // The divergence belongs next to the branch name: the IDE shows it
            // there, and a tooltip alone hides the one number a push would fix.
            busy || !status?.upstream
              ? null
              : h(
                'span',
                { className: 'gwb-chip-deltas' },
                status.ahead
                  ? h('span', { className: 'gwb-chip-delta ahead', title: tt('chip.ahead', { n: status.ahead }) }, `↑${status.ahead}`)
                  : null,
                status.behind
                  ? h('span', { className: 'gwb-chip-delta behind', title: tt('chip.behind', { n: status.behind }) }, `↓${status.behind}`)
                  : null,
              ),
            h('span', { className: 'gwb-caret' }, '▾'),
          ), onDone: () => void load() }),
          // The session branch action, one click away instead of buried in a menu.
          noRepo || status === null || config().readOnly === true
            ? null
            : IconBtn(
                {
                  title: tt('branch.session'),
                  onClick: (event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    openNamePrompt(rect.left, rect.bottom + 4, tt('branch.sessionTitle'), tt('ctx.branchName'), (name) =>
                      void checkout(name, true),
                      sessionBranchName(info?.name ?? ''), tt('prompt.create'),
                    )
                  },
                },
                h(GitIcons.plus),
              ),
          h('span', { style: { flex: 1 } }),
          IconBtn({ title: tt('repo.refresh'), onClick: () => void reloadAll() }, h(GitIcons.reload, { size: 13 })),
        ),
        h(
          'div',
          { className: 'gwb-pillrow' },
          h(
            'span',
            { className: 'gwb-chip-meta' },
            total === 0
              ? status?.operation
                ? ''
                : tt('pill.clean', { files: 0, staged: 0 })
              : tt('pill.summary', { files: total, staged: stagedCount }),
          ),
          // A paused sequencer gets a persistent status chip: the file list can
          // scroll the hint out of view, but the way out must never move.
          status?.operation
            ? h(
                'span',
                { className: `gwb-opchip${conflicts.length > 0 ? ' conflict' : ''}` },
                h(
                  'span',
                  { className: 'gwb-opchip-label' },
                  // A rebase can pause with no conflicts (an empty pick); the
                  // Continue button already says what to do next, and "ready to
                  // commit" would describe a merge instead.
                  `${tt(`op.${status.operation}`)}${
                    conflicts.length > 0
                      ? ` · ${tt('op.conflicts', { count: conflicts.length })}`
                      : status.operation === 'rebase'
                        ? ''
                        : ` · ${tt('op.pendingCommit')}`
                  }`,
                ),
                config().readOnly === true
                  ? null
                  : [
                      // A merge finishes with a commit, not `--continue`, so it
                      // only gets the exit.
                      status.operation === 'merge'
                        ? null
                        : h(
                            'button',
                            {
                              key: 'continue',
                              className: 'gwb-link',
                              disabled: busy || conflicts.length > 0,
                              title: conflicts.length > 0 ? tt('op.resolveFirst') : tt('op.continue'),
                              onClick: () => void resumeOperation(status.operation),
                            },
                            tt('op.continue'),
                          ),
                      h(
                        'button',
                        {
                          key: 'abort',
                          className: 'gwb-link abort',
                          disabled: busy,
                          title: tt('op.abort'),
                          onClick: () => void abortOperation(status.operation),
                        },
                        tt('op.abort'),
                      ),
                    ],
              )
            : null,
          h('span', { style: { flex: 1 } }),
          // JetBrains keeps the "new changelist" action in the panel toolbar.
          IconBtn(
            {
              title: tt('changelist.create'),
              onClick: (event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                openNamePrompt(
                  rect.left,
                  rect.bottom + 4,
                  tt('changelist.createTitle'),
                  tt('changelist.name'),
                  (name) => createChangelist(name),
                  '',
                  tt('prompt.create'),
                )
              },
            },
            h(GitIcons.changelistNew, { size: 13 }),
          ),
          h(
            'div',
            { className: 'gwb-seg' },
            h('button', { className: `gwb-mini${listMode === 'flat' ? ' on' : ''}`, title: tt('list.flat'), onClick: () => listModeStore.set('flat') }, tt('list.flat')),
            h('button', { className: `gwb-mini${listMode === 'tree' ? ' on' : ''}`, title: tt('list.tree'), onClick: () => listModeStore.set('tree') }, tt('list.tree')),
          ),
        ),
        h(
          'div',
          { className: 'gwb-body' },
          error
            ? gitErrorView(error, dir, () => void reloadAll())
            : status === null
              ? h('div', { className: 'gwb-body-empty' }, h('div', { className: 'gwb-loading' }, tt('group.reading')))
              : total === 0
                ? h(
                    'div',
                    { className: 'gwb-body-empty' },
                    h(
                      'div',
                      { className: 'gwb-empty-state' },
                      h(
                        'span',
                        { className: 'gwb-empty-icon' },
                        h(status?.merging === true ? GitIcons.branch : GitIcons.check),
                      ),
                      h('span', null, tt(status?.merging === true ? 'merge.inProgress' : 'group.clean')),
                    ),
                  )
                : [
                    conflictBlock(conflicts),
                    ...changelistSections(),
                  ],
        ),
        h(
          'div',
          { className: 'gwb-commitbar gwb-foot' },
          h('textarea', {
            ref: textareaRef,
            value: message,
            placeholder: tt('commit.message'),
            spellCheck: false,
            onChange: (event) => { recall.current = { at: -1, draft: '' }; setMessage(event.target.value) },
            onFocus: () => { if (log.length === 0) void loadLog() },
            onKeyDown: recallMessage,
          }),
          h(
            'div',
            { className: 'gwb-ca' },
            h(
              'div',
              { className: 'gwb-ca-row' },
              h('button', { className: 'gwb-btn sm ctl', title: tt('commit.ai'), disabled: aiBusy, onClick: () => void generateMessage() }, aiBusy ? tt('commit.aiBusy') : 'AI'),
              h(
                Menu,
                {
                  align: 'up',
                  title: tt('commit.recent'),
                  onOpen: () => void loadLog(),
                  button: h('button', { className: 'gwb-btn sm ctl' }, tt('commit.history')),
                },
                log.length === 0
                  ? h('div', { key: 'no-log', className: 'gwb-menu-row gwb-muted gwb-noclick' }, tt('commit.historyEmpty'))
                  : log.slice(0, 20).map((entry) =>
                  h(
                    MenuRow,
                    { key: entry.hash, onClick: () => setMessage(entry.subject) },
                    h('span', { className: 'gwb-grow', title: entry.subject }, entry.subject),
                    h('span', { className: 'gwb-meta' }, `${entry.author} · ${String(entry.date).slice(0, 10)}`),
                  ),
                ),
              ),
              h(
                'label',
                { className: 'gwb-check', title: info?.unborn === true ? tt('commit.amendUnborn') : tt('commit.amendHint') },
                h('input', {
                  type: 'checkbox',
                  checked: amend,
                  disabled: info?.unborn === true || config().readOnly === true || sequencer !== '',
                  onChange: (event) => void toggleAmend(event.target.checked),
                }),
                tt('commit.amend'),
              ),
              // JetBrains nudges the 50/72 subject budget; here it only appears
              // once there is something to measure.
              message
                ? h(
                    'span',
                    { className: `gwb-counter${subjectLen > 72 ? ' over' : subjectLen > 50 ? ' warn' : ''}` },
                    tt('commit.counter', { len: subjectLen }),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'gwb-ca-row' },
              // Pre-commit checks live next to the commit button: selection is
              // remembered per repository, and a failure stops the commit.
              checks && checks.scripts.length > 0 && config().readOnly !== true
                ? h(
                    Menu,
                    {
                      align: 'up',
                      width: 290,
                      title: `${tt('checks.title')} · ${checks.manager}`,
                      onOpen: () => void loadChecks(),
                      anchorClass: 'gwb-checkmenu',
                      button: h(
                        'button',
                        {
                          className: `gwb-btn sm ctl gwb-checkbtn${selectedChecks.length > 0 && checkState !== 'fail' ? ' on' : ''}${checkState ? ` ${checkState}` : ''}`,
                          title: checking ? tt('checks.running', checking) : tt('checks.hint'),
                          disabled: checking !== null,
                          'aria-busy': checking ? '1' : undefined,
                        },
                        h(GitIcons.check),
                        h('span', null, checking
                          ? tt('checks.runningShort')
                          : selectedChecks.length > 0
                            ? `${tt('checks.label')} · ${selectedChecks.length}`
                            : tt('checks.label')),
                        checkState === 'pass' || checkState === 'fail'
                          ? h('span', { className: `gwb-check-dot ${checkState}` })
                          : null,
                      ),
                    },
                    h('div', { className: 'gwb-menu-hint' }, tt('checks.hint')),
                    checks.scripts.map((item) => {
                      const result = checkResults[item.name]
                      return h(
                        'label',
                        { key: item.name, className: 'gwb-menu-check gwb-menu-stay', title: item.command },
                        h('input', {
                          type: 'checkbox',
                          checked: pickedChecks.includes(item.name),
                          onChange: () => toggleCheck(item.name),
                        }),
                        h(
                          'span',
                          { className: 'gwb-menu-checktext' },
                          h(
                            'span',
                            { className: 'gwb-menu-checkname' },
                            h('span', { className: 'gwb-menu-checklabel' }, item.name),
                            result
                              ? h('span', { className: `gwb-check-result ${result.ok ? 'pass' : 'fail'}` },
                                  result.ok ? `✓ ${(result.ms / 1000).toFixed(1)}s` : '✗')
                              : null,
                          ),
                          h('span', { className: 'gwb-menu-checkcmd' }, item.command),
                        ),
                      )
                    }),
                    selectedChecks.length > 0
                      ? h('div', { key: 'sep', className: 'gwb-menu-sep' })
                      : h('div', { key: 'pick', className: 'gwb-menu-hint quiet' }, tt('checks.pickHint')),
                    selectedChecks.length > 0
                      ? h(
                          MenuRow,
                          { key: 'run', onClick: () => void runChecksNow() },
                          h('span', { className: 'gwb-menu-ico' }, h(GitIcons.check)),
                          h('span', { className: 'gwb-grow' }, tt('checks.runNow')),
                          h('span', { className: 'gwb-meta' }, String(selectedChecks.length)),
                        )
                      : null,
                  )
                : null,
              h(
                'span',
                { className: 'gwb-hint' },
                checking
                  ? tt('checks.running', checking)
                  : conflicts.length > 0
                    ? tt('commit.conflicts', { count: conflicts.length })
                    : sequencer
                      ? tt('commit.useContinue')
                      : stagedCount === 0
                        ? status?.merging === true
                          ? tt('commit.finishMerge')
                          : total === 0 && !amend
                            ? ''
                            : amend && info?.unborn !== true
                              ? tt('commit.amendOnly')
                              : tt('commit.empty')
                        : tt('commit.staged', { count: stagedCount }),
              ),
              h(
                'div',
                { className: 'gwb-commit-actions' },
                // One primary action; the attached caret carries the push
                // variants, so "commit" stays the safe default.
                h(
                  'button',
                  {
                    className: 'gwb-btn primary',
                    disabled: !canCommit || busy || config().readOnly === true,
                    title: config().readOnly === true ? tt('diff.readonlyNote') : sequencer ? tt('commit.useContinue') : undefined,
                    onClick: () => void commitNow(),
                  },
                  tt('commit.submit'),
                ),
                h(
                  'button',
                  {
                    className: 'gwb-btn primary gwb-split-caret',
                    disabled: !canCommit || busy || config().readOnly === true,
                    title: sequencer ? tt('commit.useContinue') : tt('commit.more'),
                    'aria-label': tt('commit.more'),
                    onClick: (event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      openContextMenu(
                        rect.right,
                        rect.bottom + 2,
                        [
                          { iconSvg: iconMarkup('push', 13), label: tt('commit.submitPush'), onClick: () => void commitThenPush(false) },
                          { iconSvg: iconMarkup('push', 13), label: tt('commit.submitForce'), danger: true, onClick: () => void commitThenPush(true) },
                        ],
                        { align: 'right', width: 190 },
                      )
                    },
                  },
                  '▾',
                ),
              ),
            ),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------ panes: log */

    function LogPane(props) {
      const dir = useSessionDirectory(props)
      const dirRef = useRef(dir)
      dirRef.current = dir
      const loadSeq = useRef(0)
      const [entries, setEntries] = useState([])
      const [allBranches, setAllBranches] = useState(true)
      const [query, setQuery] = useState('')
      // The search box keeps the focus after a field is picked from the menu.
      const filterRef = useRef(null)
      const [active, setActive] = useState('')
      const [commit, setCommit] = useState(null)
      // JetBrains 的多选：Ctrl/⌘ 点选加一个，Shift 点选连一段，工具条对
      // 选中的这一组提交动手。
      const [selected, setSelected] = useState([])
      const [anchor, setAnchor] = useState('')
      const [onlySelected, setOnlySelected] = useState(false)
      // 按分支 / 作者 / 日期归类：分组头可以收起，收起的那组不再占位置。
      const groupBy = useLogGroup()
      const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
      // 表头排序 + 哪些列要显示：IDE 的历史页是一张表。
      const sort = useLogSort()
      const columns = useLogColumns()
      const [error, setError] = useState(null)
      const [detailBusy, setDetailBusy] = useState(false)
      const listMode = useListMode()
      const [logFolders, setLogFolders] = useState({})
      // SourceTree 式分支筛选：可以只看某一个分支（本地或远端）的历史。
      const [viewRef, setViewRef] = useState('')
      // IDE 的 Show History for File：从文件行跳进来时只看这个文件。
      const filePath = useFileHistory()
      // 分支比较视图：分支弹框写下比较对象，这里只列两侧各自独有的提交。
      const pair = useCompare()
      const [compare, setCompare] = useState(null)
      const compareSeq = useRef(0)
      const [branchList, setBranchList] = useState({ local: [], remote: [], tags: [] })
  const rootRef = useRef(null)
  // The log stacks list-over-detail as soon as the two columns would each be
  // too narrow to read a subject in — which is the normal right-sidebar width.
  useCompact(rootRef, 860)
  // The list column has its own width, and a narrow one cannot hold every
  // column: the author drops out rather than squeezing the subject away.
  const listRef = useRef(null)
  useNarrowColumn(listRef, 460, 340)
  // How wide the subject cell is: the row needs it to know how many branch
  // labels it can spell out without squeezing the message away.
  const [subjectW, measureSubject] = useSubjectWidth(listRef)

      const load = useCallback(async () => {
        const wanted = dir
        const seq = ++loadSeq.current
        if (!wanted) return
        try {
          // viewRef 选中了具体分支时只看它的历史；否则沿用全部分支/当前分支。
          const list = await Api.logFor(wanted, {
            ref: viewRef || undefined,
            path: filePath || undefined,
            all: viewRef ? false : allBranches,
          })
          if (seq !== loadSeq.current || dirRef.current !== wanted) return
          setEntries(Array.isArray(list) ? list : [])
          setError(null)
        } catch (cause) {
          if (seq !== loadSeq.current || dirRef.current !== wanted) return
          setError(cause)
          setEntries([])
        }
      }, [dir, allBranches, viewRef, filePath])

      const loadCompare = useCallback(async () => {
        const wanted = dir
        const seq = ++compareSeq.current
        if (!wanted || !pair) {
          setCompare(null)
          return
        }
        setCompare(null)
        try {
          const result = await Api.compare(wanted, pair.left, pair.right)
          if (seq !== compareSeq.current || dirRef.current !== wanted) return
          setCompare(result)
        } catch (cause) {
          if (seq !== compareSeq.current || dirRef.current !== wanted) return
          // A ref that vanished since the popup opened: say so and fall back to
          // the normal history instead of leaving an empty compare view up.
          reportError(cause)
          compareStore.set(null)
        }
      }, [dir, pair])

      useEffect(() => {
        void loadCompare()
      }, [loadCompare])

      // One reload entry point: the toolbar button, F5 and repo changes all mean
      // "refresh whatever is on screen".
      const refresh = useCallback(() => void (pair ? loadCompare() : load()), [pair, loadCompare, load])

      useEffect(() => {
        // The compare view replaces the list, so the plain log is not fetched.
        if (pair) return
        void load()
      }, [load, pair])

      useRepoChanges(dir, refresh)

      useEffect(() => {
        setEntries([])
        setActive('')
        setCommit(null)
        setError(null)
        setViewRef('')
        setQuery('')
        setCompare(null)
        setSelected([])
        setAnchor('')
        setOnlySelected(false)
        setBranchList({ local: [], remote: [], tags: [] })
      }, [dir])

      // 分支筛选下拉需要分支列表；远端分支也列出来，可以直接看 origin/xxx 的历史。
      useEffect(() => {
        if (!dir) return
        let alive = true
        void Api.branches(dir)
          .then((list) => {
            if (!alive) return
            setBranchList({ local: list?.local ?? [], remote: list?.remote ?? [], tags: list?.tags ?? [] })
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [dir])

  // A switch — including a detach — rewrites the worktree, so the history pane
  // has to ask the same question the branch menu asks.
  const confirmDirtySwitch = async (okLabel) => {
    if (config().confirmDirtySwitch === false) return true
    const live = await Api.status(dir).catch(() => null)
    const files = live?.files ?? []
    if (!files.length) return true
    const count = new Set(files.map((file) => file.path)).size
    return showConfirm(tt('branch.dirty', { count }), { ok: okLabel, danger: true })
  }

  const checkoutCommitAt = useCallback(
    async (sha) => {
      if (config().readOnly === true) {
        showToast(tt('readonly.blocked'), true)
        return
      }
      if (!(await confirmDirtySwitch(tt('confirm.switch')))) return
      try {
        await Api.checkoutCommit(dir, sha)
        showToast(tt('toast.detached', { sha: sha.slice(0, 7) }))
        await load()
      } catch (cause) {
        reportError(cause)
      }
    },
    [dir, load],
  )

  const checkoutBranchAt = useCallback(
    async (name, sha) => {
      if (config().readOnly === true) {
        showToast(tt('readonly.blocked'), true)
        return
      }
      try {
        await Api.checkout(dir, { branch: name, create: true, from: sha })
        showToast(tt('toast.created', { branch: name }))
        await load()
      } catch (cause) {
        reportError(cause)
      }
    },
    [dir, load],
  )

  const openCommit = useCallback(
        async (hash) => {
          if (!hash) return
          setActive(hash)
          setDetailBusy(true)
          try {
            const loaded = await Api.showCommit(dir, hash)
            preloadedCommits.set(hash, loaded)
            setCommit(loaded)
          } catch (cause) {
            reportError(cause)
          } finally {
            setDetailBusy(false)
          }
        },
        [dir],
      )

      const selectedSet = useMemo(() => new Set(selected), [selected])
      // The selected commits in log order, so the toolbar can name them.
      const selectedEntries = useMemo(
        () => entries.filter((entry) => selectedSet.has(entry.hash)),
        [entries, selectedSet],
      )

      // A plain click replaces the selection, Ctrl/⌘ adds one commit, Shift
      // stretches a range from the last clicked row — the three clicks the
      // JetBrains log uses.
      const selectRow = (event, entry, list) => {
        if (event.shiftKey && anchor !== '') {
          const from = list.findIndex((item) => item.hash === anchor)
          const to = list.findIndex((item) => item.hash === entry.hash)
          if (from >= 0 && to >= 0) {
            const [lo, hi] = from <= to ? [from, to] : [to, from]
            setSelected(list.slice(lo, hi + 1).map((item) => item.hash))
          } else {
            setSelected([entry.hash])
          }
        } else if (event.ctrlKey || event.metaKey) {
          setSelected((prev) => (prev.includes(entry.hash) ? prev.filter((hash) => hash !== entry.hash) : [...prev, entry.hash]))
          setAnchor(entry.hash)
        } else {
          setSelected([entry.hash])
          setAnchor(entry.hash)
        }
        void openCommit(entry.hash)
      }

      const copyHashes = () => {
        copyText(selectedEntries.map((entry) => entry.hash).join('\n'))
        showToast(tt('ctx.copied'))
      }
      const copySubjects = () => {
        copyText(selectedEntries.map((entry) => entry.subject).join('\n'))
        showToast(tt('ctx.copied'))
      }
      const clearSelection = () => {
        setSelected([])
        setAnchor('')
        setOnlySelected(false)
      }

      // JetBrains 的 ↑/↓ 翻提交：读历史是一次看一条，用鼠标点 11 行不叫键盘流。
      // 走 DOM 顺序，所以比较视图的分段列表同样适用。
      const pickRowAt = (index) => {
        const root = rootRef.current
        const nodes = root ? [...root.querySelectorAll('.gwb-logrow')] : []
        if (nodes.length === 0) return
        const node = nodes[Math.min(nodes.length - 1, Math.max(0, index))]
        const hash = node?.dataset?.hash
        if (!hash) return
        node.scrollIntoView({ block: 'nearest' })
        // Walking with the arrow keys is the same request as clicking the row,
        // so the selection follows instead of staying where it was.
        setSelected([hash])
        setAnchor(hash)
        if (hash !== active) void openCommit(hash)
      }

      const stepCommit = (delta) => {
        const root = rootRef.current
        const nodes = root ? [...root.querySelectorAll('.gwb-logrow')] : []
        const at = nodes.findIndex((n) => n.dataset.hash === active)
        pickRowAt(at < 0 ? (delta > 0 ? 0 : nodes.length - 1) : at + delta)
      }

      // JetBrains 的完整提交菜单：打标签 / 拣选 / 还原 / 重置到此提交。
      const opRunning = useRef(false)
      const commitOp = useCallback(
        async (describe, run) => {
          if (config().readOnly === true) {
            showToast(tt('readonly.blocked'), true)
            return
          }
          // Two log operations at once race over index.lock; the menu is
          // already closed when the second click arrives, so answer it.
          if (opRunning.current) {
            showToast(tt('net.busyToast'), true)
            return
          }
          opRunning.current = true
          try {
            await run()
            showToast(describe())
            await load()
          } catch (cause) {
            reportError(cause)
          } finally {
            opRunning.current = false
          }
        },
        [dir, load],
      )

      const tagHere = (name, sha) => void commitOp(() => tt('toast.tagged', { name }), () => Api.createTag(dir, { name, ref: sha }))

      // One commit or a whole selection: the host replays the batch oldest
      // first, so a picked stack lands in the order it was written.
      const pickCommits = (list) => {
        if (list.length === 0) return
        void commitOp(
          () => (list.length === 1 ? tt('toast.picked', { sha: list[0].hash.slice(0, 7) }) : tt('toast.pickedMany', { count: list.length })),
          () => Api.cherryPick(dir, { hashes: list.map((entry) => entry.hash) }),
        )
      }
      const revertCommits = (list) => {
        if (list.length === 0) return
        void commitOp(
          () => (list.length === 1 ? tt('toast.reverted', { sha: list[0].hash.slice(0, 7) }) : tt('toast.revertedMany', { count: list.length })),
          () => Api.revertCommit(dir, { hashes: list.map((entry) => entry.hash) }),
        )
      }
      // The log toolbar works on whatever is selected right now.
      const pickSelected = () => pickCommits(selectedEntries)
      const revertSelected = () => revertCommits(selectedEntries)
      const resetTo = async (sha, mode) => {
        // A mixed reset looks harmless — it keeps every edit — but it empties the
        // staging area, which is work the user did. Both modes confirm.
        const hard = mode === 'hard'
        if (!(await showConfirm(tt(hard ? 'ctx.resetHardConfirm' : 'ctx.resetMixedConfirm', { sha: sha.slice(0, 7) }), { ok: tt(hard ? 'confirm.resetHard' : 'confirm.resetMixed'), danger: true }))) return
        void commitOp(() => tt('toast.reset', { sha: sha.slice(0, 7), mode }), () => Api.reset(dir, { ref: sha, mode, confirm: true }))
      }
      // The dialog is the confirmation: it lists every commit that will be
      // rewritten, so there is no second "are you sure" after it.
      const rebaseFrom = async (sha) => {
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        try {
          const plan = await Api.rebasePlan(dir, sha)
          const answer = await showRebaseDialog({ base: sha, commits: plan?.commits ?? [] })
          if (!answer) return
          const result = await Api.rebase(dir, sha, answer.entries)
          // Rewritten hashes make the old selection meaningless.
          setActive('')
          setCommit(null)
          if (result?.paused === true) {
            showToast(pauseMessage(result), (result.conflicts ?? 0) > 0)
          } else {
            const kept = result?.kept ?? answer.entries.filter((entry) => entry.action !== 'drop').length
            showToast(tt('rebase.done', { kept }))
          }
          await load()
        } catch (cause) {
          reportError(cause)
        }
      }

      // JetBrains 的 Reword：先取出完整原文，改完只替换信息，树不动。
      // HEAD 由宿主 amend；更早的提交走一次同序 rebase 的 reword 步骤。
      const rewordAt = async (entry) => {
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        try {
          const loaded = await Api.commitMessage(dir, entry.hash)
          const current = String(loaded?.message ?? '').replace(/\s+$/, '')
          const next = await showRewordDialog({ message: current })
          if (next === null) return
          if (next === current) {
            showToast(tt('reword.unchanged'))
            return
          }
          const result = await Api.reword(dir, entry.hash, next)
          setActive('')
          setCommit(null)
          if (result?.paused === true) {
            showToast(pauseMessage(result), (result.conflicts ?? 0) > 0)
          } else {
            showToast(tt(result?.amended === true ? 'reword.doneHead' : 'reword.done', { sha: String(result?.sha ?? '').slice(0, 7) }))
          }
          await load()
        } catch (cause) {
          reportError(cause)
        }
      }

      // JetBrains 的 Undo Commit：只把分支指针退回父提交，索引与工作区原样
      // 保留，所以被撤销的改动仍然暂存着，随时可以改完再提交。
      const undoCommitAt = async (entry) => {
        if (config().readOnly === true) {
          showToast(tt('readonly.blocked'), true)
          return
        }
        // A sequencer owns HEAD while it is paused; moving the branch pointer
        // underneath it would desynchronise the replay from its todo list.
        const live = await Api.status(dir).catch(() => null)
        if (live?.operation) {
          showToast(tt('ctx.undoBlocked'), true)
          return
        }
        const parent = entry.parents?.[0]
        if (!parent) return
        const sha = entry.hash.slice(0, 7)
        if (!(await showConfirm(tt('ctx.undoConfirm', { sha }), { ok: tt('confirm.undoCommit') }))) return
        try {
          await Api.reset(dir, { ref: parent, mode: 'soft' })
          setActive('')
          setCommit(null)
          showToast(tt('toast.undone', { sha }))
          await load()
        } catch (cause) {
          reportError(cause)
        }
      }

      // SourceTree 的提交动作。行上右键和详情的 ⋮ 共用同一份清单。
      const commitActions = (x, y, entry, options) => {
        // Right-clicking a row that is part of a selection acts on the whole
        // selection — the same rule the JetBrains log uses.
        const many = selectedSet.has(entry.hash) && selectedEntries.length > 1
        const targets = many ? selectedEntries : [entry]
        const entries = [
          {
            iconSvg: iconMarkup('hash', 13),
            label: tt('ctx.copyHash'),
            hint: many ? tt('ctx.copyHashMany', { count: targets.length }) : entry.hash.slice(0, 7),
            onClick: () => {
              copyText(many ? targets.map((item) => item.hash).join('\n') : entry.hash)
              showToast(tt('ctx.copied'))
            },
          },
          {
            iconSvg: iconMarkup('copy', 13),
            label: tt('ctx.copySubject'),
            hint: many ? tt('ctx.copySubjectMany', { count: targets.length }) : '',
            onClick: () => {
              copyText(many ? targets.map((item) => item.subject).join('\n') : entry.subject)
              showToast(tt('ctx.copied'))
            },
          },
        ]
        if (config().readOnly !== true) {
          entries.push(
            {
              iconSvg: iconMarkup('commit', 13),
              label: tt('ctx.checkoutCommit'),
              hint: tt('ctx.checkoutCommitHint'),
              onClick: () => void checkoutCommitAt(entry.hash),
            },
            {
              iconSvg: iconMarkup('branch', 13),
              label: tt('ctx.branchHere'),
              onClick: () =>
                openNamePrompt(x, y, tt('ctx.branchHere'), tt('ctx.branchName'), (name) => void checkoutBranchAt(name, entry.hash), '', tt('prompt.create')),
            },
            {
              iconSvg: iconMarkup('tag', 13),
              label: tt('ctx.tagHere'),
              onClick: () => openNamePrompt(x, y, tt('ctx.tagHere'), tt('ctx.tagName'), (name) => tagHere(name, entry.hash), '', tt('prompt.create')),
            },
            {
              iconSvg: iconMarkup('plus', 13),
              label: many ? tt('ctx.cherryPickMany', { count: targets.length }) : tt('ctx.cherryPick'),
              hint: many ? '' : entry.hash.slice(0, 7),
              onClick: () => pickCommits(targets),
            },
            {
              iconSvg: iconMarkup('rollback', 13),
              label: many ? tt('ctx.revertMany', { count: targets.length }) : tt('ctx.revertCommit'),
              onClick: () => revertCommits(targets),
            },
            {
              iconSvg: iconMarkup('history', 13),
              label: tt('ctx.rebaseFrom'),
              hint: entry.hash.slice(0, 7),
              onClick: () => void rebaseFrom(entry.hash),
            },
            {
              iconSvg: iconMarkup('rename', 13),
              label: tt('ctx.reword'),
              hint: entry.hash.slice(0, 7),
              onClick: () => void rewordAt(entry),
            },
            ...(entry.head === true && (entry.parents?.length ?? 0) > 0
              ? [{
                  iconSvg: iconMarkup('rollback', 13),
                  label: tt('ctx.undoCommit'),
                  hint: tt('ctx.undoCommitHint'),
                  onClick: () => void undoCommitAt(entry),
                }]
              : []),
            { sep: true },
            {
              iconSvg: iconMarkup('head', 13),
              label: tt('ctx.resetMixed'),
              hint: tt('ctx.resetMixedHint'),
              onClick: () => resetTo(entry.hash, 'mixed'),
            },
            {
              iconSvg: iconMarkup('trash', 13),
              label: tt('ctx.resetHard'),
              hint: tt('ctx.resetHardHint'),
              danger: true,
              onClick: () => resetTo(entry.hash, 'hard'),
            },
            { sep: true },
          )
        }
        entries.push({
          iconSvg: iconMarkup('diff', 13),
          label: tt('ctx.viewDiff'),
          onClick: () => openDiff(kit.ctx, { dir, file: null, source: 'commit', sha: entry.hash }),
        })
        openContextMenu(x, y, entries, options)
      }

      // No auto-open: the newest commit is often a merge whose full diff is
      // huge; the detail pane keeps its hint until a commit is clicked.

      const parsed = useMemo(() => parseLogQuery(query), [query])

      const matches = useCallback(
        (entry) => {
          if (onlySelected && !selectedSet.has(entry.hash)) return false
          return matchLogQuery(entry, parsed)
        },
        [parsed, onlySelected, selectedSet],
      )

      const filtered = useMemo(() => entries.filter(matches), [entries, matches])

      // The order the table is shown in. The plain history order is what the
      // log already is, so sorting only costs a copy when a column is picked.
      const sorted = useMemo(() => sortLogEntries(filtered, sort), [filtered, sort])
      const graphOn = useMemo(() => logGraphVisible(sort), [sort])

      // The columns decide how wide the subject is, so the rows re-measure
      // whenever a column comes or goes.
      useEffect(() => {
        measureSubject()
      }, [measureSubject, columns.author, columns.date, columns.hash, graphOn])

      // The commits the list shows right now. A folded group is not in it, so
      // a range selection cannot reach a row nobody can see.
      const visibleEntries = useMemo(() => {
        if (groupBy === 'none' || pair) return sorted
        const groups = groupLogEntries(sorted, groupBy)
        return groups.flatMap((group) => (collapsedGroups.has(group.key) ? [] : group.entries))
      }, [sorted, groupBy, collapsedGroups, pair])

      // Every commit the log is showing right now — the compare view lists two
      // sections, so "select all" has to reach across both. A folded group is
      // not shown, so its commits are not selected either.
      const visibleHashes = useMemo(() => {
        if (!pair) return visibleEntries.map((entry) => entry.hash)
        return [
          ...(compare?.leftOnly ?? []).filter(matches).map((entry) => entry.hash),
          ...(compare?.rightOnly ?? []).filter(matches).map((entry) => entry.hash),
        ]
      }, [pair, compare, visibleEntries, matches])

      // The bar the JetBrains log grows once commits are selected: it works on
      // the selection as a whole instead of on one row.
      function selectionBar() {
        const many = selected.length > 1
        return h(
          'div',
          { className: 'gwb-selbar' },
          h(
            'span',
            { className: 'gwb-selbar-count', title: tt('log.selectHint') },
            tt('log.selectedCount', { count: selected.length }),
          ),
          h(
            'div',
            { className: 'gwb-selbar-group' },
            h(IconBtn, { title: many ? tt('ctx.cherryPickMany', { count: selected.length }) : tt('ctx.cherryPick'), onClick: pickSelected, className: 'gwb-iconbtn gwb-selbtn' }, h(GitIcons.plus, { size: 12 })),
            h(IconBtn, { title: many ? tt('ctx.revertMany', { count: selected.length }) : tt('ctx.revertCommit'), onClick: revertSelected, className: 'gwb-iconbtn gwb-selbtn' }, h(GitIcons.rollback, { size: 12 })),
            h(IconBtn, { title: many ? tt('ctx.copyHashTip', { count: selected.length }) : tt('ctx.copyHash'), onClick: copyHashes, className: 'gwb-iconbtn gwb-selbtn' }, h(GitIcons.hash, { size: 12 })),
            h(IconBtn, { title: many ? tt('ctx.copySubjectTip', { count: selected.length }) : tt('ctx.copySubject'), onClick: copySubjects, className: 'gwb-iconbtn gwb-selbtn' }, h(GitIcons.copy, { size: 12 })),
          ),
          h(
            'div',
            { className: 'gwb-selbar-group gwb-selbar-view' },
            h(
              'button',
              {
                className: `gwb-seltoggle${onlySelected ? ' on' : ''}`,
                title: tt('log.onlySelected'),
                onClick: () => setOnlySelected((value) => !value),
              },
              tt('log.onlySelectedShort'),
            ),
            h(
              'button',
              { className: 'gwb-selclear', title: tt('log.clearSelection'), onClick: clearSelection },
              h(GitIcons.close, { size: 11 }),
            ),
          ),
        )
      }

      /**
       * The table header. Clicking a column sorts the log by it, the way the
       * IDE's log does — and the arrow says which way the list runs.
       */
      function logHeader() {
        const cell = (key, label) => {
          const on = sort.key === key
          const hint = on ? tt('log.sortFlip', { column: label }) : tt('log.sortBy', { column: label })
          return h(
            'button',
            {
              key,
              className: `gwb-logcols-cell gwb-${key}${on ? ' on' : ''}`,
              title: hint,
              'aria-label': hint,
              onClick: () => logSortStore.toggle(key),
            },
            h('span', { className: 'gwb-logcols-text' }, label),
            on ? h('span', { className: 'gwb-logcols-arrow' }, sort.dir === 'asc' ? '▲' : '▼') : null,
          )
        }
        return h(
          'div',
          { className: 'gwb-logcols', title: tt('log.columnsHint') },
          graphOn ? h('span', { className: 'gwb-log-graph' }) : null,
          cell('subject', tt('log.col.subject')),
          columns.author ? cell('author', tt('log.col.author')) : null,
          columns.date ? cell('date', tt('log.col.date')) : null,
          columns.hash ? cell('hash', tt('log.col.hash')) : null,
        )
      }

      // One row renderer, shared by the flat log and each compare section. The
      // graph is computed per list, so a section keeps its own lanes instead of
      // borrowing the flat list's indices.
      /**
       * The branch labels of one row. Only the labels that fit are spelled
       * out; the ones that do not fold into a single "+N" chip whose tooltip
       * names them. The label that names the branch stays even when it has
       * to be cut short — a row without its branch says nothing.
       */
      function logRefs(refs) {
        if (!refs.length) return null
        const family = refFamily(listRef.current)
        const texts = refs.map((ref) => String(ref).replace(/^HEAD -> /, '').replace(/^tag: /, ''))
        const widths = texts.map((text) => refTextWidth(text, family, LOG_REF_MAX))
        // The message keeps its floor; what is left belongs to the labels.
        const room = subjectW > 0 ? subjectW - LOG_MSG_FLOOR - LOG_REF_SPACE : 0
        const fit =
          subjectW > 0
            ? fitLogRefs(widths, room, (count) => refTextWidth(`+${count}`, family, 0))
            : { shown: 1, cut: 0 }
        const shown = texts.slice(0, fit.shown)
        const hidden = refs.slice(fit.shown)
        return h(
          'span',
          { className: 'gwb-refs' },
          shown.map((text, index) =>
            h(
              'span',
              {
                key: `${text}:${index}`,
                className: `gwb-ref${String(refs[index]).startsWith('HEAD') ? ' head' : ''}`,
                title: String(refs[index]),
                // The label that had to give way is cut to the room that is
                // left, so the message still gets its part of the row.
                style:
                  index === shown.length - 1 && fit.cut > 0 ? { maxWidth: `${fit.cut}px` } : null,
              },
              text,
            ),
          ),
          hidden.length > 0
            ? h(
                'span',
                {
                  className: 'gwb-ref gwb-ref-more',
                  title: hidden.map((ref) => String(ref)).join('\n'),
                },
                `+${hidden.length}`,
              )
            : null,
        )
      }

      function logRow(entry, index, rows, list) {
        return h(
          'div',
          {
            key: entry.hash,
            'data-hash': entry.hash,
            className: `gwb-logrow${active === entry.hash ? ' active' : ''}${selectedSet.has(entry.hash) ? ' sel' : ''}`,
            onClick: (event) => selectRow(event, entry, list),
            onDoubleClick: () => openCommitDiff(entry.hash),
            onContextMenu: (event) => {
              event.preventDefault()
              commitActions(event.clientX, event.clientY, entry)
            },
          },
          graphOn ? h('span', { className: 'gwb-log-graph' }, h(GraphSvg, { row: rows[index] })) : null,
          h(
            'span',
            { className: 'gwb-subject' },
            logRefs(entry.refs ?? []),
            // The message needs its own node: while the refs were inline text
            // in this span the ellipsis ate the subject, not the labels.
            h('span', { className: 'gwb-subject-text', title: entry.subject }, entry.subject),
          ),
          columns.author
            ? h('span', { className: 'gwb-author', title: String(entry.author ?? '') }, entry.author)
            : null,
          columns.date
            ? h('span', { className: 'gwb-date', title: String(entry.date).replace('T', ' ').slice(0, 16) }, shortDate(entry.date))
            : null,
          columns.hash
            ? h('span', { className: 'gwb-hash', title: String(entry.hash ?? '') }, String(entry.hash ?? '').slice(0, 7))
            : null,
          // The same permanent trigger the branch rows carry: the commit menu
          // existed only behind a right-click, which nothing on the row hinted at.
          h('button', {
            className: 'gwb-rowmore',
            title: tt('menu.commitOps'),
            'aria-label': tt('menu.commitOps'),
            'aria-haspopup': 'menu',
            onClick: (event) => {
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              commitActions(rect.right, rect.bottom + 2, entry, { align: 'right' })
            },
            onDoubleClick: (event) => event.stopPropagation(),
          }, h(GitIcons.more, { size: 14 })),
        )
      }

      function logRows(list) {
        const rows = computeGraph(list)
        return list.map((entry, index) => logRow(entry, index, rows, list))
      }

      /**
       * The grouped log: one header per branch, author or day, and the
       * commits under it. The header is a control — clicking it folds the
       * group away, because a log with 400 commits is only readable when
       * some of it can be put away.
       */
      function groupedRows() {
        const groups = groupLogEntries(sorted, groupBy)
        const out = []
        for (const group of groups) {
          const collapsed = collapsedGroups.has(group.key)
          out.push(
            h(
              'div',
              {
                key: `group:${group.key}`,
                className: `gwb-loggroup${collapsed ? ' collapsed' : ''}`,
                title: `${groupLabel(group, groupBy)} · ${group.entries.length}`,
                onClick: () =>
                  setCollapsedGroups((previous) => {
                    const next = new Set(previous)
                    if (next.has(group.key)) next.delete(group.key)
                    else next.add(group.key)
                    return next
                  }),
              },
              h('span', { className: 'gwb-caret' }, collapsed ? '▸' : '▾'),
              h('span', { className: 'gwb-rowicon' }, h(groupIcon(groupBy))),
              h('span', { className: 'gwb-loggroup-label' }, groupLabel(group, groupBy)),
              h('span', { className: 'gwb-count' }, group.entries.length),
            ),
          )
          if (collapsed) continue
          // Each group draws its own graph: the lanes of one branch have
          // nothing to do with the lanes of the next one.
          const rows = computeGraph(group.entries)
          group.entries.forEach((entry, index) => out.push(logRow(entry, index, rows, visibleEntries)))
        }
        return out
      }

      // 比较视图只列两侧各自独有的提交：公共历史已经在两个分支里，重复列出只会
      // 把差异淹没掉。
      function compareBody() {
        if (!compare) return h('div', { className: 'gwb-loading' }, tt('log.compareLoading'))
        const sides = [
          { ref: compare.left, list: (compare.leftOnly ?? []).filter(matches) },
          { ref: compare.right, list: (compare.rightOnly ?? []).filter(matches) },
        ]
        if (sides.every((side) => side.list.length === 0)) {
          return h(
            'div',
            { className: 'gwb-loading' },
            query.trim() !== '' && (compare.ahead > 0 || compare.behind > 0) ? tt('log.noMatch') : tt('log.compareEqual'),
          )
        }
        return sides
          .filter((side) => side.list.length > 0)
          .map((side) =>
            h(
              'div',
              { key: side.ref },
              h('div', { className: 'gwb-section' }, tt('log.compareOnly', { ref: side.ref, count: side.list.length })),
              logRows(side.list),
            ),
          )
      }

      // Picking a scope is an explicit request for history, so it ends compare.
      const pickScope = (ref) => {
        compareStore.set(null)
        setViewRef(ref)
      }

      function openFileDiff(file) {
        openDiff(kit.ctx, { dir, file, source: 'commit', sha: active })
      }

      // Enter and double-click are the same request: "show me this commit".
      function openCommitDiff(sha) {
        if (!sha) return
        openDiff(kit.ctx, { dir, file: null, source: 'commit', sha })
      }

      if (!dir) {
        return h(
          'div',
          { className: 'gwb', ref: rootRef },
          h('div', { className: 'gwb-head' }, h('span', { className: 'gwb-title' }, tt('tab.log'))),
          h('div', { className: 'gwb-body' }, h('div', { className: 'gwb-empty' }, tt('repo.unbound'))),
        )
      }

      return h(
        'div',
        {
          className: 'gwb',
          ref: rootRef,
          tabIndex: -1,
          onKeyDown: (event) => {
            if (event.key === 'F5') {
              event.preventDefault()
              refresh()
              return
            }
            const tag = String(event.target?.tagName ?? '').toUpperCase()
            if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
            if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
              event.preventDefault()
              setSelected(visibleHashes)
              setAnchor(visibleHashes[0] ?? '')
              return
            }
            if (event.key === 'Escape' && selected.length > 0) {
              event.preventDefault()
              clearSelection()
              return
            }
            if (event.key === 'ArrowDown') { event.preventDefault(); stepCommit(1) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); stepCommit(-1) }
            else if (event.key === 'Home') { event.preventDefault(); pickRowAt(0) }
            else if (event.key === 'End') { event.preventDefault(); pickRowAt(1e9) }
            else if (event.key === 'Enter' && active) {
              event.preventDefault()
              openCommitDiff(active)
            }
          },
        },
        h(
          'div',
          { className: 'gwb-head' },
          h('span', { className: 'gwb-title' }, tt('tab.log')),
          h(
            'span',
            { className: 'gwb-repo', title: dir },
            h(GitIcons.repo),
            h('span', { className: 'gwb-repo-name' }, baseName(dir)),
          ),
          h('span', { className: 'gwb-crumb-sep' }, '·'),
          h(
            'span',
            { className: 'gwb-chip-meta' },
            compare
              ? `${tt('log.compareAhead', { count: compare.ahead })} · ${tt('log.compareBehind', { count: compare.behind })}`
              : query.trim() !== '' || onlySelected
                ? tt('log.countFiltered', { shown: filtered.length, total: entries.length })
                : tt('log.count', { count: entries.length }),
          ),
          h('span', { style: { flex: 1 } }),
          IconBtn({ title: tt('repo.refresh'), onClick: refresh }, h(GitIcons.reload, { size: 13 })),
        ),
        filePath || pair
          ? h(
              'div',
              { className: 'gwb-filterbar' },
              pair
                ? h(
                    'span',
                    { className: 'gwb-fchip', title: `${compare?.left ?? pair.left} ↔ ${compare?.right ?? pair.right}` },
                    h(GitIcons.compare, { size: 12 }),
                    h('span', { className: 'gwb-fchip-text' }, tt('log.compareScope', { left: compare?.left ?? pair.left, right: compare?.right ?? pair.right })),
                    h(
                      'button',
                      {
                        className: 'gwb-fchip-x',
                        title: tt('log.compareClear'),
                        'aria-label': tt('log.compareClear'),
                        onClick: () => compareStore.set(null),
                      },
                      h(GitIcons.close, { size: 11 }),
                    ),
                  )
                : null,
              filePath
                ? h(
                    'span',
                    { className: 'gwb-fchip', title: filePath },
                    h(GitIcons.history, { size: 12 }),
                    h('span', { className: 'gwb-fchip-text' }, filePath),
                    h(
                      'button',
                      {
                        className: 'gwb-fchip-x',
                        title: tt('log.clearFile'),
                        'aria-label': tt('log.clearFile'),
                        onClick: () => fileHistoryStore.set(''),
                      },
                      h(GitIcons.close, { size: 11 }),
                    ),
                  )
                : null,
            )
          : null,
        error
          ? gitErrorView(error, dir, refresh)
          : h(
              'div',
              { className: `gwb-log-split${commit || detailBusy ? '' : ' nosel'}` },
              h(
                'div',
                { className: 'gwb-log-list', ref: listRef },
                h(
                  'div',
                  { className: 'gwb-filter' },
                  h(
                    'div',
                    { className: 'gwb-search' },
                    h('span', { className: 'gwb-search-icon' }, h(GitIcons.search, { size: 12 })),
                    h('input', {
                      ref: filterRef,
                      type: 'search',
                      placeholder: tt('log.filter'),
                      title: tt('log.filterHint'),
                      spellCheck: false,
                      value: query,
                      onChange: (event) => setQuery(event.target.value),
                    }),
                    h(
                      Menu,
                      {
                        align: 'down',
                        width: 230,
                        title: tt('log.filterFields'),
                        button: h(
                          'button',
                          {
                            className: 'gwb-search-caret',
                            title: tt('log.filterFields'),
                            'aria-label': tt('log.filterFields'),
                          },
                          h(GitIcons.chevDown, { size: 11 }),
                        ),
                      },
                      // Picking a field drops its prefix into the box and lets
                      // the user finish the value — the same shortcut the IDE
                      // gives in its log toolbar.
                      ...LOG_QUERY_FIELDS.map((field) =>
                        h(
                          MenuRow,
                          {
                            key: field,
                            onClick: () => {
                              setQuery((current) => {
                                const trimmed = current.trim()
                                return trimmed === '' ? `${field}:` : `${trimmed} ${field}:`
                              })
                              window.requestAnimationFrame(() => filterRef.current?.focus())
                            },
                          },
                          h('span', { className: 'gwb-grow' }, tt(`log.field.${field}`)),
                          h('span', { className: 'gwb-meta' }, `${field}:`),
                        ),
                      ),
                    ),
                  ),
                  h(
                    Menu,
                    {
                      align: 'down',
                      width: 300,
                      title: tt('log.viewBranch'),
                      button: h(
                        'button',
                        {
                          className: `gwb-btn sm ctl${viewRef !== '' || !allBranches ? ' on' : ''}`,
                          title: compare
                            ? tt('log.scopeInCompare')
                            : `${tt('log.viewBranch')}: ${viewRef || (allBranches ? tt('log.scopeAll') : tt('log.scopeBranch'))}`,
                          style: {
                            maxWidth: 132,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            display: 'inline-block',
                          },
                        },
                        `${viewRef || (allBranches ? tt('log.scopeAll') : tt('log.scopeBranch'))} ▾`,
                      ),
                    },
                    h(
                      MenuRow,
                      {
                        current: !viewRef && allBranches,
                        onClick: () => {
                          pickScope('')
                          setAllBranches(true)
                        },
                      },
                      h('span', { className: 'gwb-rowicon' }, h(GitIcons.branch)),
                      h('span', { className: 'gwb-grow' }, tt('log.scopeAll')),
                    ),
                    h(
                      MenuRow,
                      {
                        current: !viewRef && !allBranches,
                        onClick: () => {
                          pickScope('')
                          setAllBranches(false)
                        },
                      },
                      h('span', { className: 'gwb-rowicon' }, h(GitIcons.head)),
                      h('span', { className: 'gwb-grow' }, tt('log.scopeBranch')),
                    ),
                    branchList.local.length > 0
                      ? h('div', { className: 'gwb-menu-title' }, tt('menu.branches'))
                      : null,
                    ...branchList.local.map((branch) =>
                      h(
                        MenuRow,
                        {
                          key: branch.name,
                          current: viewRef === branch.name,
                          onClick: () => {
                            pickScope(branch.name)
                            setAllBranches(false)
                          },
                        },
                        h('span', { className: 'gwb-rowicon' }, h(GitIcons.branch)),
                        h('span', { className: 'gwb-grow', title: branch.name }, branch.name),
                        // A check would read as "the scope you picked" — the bold
                        // row already says that; this one only marks the working copy.
                        branch.current ? h('span', { className: 'gwb-meta' }, tt('branch.checkedOut')) : null,
                        branch.upstream ? h('span', { className: 'gwb-meta', title: branch.upstream }, branch.upstream) : null,
                      ),
                    ),
                    branchList.tags.length > 0
                      ? h('div', { className: 'gwb-menu-title' }, tt('menu.tags'))
                      : null,
                    ...branchList.tags.slice(0, 20).map((tag) =>
                      h(
                        MenuRow,
                        {
                          key: `tag:${tag}`,
                          current: viewRef === tag,
                          onClick: () => {
                            pickScope(tag)
                            setAllBranches(false)
                          },
                        },
                        h('span', { className: 'gwb-rowicon' }, h(GitIcons.tag)),
                        h('span', { className: 'gwb-grow', title: tag }, tag),
                      ),
                    ),
                    branchList.remote.length > 0
                      ? h('div', { className: 'gwb-menu-title' }, tt('menu.remotes'))
                      : null,
                    ...branchList.remote.slice(0, 20).map((branch) =>
                      h(
                        MenuRow,
                        {
                          key: branch.name,
                          current: viewRef === branch.name,
                          onClick: () => {
                            pickScope(branch.name)
                            setAllBranches(false)
                          },
                        },
                        h('span', { className: 'gwb-rowicon' }, h(GitIcons.remote)),
                        h('span', { className: 'gwb-grow', title: branch.name }, branch.name),
                      ),
                    ),
                  ),
                // The compare view has two fixed sections; grouping them would
                // only hide the difference between them.
                pair
                  ? null
                  : h(
                      Menu,
                      {
                        align: 'down',
                        width: 190,
                        title: tt('log.groupBy'),
                        button: h(
                          'button',
                          {
                            className: `gwb-btn sm ctl${groupBy !== 'none' ? ' on' : ''}`,
                            title: tt('log.groupBy'),
                            'aria-label': tt('log.groupBy'),
                          },
                          `${tt(`log.group.${groupBy}`)} ▾`,
                        ),
                      },
                      ...LOG_GROUP_MODES.map((mode) =>
                        h(
                          MenuRow,
                          { key: mode, current: groupBy === mode, onClick: () => logGroupStore.set(mode) },
                          h('span', { className: 'gwb-rowicon' }, h(groupIcon(mode))),
                          h('span', { className: 'gwb-grow' }, tt(`log.group.${mode}`)),
                        ),
                      ),
                    ),
                // Which columns the table shows. The menu stays open while the
                // user ticks the columns off, the way a checkbox list does.
                pair
                  ? null
                  : h(
                      Menu,
                      {
                        align: 'down',
                        width: 170,
                        title: tt('log.columns'),
                        button: h(
                          'button',
                          {
                            className: 'gwb-btn sm ctl',
                            title: tt('log.columns'),
                            'aria-label': tt('log.columns'),
                          },
                          `${tt('log.columnsShort')} ▾`,
                        ),
                      },
                      ...LOG_COLUMN_KEYS.map((key) =>
                        h(
                          'div',
                          { key, className: 'gwb-menu-stay' },
                          h(
                            MenuRow,
                            { onClick: () => logColumnsStore.toggle(key) },
                            h('span', { className: 'gwb-menu-ico' }, columns[key] ? h(GitIcons.check) : null),
                            h('span', { className: 'gwb-grow' }, tt(`log.col.${key}`)),
                          ),
                        ),
                      ),
                    ),
                ),
                parsed.parts.length > 0
                  ? h(
                      'div',
                      { className: 'gwb-qchips' },
                      // One chip per part, because one chip is what one
                      // condition costs: a filter nobody can take off again
                      // is a trap.
                      ...parsed.parts.map((part, index) =>
                        h(
                          'span',
                          {
                            key: `${part.kind}:${part.raw}:${index}`,
                            className: `gwb-fchip gwb-qchip${part.kind === 'free' ? ' free' : ''}${part.kind === 'term' && part.value === '' ? ' pending' : ''}`,
                            title: part.kind === 'free' ? tt('log.filterFree') : tt(`log.field.${part.key}`),
                          },
                          part.kind === 'free' ? null : h('span', { className: 'gwb-qchip-key' }, `${part.key}:`),
                          h('span', { className: 'gwb-fchip-text' }, part.kind === 'term' && part.value === '' ? tt('log.filterPending') : part.value),
                          h(
                            'button',
                            {
                              className: 'gwb-fchip-x',
                              title: tt('log.removeFilter'),
                              'aria-label': tt('log.removeFilter'),
                              onClick: () =>
                                setQuery(
                                  parsed.parts
                                    .filter((_, position) => position !== index)
                                    .map((entry) => entry.raw)
                                    .join(' '),
                                ),
                            },
                            h(GitIcons.close, { size: 11 }),
                          ),
                        ),
                      ),
                    )
                  : null,
                selected.length > 0 ? selectionBar() : null,
                // The table header: the IDE sorts the log by clicking it.
                pair ? null : logHeader(),
                h(
                  'div',
                  { className: 'gwb-body' },
                  pair
                    ? compareBody()
                    : sorted.length === 0
                      ? h('div', { className: 'gwb-loading' }, query.trim() !== '' ? tt('log.noMatch') : onlySelected ? tt('log.noSelectedMatch') : filePath ? tt('log.fileEmpty') : tt('log.none'))
                      : groupBy === 'none'
                        ? logRows(sorted)
                        : groupedRows(),
                ),
              ),
              h(
                'div',
                { className: 'gwb-log-detail' },
                detailBusy
                  ? h('div', { className: 'gwb-loading' }, tt('log.reading'))
                  : commit
                    ? [
                        h(
                          'div',
                          { className: 'gwb-commitmeta', key: 'meta' },
                          h(
                            'div',
                            { className: 'gwb-commithead' },
                            h('h3', null, String(commit.message ?? '').split('\n')[0] || tt('log.noMessage')),
                            IconBtn(
                              {
                                title: `${tt('ctx.more')} (${tt('ctx.moreHint')})`,
                                onClick: (event) => {
                                  const rect = event.currentTarget.getBoundingClientRect()
                                  commitActions(rect.left, rect.bottom + 4, commit)
                                },
                              },
                              h(GitIcons.more, { size: 14 }),
                            ),
                          ),
                          h(
                            'div',
                            { className: 'gwb-meta' },
                            h(
                              'span',
                              {
                                className: 'gwb-hash',
                                title: `${commit.hash} · ${tt('ctx.copyHash')}`,
                                onClick: () => {
                                  copyText(commit.hash)
                                  showToast(tt('ctx.copied'))
                                },
                              },
                              String(commit.hash).slice(0, 12),
                            ),
                            h('span', null, `${commit.author} <${commit.email}>`),
                            h('span', null, String(commit.date).slice(0, 19).replace('T', ' ')),
                          ),
                          String(commit.message ?? '').split('\n').slice(1).join('\n').trim()
                            ? h('pre', null, String(commit.message).split('\n').slice(1).join('\n').trim())
                            : null,
                        ),
                        h('div', { className: 'gwb-hint', key: 'hint' }, tt('log.openHint')),
                        h('div', { key: 'filesbar', className: 'gwb-filesbar' },
                          h('span', { className: 'gwb-title' }, tt('log.files', { count: commit.files.length })),
                          h('span', { style: { flex: 1 } }),
                          h('div', { className: 'gwb-seg' },
                            h('button', { className: `gwb-mini${listMode === 'flat' ? ' on' : ''}`, title: tt('list.flat'), onClick: () => listModeStore.set('flat') }, tt('list.flat')),
                            h('button', { className: `gwb-mini${listMode === 'tree' ? ' on' : ''}`, title: tt('list.tree'), onClick: () => listModeStore.set('tree') }, tt('list.tree')),
                          ),
                        ),
                        h('div', { key: 'files' }, (() => {
                          const fileEl = (file, depth) =>
                            h(
                              'div',
                              { key: file.path, className: 'gwb-file', title: file.path, style: { paddingLeft: 12 + depth * 12 }, onClick: () => openFileDiff(file.path) },
                              h(Badge, { kind: file.status }),
                              h(FilePath, { path: file.path, hideDir: listMode === 'tree', color: statusColor(file.status) }),
                              h('span', { className: 'gwb-stats' }, `+${file.additions} −${file.deletions}`),
                              h('span', { className: 'gwb-open' }, '›'),
                            )
                          return walkFileTree({
                            files: commit.files,
                            listMode,
                            folders: logFolders,
                            fileEl,
                            folderEl: ({ folder, open: folderOpen, depth }) =>
                              h('div', {
                                key: `dir:${folder.path}`,
                                className: 'gwb-folder',
                                style: { paddingLeft: 12 + depth * 12 },
                                onClick: () => setLogFolders((value) => ({ ...value, [folder.path]: !(value[folder.path] !== false) })),
                              },
                                h('span', { className: 'gwb-caret' }, folderOpen ? '▾' : '▸'),
                                h('span', { className: 'gwb-grow', title: folder.name }, folder.name),
                                h('span', { className: 'gwb-count' }, countFiles(folder)),
                              ),
                          })
                        })()),
                      ]
                    : h('div', { className: 'gwb-loading' }, tt('log.pickCommit')),
              ),
            ),
      )
    }
    /* ------------------------------------------------------ panes: console */

    /** Quote only when needed so a row still reads like a terminal line. */
    function consoleArg(value) {
      const text = String(value ?? '')
      return /[\s"'\\]/.test(text) ? JSON.stringify(text) : text
    }

    function consoleClock(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (part) => String(part).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * The Git tool window's Console. It shows what the host actually spawned —
     * argv, exit code, duration and output — so "why did that fail" can be
     * answered without opening a terminal. Read-only by construction.
     */
    function ConsolePane(props) {
      const dir = useSessionDirectory(props)
      const dirRef = useRef(dir)
      dirRef.current = dir
      const rootRef = useRef(null)
      const [entries, setEntries] = useState([])
      const [limit, setLimit] = useState(200)
      const [expanded, setExpanded] = useState({})
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        if (!dir) {
          setEntries([])
          setError(null)
          return
        }
        const wanted = dir
        try {
          const result = await Api.consoleLog(wanted)
          if (dirRef.current !== wanted) return
          setEntries(Array.isArray(result?.entries) ? result.entries : [])
          if (Number(result?.limit) > 0) setLimit(Number(result.limit))
          setError(null)
        } catch (cause) {
          if (dirRef.current !== wanted) return
          setError(cause)
        }
      }, [dir])

      useEffect(() => {
        void load()
        if (!dir) return undefined
        // Only poll while the tab is actually painted. A hidden tab has
        // offsetWidth 0; polling it forever would be pure noise.
        const timer = setInterval(() => {
          const node = rootRef.current
          if (document.visibilityState !== 'hidden' && node && node.offsetWidth > 0) void load()
        }, 2500)
        return () => clearInterval(timer)
      }, [dir, load])

      const toggle = (id, open) => setExpanded((value) => ({ ...value, [id]: !open }))

      // The panel refreshes on an interval, so an idle repo is mostly the same
      // `status` argv over and over. Consecutive identical runs collapse into
      // one row (newest wins) so a real failure is never buried under polls.
      const rows = useMemo(() => {
        const list = []
        for (const entry of entries) {
          const prev = list[list.length - 1]
          const merge = prev
            && prev.code !== null && entry.code !== null
            && prev.code === entry.code
            && prev.args.length === entry.args.length
            && prev.args.every((arg, index) => arg === entry.args[index])
          if (merge) {
            prev.count += 1
            continue
          }
          list.push({ ...entry, count: 1 })
        }
        return list
      }, [entries])

      if (!dir) {
        return h(
          'div',
          { className: 'gwb', ref: rootRef },
          h('div', { className: 'gwb-head' }, h('span', { className: 'gwb-title' }, tt('tab.console'))),
          h('div', { className: 'gwb-body' }, h('div', { className: 'gwb-empty' }, tt('repo.unbound'))),
        )
      }

      return h(
        'div',
        { className: 'gwb', ref: rootRef },
        h(
          'div',
          { className: 'gwb-head' },
          h('span', { className: 'gwb-title' }, tt('tab.console')),
          h('span', { className: 'gwb-console-hint', title: tt('console.hint', { limit }) }, tt('console.hint', { limit })),
          IconBtn({
            title: tt('console.clear'),
            onClick: () => {
              Api.clearConsole(dir)
                .then(() => { setExpanded({}); return load() })
                .catch(reportError)
            },
          }, h(GitIcons.trash, { size: 13 })),
          IconBtn({ title: tt('console.refresh'), onClick: () => void load() }, h(GitIcons.reload, { size: 13 })),
        ),
        h(
          'div',
          { className: 'gwb-body gwb-console' },
          error
            ? h('div', { className: 'gwb-empty gwb-empty-error' }, tt('console.error', { message: String(error.message ?? error) }))
            : rows.length === 0
              ? h('div', { className: 'gwb-empty' }, tt('console.empty'))
              : rows.map((entry) => {
                  const running = entry.code === null || entry.code === undefined
                  const failed = !running && entry.code !== 0
                  const open = expanded[entry.id] ?? failed
                  const command = `git ${(entry.args ?? []).map(consoleArg).join(' ')}`
                  return h(
                    'div',
                    { key: entry.id, className: `gwb-console-row${failed ? ' failed' : ''}${running ? ' running' : ''}` },
                    h(
                      'div',
                      { className: 'gwb-console-cmd', title: command, onClick: () => toggle(entry.id, open) },
                      h('span', { className: 'gwb-console-caret' }, open ? '▾' : '▸'),
                      h('span', { className: 'gwb-console-text' }, command),
                      running || failed
                        ? h(
                            'span',
                            { className: `gwb-console-code${failed ? ' bad' : ' run'}` },
                            running ? tt('console.running') : tt('console.exit', { code: entry.code }),
                          )
                        : null,
                      entry.count > 1
                        ? h('span', { className: 'gwb-console-meta gwb-console-count', title: tt('console.repeat', { count: entry.count }) }, `×${entry.count}`)
                        : null,
                      running ? null : h('span', { className: 'gwb-console-meta' }, `${entry.ms} ms`),
                      h('span', { className: 'gwb-console-meta' }, consoleClock(entry.at)),
                    ),
                    open
                      ? h(
                          'div',
                          { className: 'gwb-console-out' },
                          entry.stderr ? h('pre', { className: 'gwb-console-stderr' }, entry.stderr) : null,
                          entry.stdout ? h('pre', null, entry.stdout) : null,
                          !entry.stderr && !entry.stdout ? h('div', { className: 'gwb-console-none' }, tt('console.noOutput')) : null,
                        )
                      : null,
                  )
                }),
        ),
      )
    }

    return {
      computeGraph,
      GraphSvg,
      CommitPane,
      LogPane,
      ConsolePane,
      parseLogQuery,
      matchLogQuery,
      logGroupOf,
      groupLogEntries,
      logDayKey,
      localDayKey,
      logSortValue,
      sortLogEntries,
      logGraphVisible,
      fitLogRefs,
    }
  },
})
