// dsh-git-workbench — client chunk (native DSH module chunk).
// Registered as a chunk of the plugin's client entry; see browser.js.

window.__ModuleLoader__.load({
  id: '@yann9/dsh-git-workbench',
  chunk: 'client.core.js',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React
    const { tt } = require('@yann9/dsh-git-workbench/client.i18n.js')

    const COMMIT_KIND = 'dsh-git-commit'
    const LOG_KIND = 'dsh-git-log'
    const CONSOLE_KIND = 'dsh-git-console'
    const DIFF_KIND = 'dsh-git-diff'

    /* ---------------------------------------------------------------- utils */

    function service(ctx, id) {
      try {
        return ctx.get?.(id)
      } catch {
        return undefined
      }
    }

    /** Resolve a host service that may activate after this plugin. */
    function serviceWhenReady(ctx, id, onReady) {
      let tries = 0
      const attempt = () => {
        const found = service(ctx, id)
        if (found) return onReady(found)
        return null
      }
      if (attempt()) return () => {}
      const timer = window.setInterval(() => {
        tries += 1
        if (attempt() || tries > 60) window.clearInterval(timer)
      }, 250)
      return () => window.clearInterval(timer)
    }

    /* ------------------------------------------------------------ api layer */

    /**
     * Validated cache, the HTTP ETag way.
     *
     * Every response is stored with the repository revision it was computed
     * at; each later request sends that revision back and the server answers
     * 304 when nothing changed. So the cache never goes stale — including for
     * git operations this plugin did not perform (terminal, IDE) — and a cache
     * hit costs no git subprocess at all because the server memoises by the
     * same revision.
     */
    const etagCache = new Map()
    const inflight = new Map()
    /** @type {Map<string, string>} latest revision seen per repository */
    const repoRev = new Map()
    const CACHE_LIMIT = 300

    /* ------------------------------------------------------- change feed */

    const changeListeners = new Set()

    function notifyChange(dir) {
      for (const listener of changeListeners) listener(dir)
    }

    /**
     * One feed per page, not one per mounted pane. Prefer SSE (push from the
     * server's .git watcher) with a slow revision poll as the safety net for
     * hosts where EventSource is unavailable; consumers only register
     * listeners, so mounting/removing panes never reconnects the stream.
     */
    const changeFeed = { dir: '', eventSource: null, pollTimer: 0 }

    function ensureChangeFeed(dir) {
      if (!dir || changeFeed.dir === dir) return
      if (changeFeed.eventSource) {
        try {
          changeFeed.eventSource.close()
        } catch {
          /* ignore */
        }
      }
      window.clearInterval(changeFeed.pollTimer)
      changeFeed.dir = dir
      try {
        const stream = new EventSource(`/dsh-git/api/events?dir=${encodeURIComponent(dir)}`)
        stream.addEventListener('change', () => notifyChange(dir))
        changeFeed.eventSource = stream
      } catch {
        changeFeed.eventSource = null
      }
      changeFeed.pollTimer = window.setInterval(async () => {
        const known = repoRev.get(dir)
        if (!known) return
        const next = await Api.rev(dir).catch(() => null)
        if (next && next.rev !== known) {
          repoRev.set(dir, next.rev)
          notifyChange(dir)
        }
      }, 3000)
    }

    /**
     * Subscribe to repository changes. `onChange` is held in a ref: an inline
     * callback must not restart the feed on every render (it used to, and
     * every selection click in the diff view reopened the EventSource).
     */
    function useRepoChanges(dir, onChange) {
      const callbackRef = useRef(onChange)
      useEffect(() => {
        callbackRef.current = onChange
      })
      useEffect(() => {
        if (!dir) return
        const listener = (changed) => {
          if (changed === dir) callbackRef.current?.()
        }
        changeListeners.add(listener)
        ensureChangeFeed(dir)
        return () => {
          changeListeners.delete(listener)
        }
      }, [dir])
    }


    async function api(dir, path, { params, body, method = 'GET' } = {}) {
      const search = new URLSearchParams()
      if (dir) search.set('dir', dir)
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const cacheKey = `${dir ?? ''}|${path}|${search.toString()}`
      if (method === 'GET') {
        const known = etagCache.get(cacheKey)
        const query = new URLSearchParams(search)
        if (known) query.set('rev', known.rev)
        const inFlightKey = `${cacheKey}|${known?.rev ?? 'none'}`
        const pending = inflight.get(inFlightKey)
        if (pending) return pending
        const promise = (async () => {
          const response = await fetch(`/dsh-git/api${path}?${query}`, { headers: { accept: 'application/json' } })
          const rev = response.headers.get('x-git-rev')
          if (rev) repoRev.set(dir ?? '', rev)
          if (response.status === 304) {
            if (!known) throw new Error('the server reports no change but nothing is cached')
            return known.value
          }
          const text = await response.text()
          let payload = {}
          if (text !== '') {
            try {
              payload = JSON.parse(text)
            } catch {
              throw new Error(text.slice(0, 240) || `HTTP ${response.status}`)
            }
          }
          if (!response.ok || (payload && typeof payload.error === 'string')) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          if (rev) {
            if (etagCache.size >= CACHE_LIMIT) etagCache.delete(etagCache.keys().next().value)
            etagCache.set(cacheKey, { rev, value: payload })
          }
          return payload
        })()
        inflight.set(inFlightKey, promise)
        try {
          return await promise
        } finally {
          inflight.delete(inFlightKey)
        }
      }
      const load = async () => {
        const response = await fetch(`/dsh-git/api${path}?${search}`, {
          method,
          headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        })
        const text = await response.text()
        let payload = {}
        if (text !== '') {
          try {
            payload = JSON.parse(text)
          } catch {
            throw new Error(text.slice(0, 240) || `HTTP ${response.status}`)
          }
        }
        if (!response.ok || (payload && typeof payload.error === 'string')) {
          throw new Error(payload?.error ?? `HTTP ${response.status}`)
        }
        return payload
      }

      return load()
    }

    const Api = {
      // 每个 GET 带已知版本号做协商；服务端按版本号记忆化，同一版本下重复
      // 请求不产生任何 git 子进程。
      info: (dir) => api(dir, '/info', {}),
      status: (dir) => api(dir, '/status', {}),
      consoleLog: (dir) => api(dir, '/console', {}),
      clearConsole: (dir) => api(dir, '/console/clear', { method: 'POST', body: {} }),
      checks: (dir) => api(dir, '/checks', {}),
      runCheck: (dir, script) => api(dir, '/check', { method: 'POST', body: { script } }),
      file: (dir, file, full = false, ignoreWhitespace = false) => api(dir, '/file', { params: { file, full: full ? '1' : undefined, ignoreWhitespace: ignoreWhitespace ? '1' : undefined }}),
      commitFile: (dir, sha, file, full = false, ignoreWhitespace = false) => api(dir, '/commit-file', { params: { sha, file, full: full ? '1' : undefined, ignoreWhitespace: ignoreWhitespace ? '1' : undefined }}),
      showCommit: (dir, sha, ignoreWhitespace = false) => api(dir, '/commit', { params: { sha, ignoreWhitespace: ignoreWhitespace ? '1' : undefined }}),
      stashShow: (dir, ref, ignoreWhitespace = false) => api(dir, '/stash-show', { params: { ref, ignoreWhitespace: ignoreWhitespace ? '1' : undefined }}),
      stashFile: (dir, ref, file, full = false, ignoreWhitespace = false) => api(dir, '/stash-file', { params: { ref, file, full: full ? '1' : undefined, ignoreWhitespace: ignoreWhitespace ? '1' : undefined }}),
      commitMessage: (dir, rev = 'HEAD') => api(dir, '/message', { params: { rev }}),
      log: (dir, all = true) => api(dir, '/log', { params: { limit: config().maxLog, all: all ? '1' : '0' }}),
      branches: (dir) => api(dir, '/branches', {}),
      blame: (dir, file) => api(dir, '/blame', { params: { file }}),
      turn: (dir, session, seq, index) => api(dir, '/turn', { params: { session, seq, index }}),
      workspaces: () => api('', '/workspaces', {}),
      config: () => api('', '/config', {}),
      saveConfig: (patch) => api('', '/config', { method: 'POST', body: patch }),
      revert: (dir, body) => api(dir, '/revert', { method: 'POST', body }),
      rollback: (dir, body) => api(dir, '/rollback', { method: 'POST', body }),
      resolve: (dir, body) => api(dir, '/resolve', { method: 'POST', body }),
      conflictView: (dir, file) => api(dir, '/conflict-view', { method: 'POST', body: { file } }),
      resolveRegion: (dir, body) => api(dir, '/resolve-region', { method: 'POST', body }),
      abort: (dir) => api(dir, '/abort', { method: 'POST', body: {} }),
      ignore: (dir, files) => api(dir, '/ignore', { method: 'POST', body: { files } }),
      rev: (dir) => api(dir, '/rev'),
      logFor: (dir, opts = {}) => {
        const params = { limit: config().maxLog, all: opts.all === false ? '0' : '1' }
        if (opts.ref) params.ref = opts.ref
        if (opts.path) params.path = opts.path
        return api(dir, '/log', { params })
      },
      checkoutCommit: (dir, sha) => api(dir, '/checkout-commit', { method: 'POST', body: { sha } }),
      deleteBranch: (dir, branch, force = false) => api(dir, '/delete-branch', { method: 'POST', body: { branch, force } }),
      renameBranch: (dir, branch, name) => api(dir, '/rename-branch', { method: 'POST', body: { branch, name } }),
      setUpstream: (dir, branch, upstream) => api(dir, '/set-upstream', { method: 'POST', body: { branch, upstream } }),
      unsetUpstream: (dir, branch) => api(dir, '/unset-upstream', { method: 'POST', body: { branch } }),
      compare: (dir, left, right) => api(dir, '/compare', { params: { left, right, limit: config().maxLog } }),
      stage: (dir, body) => api(dir, '/stage', { method: 'POST', body }),
      commit: (dir, body) => api(dir, '/commit', { method: 'POST', body }),
      identity: (dir) => api(dir, '/identity', {}),
      saveIdentity: (dir, body) => api(dir, '/identity', { method: 'POST', body }),
      commitPaths: (dir, files, message) => api(dir, '/commit-paths', { method: 'POST', body: { files, message } }),
      checkout: (dir, body) => api(dir, '/checkout', { method: 'POST', body }),
      draftMessage: (dir, body) => api(dir, '/commit-message', { method: 'POST', body }),
      pull: (dir, options = {}) => api(dir, '/pull', { method: 'POST', body: { rebase: options.rebase === true } }),
      push: (dir, options = {}) => api(dir, '/push', { method: 'POST', body: { force: options.force === true, remote: options.remote } }),
      fetchAll: (dir) => api(dir, '/fetch', { method: 'POST', body: {} }),
      remotes: (dir) => api(dir, '/remotes'),
      addRemote: (dir, name, url) => api(dir, '/remote-add', { method: 'POST', body: { name, url } }),
      setRemoteUrl: (dir, name, url) => api(dir, '/remote-url', { method: 'POST', body: { name, url } }),
      removeRemote: (dir, name) => api(dir, '/remote-remove', { method: 'POST', body: { name } }),
      merge: (dir, branch) => api(dir, '/merge', { method: 'POST', body: { branch } }),
      rebaseOnto: (dir, branch) => api(dir, '/rebase-onto', { method: 'POST', body: { branch } }),
      createTag: (dir, body) => api(dir, '/tag', { method: 'POST', body }),
      deleteTag: (dir, body) => api(dir, '/delete-tag', { method: 'POST', body }),
      pushTag: (dir, name) => api(dir, '/push-tag', { method: 'POST', body: { name } }),
      switchTo: (dir, ref) => api(dir, '/switch', { method: 'POST', body: { ref } }),
      cherryPick: (dir, body) => api(dir, '/cherry-pick', { method: 'POST', body }),
      revertCommit: (dir, body) => api(dir, '/revert-commit', { method: 'POST', body }),
      reset: (dir, body) => api(dir, '/reset', { method: 'POST', body }),
      stash: (dir, action, ref, message, paths) => api(dir, '/stash', { method: 'POST', body: { action, ref, message, paths } }),
      stashList: (dir) => api(dir, '/stash', {}),
      initRepo: (dir) => api(dir, '/init', { method: 'POST', body: {} }),
      rebasePlan: (dir, base) => api(dir, '/rebase-plan', { params: { base } }),
      rebase: (dir, base, entries) => api(dir, '/rebase', { method: 'POST', body: { base, entries } }),
      reword: (dir, sha, message) => api(dir, '/reword', { method: 'POST', body: { sha, message } }),
      continueOperation: (dir) => api(dir, '/continue', { method: 'POST', body: {} }),
    }

    /**
     * Plugin configuration. Every knob the UI honours lives here with the same
     * default the host declares, so the plugin behaves the same whether or not
     * a profile sets anything.
     */
    const CONFIG_DEFAULTS = {
      branchPattern: 'session/{date}-{time}',
      diffFullFile: true, // whole-file diff (folds the unchanged runs)
      diffWrap: true, // soft-wrap long lines
      diffFoldThreshold: 8, // unchanged runs longer than this collapse
      diffSideBySide: true, // split instead of unified on first open
      listMode: 'last', // 'flat' | 'tree' | 'last' (remember the user's choice)
      confirmDirtySwitch: true, // ask before switching with a dirty tree
      readOnly: false, // hide every staging/commit affordance
      commitLanguage: 'auto', // 'auto' follows the UI locale
      llmProvider: '', // empty: the model route's default provider
      llmModel: '', // empty: the provider's catalog/default
      maxLog: 400, // commits fetched for the log and the history menu
    }

    let configCache = { ...CONFIG_DEFAULTS }
    let configPromise = null
    function applyConfig(value) {
      if (value && typeof value === 'object') {
        configCache = { ...CONFIG_DEFAULTS, ...value }
        applyListModeFromConfig()
      }
      return configCache
    }
    function pluginConfig() {
      if (!configPromise) {
        configPromise = Api.config()
          .then(applyConfig)
          .catch(() => configCache)
      }
      return configPromise
    }
    /** Current values; defaults until the first response lands. */
    function config() {
      return configCache
    }

    /* ------------------------------------------------ list mode (shared) */

    /**
     * 平铺/树状 is one preference for the whole workbench: toggling it in the
     * Commit pane must immediately change the Log pane too (both are
     * keepMounted, so a localStorage write alone never reaches the other).
     */
    const STORED_LIST_KEY = 'dsh-git.list'

    const listModeStore = {
      value: (() => {
        const stored = localStorage.getItem(STORED_LIST_KEY)
        return stored === 'tree' || stored === 'flat' ? stored : 'flat'
      })(),
      listeners: new Set(),
      set(mode) {
        if ((mode !== 'tree' && mode !== 'flat') || mode === listModeStore.value) return
        listModeStore.value = mode
        localStorage.setItem(STORED_LIST_KEY, mode)
        for (const listener of listModeStore.listeners) listener()
      },
      subscribe(listener) {
        listModeStore.listeners.add(listener)
        return () => listModeStore.listeners.delete(listener)
      },
      snapshot() {
        return listModeStore.value
      },
    }

    function useListMode() {
      return useSyncExternalStore(listModeStore.subscribe, listModeStore.snapshot, listModeStore.snapshot)
    }

    /**
     * How the log groups its commits: a flat list, or one section per
     * branch, author or day. The IDE keeps this choice between tabs, so it
     * survives a remount of the pane.
     */
    const STORED_GROUP_KEY = 'dsh-git.logGroup'

    const logGroupStore = {
      value: (() => {
        const stored = localStorage.getItem(STORED_GROUP_KEY)
        return stored === 'branch' || stored === 'author' || stored === 'date' ? stored : 'none'
      })(),
      listeners: new Set(),
      set(mode) {
        if (mode !== 'none' && mode !== 'branch' && mode !== 'author' && mode !== 'date') return
        if (mode === logGroupStore.value) return
        logGroupStore.value = mode
        localStorage.setItem(STORED_GROUP_KEY, mode)
        for (const listener of logGroupStore.listeners) listener()
      },
      subscribe(listener) {
        logGroupStore.listeners.add(listener)
        return () => logGroupStore.listeners.delete(listener)
      },
      snapshot() {
        return logGroupStore.value
      },
    }

    function useLogGroup() {
      return useSyncExternalStore(logGroupStore.subscribe, logGroupStore.snapshot, logGroupStore.snapshot)
    }

    /**
     * How the log is ordered. The IDE's log is a table: its header sorts, and
     * the choice survives a remount of the pane. `date`/`desc` is the plain
     * history order — the newest commit first.
     */
    const STORED_SORT_KEY = 'dsh-git.logSort'
    const LOG_SORT_KEYS = ['date', 'subject', 'author', 'hash']

    const logSortStore = {
      value: (() => {
        const stored = String(localStorage.getItem(STORED_SORT_KEY) ?? '')
        const [key, dir] = stored.split(':')
        if (!LOG_SORT_KEYS.includes(key)) return { key: 'date', dir: 'desc' }
        return { key, dir: dir === 'asc' ? 'asc' : 'desc' }
      })(),
      listeners: new Set(),
      set(next) {
        if (!next || !LOG_SORT_KEYS.includes(next.key)) return
        const dir = next.dir === 'asc' ? 'asc' : 'desc'
        const current = logSortStore.value
        if (current.key === next.key && current.dir === dir) return
        logSortStore.value = { key: next.key, dir }
        localStorage.setItem(STORED_SORT_KEY, `${next.key}:${dir}`)
        for (const listener of logSortStore.listeners) listener()
      },
      /** Clicking the active column flips the direction; a new column starts ascending. */
      toggle(key) {
        const current = logSortStore.value
        logSortStore.set({
          key,
          dir: current.key === key ? (current.dir === 'asc' ? 'desc' : 'asc') : 'asc',
        })
      },
      subscribe(listener) {
        logSortStore.listeners.add(listener)
        return () => logSortStore.listeners.delete(listener)
      },
      snapshot() {
        return logSortStore.value
      },
    }

    function useLogSort() {
      return useSyncExternalStore(logSortStore.subscribe, logSortStore.snapshot, logSortStore.snapshot)
    }

    /**
     * Which columns the log table shows. The subject is always there — a log
     * row without it says nothing — so only the secondary columns are
     * switchable.
     */
    const STORED_COLUMNS_KEY = 'dsh-git.logColumns'
    const LOG_COLUMN_KEYS = ['author', 'date', 'hash']

    const logColumnsStore = {
      value: (() => {
        const fallback = { author: true, date: true, hash: false }
        try {
          const stored = JSON.parse(String(localStorage.getItem(STORED_COLUMNS_KEY) ?? 'null'))
          if (!stored || typeof stored !== 'object') return fallback
          const value = { ...fallback }
          for (const key of LOG_COLUMN_KEYS) {
            if (typeof stored[key] === 'boolean') value[key] = stored[key]
          }
          return value
        } catch {
          return fallback
        }
      })(),
      listeners: new Set(),
      toggle(key) {
        if (!LOG_COLUMN_KEYS.includes(key)) return
        const value = { ...logColumnsStore.value, [key]: !logColumnsStore.value[key] }
        logColumnsStore.value = value
        localStorage.setItem(STORED_COLUMNS_KEY, JSON.stringify(value))
        for (const listener of logColumnsStore.listeners) listener()
      },
      subscribe(listener) {
        logColumnsStore.listeners.add(listener)
        return () => logColumnsStore.listeners.delete(listener)
      },
      snapshot() {
        return logColumnsStore.value
      },
    }

    function useLogColumns() {
      return useSyncExternalStore(logColumnsStore.subscribe, logColumnsStore.snapshot, logColumnsStore.snapshot)
    }

    /**
     * Column widths of the log table, as the user dragged them. Only a width
     * that differs from the stylesheet default is stored: a missing key leaves
     * the default in charge, which is also what lets the compact pane keep its
     * narrow graph until someone asks for more room.
     *
     * The subject has no fixed width of its own — it takes what the other
     * columns leave. Once the user drags it, it keeps the width they gave it;
     * the upper bounds are wide enough that the pane, not the number, is what
     * stops a column.
     */
    const STORED_WIDTHS_KEY = 'dsh-git.logWidths'
    const STORED_LEAD_KEY = 'dsh-git.logWidths.lead'
    const LOG_WIDTH_DEFAULTS = { graph: 56, author: 92, date: 76, hash: 66 }
    const LOG_WIDTH_LIMITS = {
      graph: [24, 1200],
      subject: [40, 2000],
      author: [48, 400],
      date: [48, 300],
      hash: [48, 260],
    }
    const LOG_WIDTH_KEYS = ['graph', 'subject', 'author', 'date', 'hash']

    function clampLogWidth(key, value) {
      const width = Math.round(Number(value))
      if (!Number.isFinite(width)) return null
      const [min, max] = LOG_WIDTH_LIMITS[key]
      return Math.max(min, Math.min(max, width))
    }

    function sameLogWidths(left, right) {
      return LOG_WIDTH_KEYS.every((key) => left[key] === right[key])
    }

    const logWidthStore = {
      value: (() => {
        const fallback = {}
        try {
          const stored = JSON.parse(String(localStorage.getItem(STORED_WIDTHS_KEY) ?? 'null'))
          if (!stored || typeof stored !== 'object') return fallback
          const value = {}
          for (const key of LOG_WIDTH_KEYS) {
            const width = clampLogWidth(key, stored[key])
            if (width !== null && width !== LOG_WIDTH_DEFAULTS[key]) value[key] = width
          }
          return value
        } catch {
          return fallback
        }
      })(),
      /**
       * The column the user touched last. The pane is too small to give every
       * column what it asks for, so the one in the hand wins the room and the
       * others step back.
       */
      lead: (() => {
        try {
          const key = String(localStorage.getItem(STORED_LEAD_KEY) ?? '')
          return LOG_WIDTH_KEYS.includes(key) ? key : null
        } catch {
          return null
        }
      })(),
      listeners: new Set(),
      /**
       * Persist one dragged width. `null` — or a width that lands back on the
       * default — is a reset, so the stylesheet owns the column again.
       */
      set(key, width) {
        if (!LOG_WIDTH_KEYS.includes(key)) return
        const clamped = width === null ? null : clampLogWidth(key, width)
        if (width !== null && clamped === null) return
        const next = { ...logWidthStore.value }
        if (clamped === null || clamped === LOG_WIDTH_DEFAULTS[key]) delete next[key]
        else next[key] = clamped
        const resized = !sameLogWidths(next, logWidthStore.value)
        // The column the user is working on is the one whose width counts the
        // most when the pane cannot give every column what it asks for.
        const claimed = logWidthStore.lead !== key
        if (!resized && !claimed) return
        logWidthStore.value = next
        logWidthStore.lead = key
        if (resized) {
          if (Object.keys(next).length === 0) localStorage.removeItem(STORED_WIDTHS_KEY)
          else localStorage.setItem(STORED_WIDTHS_KEY, JSON.stringify(next))
        }
        try {
          localStorage.setItem(STORED_LEAD_KEY, key)
        } catch {
          // A storage that refuses writes only costs us the memory of the lead.
        }
        for (const listener of logWidthStore.listeners) listener()
      },
      subscribe(listener) {
        logWidthStore.listeners.add(listener)
        return () => logWidthStore.listeners.delete(listener)
      },
      snapshot() {
        return logWidthStore.value
      },
      leadSnapshot() {
        return logWidthStore.lead
      },
    }

    function useLogWidths() {
      return useSyncExternalStore(logWidthStore.subscribe, logWidthStore.snapshot, logWidthStore.snapshot)
    }

    /**
     * The column the user touched last. It is the one whose width the pane
     * keeps, when the columns together ask for more room than there is.
     */
    function useLogWidthLead() {
      return useSyncExternalStore(logWidthStore.subscribe, logWidthStore.leadSnapshot, logWidthStore.leadSnapshot)
    }

    /**
     * The IDE's "Show History for File" jumps from a file row to the History
     * tab with that file already filtered. Tab payloads are not forwarded by
     * the host, so the hand-off rides on this store instead.
     */
    const fileHistoryStore = {
      path: '',
      listeners: new Set(),
      set(next) {
        const value = String(next ?? '')
        if (value === fileHistoryStore.path) return
        fileHistoryStore.path = value
        for (const listener of fileHistoryStore.listeners) listener()
      },
      subscribe(listener) {
        fileHistoryStore.listeners.add(listener)
        return () => fileHistoryStore.listeners.delete(listener)
      },
      snapshot() {
        return fileHistoryStore.path
      },
    }

    function useFileHistory() {
      return useSyncExternalStore(fileHistoryStore.subscribe, fileHistoryStore.snapshot, fileHistoryStore.snapshot)
    }

    /**
     * Branch comparison hand-off, same reason as above: the branch popup cannot
     * pass a payload to a tab, so it writes the pair here and History reads it.
     * `null` clears the compare view.
     */
    const compareStore = {
      pair: null,
      listeners: new Set(),
      set(next) {
        const right = String(next?.right ?? '').trim()
        const value = right === '' ? null : { left: String(next?.left ?? '').trim() || 'HEAD', right }
        if (value?.left === compareStore.pair?.left && value?.right === compareStore.pair?.right) return
        compareStore.pair = value
        for (const listener of compareStore.listeners) listener()
      },
      subscribe(listener) {
        compareStore.listeners.add(listener)
        return () => compareStore.listeners.delete(listener)
      },
      snapshot() {
        return compareStore.pair
      },
    }

    function useCompare() {
      return useSyncExternalStore(compareStore.subscribe, compareStore.snapshot, compareStore.snapshot)
    }

    /** Apply the configured default only while the user has no explicit choice. */
    function applyListModeFromConfig() {
      const stored = localStorage.getItem(STORED_LIST_KEY)
      if (stored === 'tree' || stored === 'flat') return
      const mode = configCache.listMode
      if (mode !== 'tree' && mode !== 'flat') return
      if (mode === listModeStore.value) return
      listModeStore.value = mode
      for (const listener of listModeStore.listeners) listener()
    }

    /* --------------------------------------------------- session binding */

    const NO_STORE_SUBSCRIBE = () => () => {}
    function useEmptyStore(selector) {
      return useSyncExternalStore(
        NO_STORE_SUBSCRIBE,
        () => selector(null),
        () => selector(null),
      )
    }

    /**
     * Repository directory for the session that owns the mounted UI.
     *
     * The session's own cwd is authoritative: DSH resolves it when the
     * workspace is picked, and the server climbs from it to the repository
     * root. A blank session has no cwd yet, so its owning workspace is the
     * fallback. There is deliberately no "last used repo" fallback — that is
     * what used to make the pane operate on a different project than the
     * conversation.
     *
     * @param {{ sessionId?: string, useSessions?: Function, useWorkspaces?: Function }} props
     * @param {string} [overrideSessionId] target session (turn snapshots/cards)
     */
    function useSessionDirectory(props, overrideSessionId) {
      const sessionId = overrideSessionId || props?.sessionId || ''
      const sessionsHook = typeof props?.useSessions === 'function' ? props.useSessions : useEmptyStore
      const workspacesHook = typeof props?.useWorkspaces === 'function' ? props.useWorkspaces : useEmptyStore
      const cwd = sessionsHook((sessions) => {
        if (!sessionId) return ''
        const value = sessions?.byId?.[sessionId]?.cwd
        return typeof value === 'string' ? value : ''
      })
      const workspacePath = workspacesHook((state) => {
        if (!sessionId) return ''
        const workspace = (state?.items ?? []).find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId))
        return typeof workspace?.path === 'string' ? workspace.path : ''
      })
      return cwd || workspacePath || ''
    }

    /**
     * Pane width ≠ window width once the column splits. Track the element and
     * expose `data-compact` so the header can drop secondary text.
     * @param {{ current: Element | null }} rootRef
     * @param {number} [threshold]
     */
    function useCompact(rootRef, threshold = 640) {
      useEffect(() => {
        const node = rootRef.current
        if (!node || typeof ResizeObserver !== 'function') return
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            node.dataset.compact = entry.contentRect.width < threshold ? '1' : '0'
          }
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [rootRef, threshold])
    }


    // Warm the diff chunk during boot: the first click must not wait for it.
    if (typeof fetch === 'function') {
      void require.async('./client.diff.js').catch(() => {})
    }

    /* ------------------------------------------------- conversation view */

    const diffTargetStore = {
      target: null,
      listeners: new Set(),
      set(next) {
        diffTargetStore.target = next
        for (const listener of diffTargetStore.listeners) listener()
      },
      subscribe(listener) {
        diffTargetStore.listeners.add(listener)
        return () => diffTargetStore.listeners.delete(listener)
      },
      snapshot() {
        return diffTargetStore.target
      },
    }

    /**
     * 「差异」页签按需出现：第一次点文件时注册进 view ring，头部的 ✕ 注销它
     * （ring 自动回退到对话）。这样它不会常驻页签带。
     */
    let diffViewRegistered = false
    let diffViewDisposer = null
    // Label of whichever tab was open before the diff took over, so 返回会话
    // can put the user back where they came from.
    let diffViewReturn = null

    /**
     * Chunk loader for the diff view. Renders immediately, swaps in the real
     * body once `client.diff.js` has materialised.
     */
    function DiffViewHost(props) {
      const [Loaded, setLoaded] = useState(null)
      const [failed, setFailed] = useState(null)
      useEffect(() => {
        let alive = true
        require
          .async('./client.diff.js')
          .then((module) => {
            if (alive) setLoaded(() => module.GitDiffViewBody)
          })
          .catch((error) => {
            if (alive) setFailed(error)
          })
        return () => {
          alive = false
        }
      }, [])
      if (failed) return h('div', { className: 'gwb-loading' }, String(failed?.message ?? failed))
      if (!Loaded) return h('div', { className: 'gwb-loading' }, tt('group.reading'))
      return h(Loaded, props)
    }

    function ensureDiffView(ctx) {
      if (diffViewRegistered) return
      if (!ctx || typeof ctx.slots?.inject !== 'function') return
      diffViewRegistered = true
      try {
        ctx.slots.inject('conversation.view', () => {
          // The slots service disposes this effect and runs it again whenever
          // the slot declaration collapses and comes back. Returning the
          // previous disposer here (as an earlier version did) looked like a
          // guard but left the view unregistered for good: that disposer is
          // dead by then, no tab is created, and every later click is a silent
          // no-op. Registering again is the whole point of the re-run.
          const disposer = ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'git-diff',
              // order 5 lands the tab between 对话 (first) and 轨迹 (order 10).
              order: 5,
              label: () => tt('tab.diff'),
            },
            // NOT React.lazy: a lazy component suspends on first render, and a
            // suspension during the synchronous click that opens the tab throws
            // React #426 ("suspended while responding to synchronous input"),
            // which blanks the view. This host waits for the chunk in state and
            // renders a loading row meanwhile — same bytes, no suspension.
            DiffViewHost,
          )
          diffViewDisposer = typeof disposer === 'function' ? disposer : null
          return disposer
        })
      } catch (error) {
        diffViewRegistered = false
        console.warn('[git-workbench] could not register the diff view', error)
      }
    }

    function closeDiffView() {
      if (diffViewDisposer) {
        try {
          diffViewDisposer()
        } catch (error) {
          console.warn('[git-workbench] closing the diff view failed', error)
        }
      }
      diffViewDisposer = null
      diffViewRegistered = false
      // The diff usually lands in a tab the host owns — the right sidebar has
      // no unregister path — so the only way back is the one a user would
      // take. If the disposer already removed the tab this finds nothing and
      // stops.
      const label = tt('tab.diff')
      const flat = (value) => String(value || '').replace(/\s+/g, '')
      const visible = [...document.querySelectorAll('[role=tab]')].filter((node) => node.getBoundingClientRect().width > 0)
      const isDiff = (node) => flat(node.textContent).includes(flat(label))
      if (!visible.some((node) => isDiff(node) && node.getAttribute('aria-selected') === 'true')) {
        diffViewReturn = null
        return
      }
      const back =
        visible.find((node) => (node.textContent || '').trim() === diffViewReturn) ||
        visible.find((node) => !isDiff(node))
      diffViewReturn = null
      if (back) back.click()
    }

    /**
     * Every "show me this diff" just publishes the target: the diff lives as a
     * conversation view — the same tab ring as 对话 / 轨迹 — and re-renders in
     * place whenever the target changes. Switching to it clicks the tab the
     * way a user would, because the host keeps view activation internal; the
     * retry covers the moment between registration and the tab appearing.
     */
    function activateDiffView(ctx, attempt = 0) {
      const label = tt('tab.diff')
      const tabs = [...document.querySelectorAll('[role=tab]')].filter((node) => node.getBoundingClientRect().width > 0)
      // The host decorates a view tab with an icon and a close affordance in
      // some builds, so the label is a substring of the tab's text there and an
      // exact comparison would never find the tab the plugin just registered.
      const flat = (value) => String(value || '').replace(/\s+/g, '')
      const tab = tabs.find((node) => flat(node.textContent).includes(flat(label)))
      if (!tab || tab.getAttribute('aria-selected') !== 'true') {
        const current = tabs.find((node) => node.getAttribute('aria-selected') === 'true')
        if (current) diffViewReturn = (current.textContent || '').trim()
      }
      // The host keeps one mounted conversation container *per session* and
      // hides the inactive ones, so a hidden 差异 tab from another session can
      // match first. Activating that one paints the diff inside
      // `display: none` and the user's click looks lost — only a visible tab
      // may be clicked. With none visible the registration is still pending,
      // so poll a few frames and then land in the right sidebar, which always
      // belongs to this session.
      if (tab) {
        if (tab.getAttribute('aria-selected') !== 'true') tab.click()
        return
      }
      // Registration is async; poll briefly (100ms × 25 ≈ 2.5s ceiling) so the
      // usual case lands within a couple of frames.
      if (attempt < 25) {
        window.setTimeout(() => activateDiffView(ctx, attempt + 1), 100)
        return
      }
      // A session with no messages has no conversation view ring at all. Without
      // a fallback the click would silently do nothing, so show the diff in the
      // right sidebar instead — same component, same target store. Name the
      // branch in the console: a diff that shows up in the right sidebar while
      // the conversation is on screen means this fallback fired, and that is a
      // registration problem to fix, not a preference.
      const target = diffTargetStore.snapshot()
      console.warn('[git-workbench] the conversation view took no 差异 tab; opening the right sidebar instead', {
        source: target?.source ?? null,
        dir: target?.dir ? 'explicit' : 'from the session',
      })
      if (ctx && !openTab(ctx, DIFF_KIND)) {
        console.warn('[git-workbench] the diff has nowhere to go: no conversation view and no right sidebar')
      }
    }

    /**
     * Commit payloads already fetched by the Log pane, keyed by sha. Clicking
     * a file in the commit detail must not re-download the whole commit diff —
     * only fall back to the network when the payload is not around.
     * @type {Map<string, any>}
     */
    const preloadedCommits = new Map()

    function openDiff(ctx, target) {
      ensureDiffView(ctx)
      diffTargetStore.set(target)
      // Whatever the user clicked from — Commit, Log, a card — the diff shows
      // up in the centre without an extra click.
      activateDiffView(ctx)
      return true
    }

    function openTab(ctx, kind, params, options = {}) {
      const right = service(ctx, 'sidebarRight')
      if (!right || typeof right.openTab !== 'function') return false
      try {
        const payload = params ? { params, ...options } : { ...options }
        right.openTab(kind, payload)
        return true
      } catch (error) {
        console.warn(`[git-workbench] could not open ${kind}`, error)
        return false
      }
    }

    /* ------------------------------------------------- shared git actions */

    /**
     * The branch menu's operations — one implementation for the Commit pane and
     * the header menu. Returns the toast text (git's own tail, or a generic done).
     * @param {string} dir
     * @param {'pull'|'push'|'fetch'|'merge'|'switchTo'|'pushTag'|'createTag'|'deleteTag'} kind
     * @param {string} [branch]
     */
    async function runNetOp(dir, kind, branch, options = {}) {
      // git prints its narrative on stderr and leaves stdout nearly empty, so
      // the last few lines are what the toast should show.
      const tail = (result) => String(result.output ?? '').split('\n').filter(Boolean).slice(-3).join('\n') || tt('net.done')
      switch (kind) {
        case 'merge':
          return tail(await Api.merge(dir, branch))
        case 'rebaseOnto': {
          const result = await Api.rebaseOnto(dir, branch)
          if (result?.paused) return tt('toast.rebasePaused')
          return tt('toast.rebasedOnto', { branch })
        }
        case 'pull':
        case 'push':
          return tail(await Api[kind](dir, options))
        case 'fetch':
          // The route is /fetch but the client method is fetchAll — dispatching
          // on the kind name would call a method that does not exist.
          return tail(await Api.fetchAll(dir))
        case 'switchTo':
          await Api.switchTo(dir, branch)
          return tt('toast.switchedTo', { ref: branch })
        case 'pushTag':
          return tail(await Api.pushTag(dir, branch))
        case 'deleteTag':
          await Api.deleteTag(dir, { names: [branch] })
          return tt('toast.tagDeleted', { name: branch })
        case 'createTag':
          await Api.createTag(dir, { name: branch, ref: options.ref, force: options.force === true })
          return tt('toast.tagged', { name: branch })
      }
    }

    /** @param {string} dir @param {string} branch @param {boolean} [create] @param {string} [from] */
    async function switchBranch(dir, branch, create, from) {
      await Api.checkout(dir, create ? { branch, create: true, from } : { branch })
    }

    function dirPartOf(path) {
      const slash = String(path).lastIndexOf('/')
      return slash > 0 ? String(path).slice(0, slash) : ''
    }

    function nameOf(path) {
      const slash = String(path).lastIndexOf('/')
      return slash > 0 ? String(path).slice(slash + 1) : String(path)
    }

    /** IDE convention: modified/renamed=blue, added=green, deleted=red, untracked=orange. */
    function statusColor(kind) {
      switch (kind) {
        case 'added':
        case 'copied':
          return 'var(--gwb-success-ink)'
        case 'deleted':
          return 'var(--gwb-del-ink)'
        case 'untracked':
          return 'var(--gwb-warn-ink)'
        case 'conflicted':
          return 'var(--gwb-error-ink)'
        default:
          return 'var(--gwb-accent-ink)'
      }
    }

    function baseName(value) {
      return String(value).replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() ?? value
    }

    function setListModePersisted(mode) {
      listModeStore.set(mode)
    }

    function collectPaths(node, out = []) {
      for (const file of node.files) out.push(file.path)
      for (const folder of node.dirs.values()) collectPaths(folder, out)
      return out
    }

    function countFiles(node) {
      let count = node.files.length
      for (const folder of node.dirs.values()) count += countFiles(folder)
      return count
    }

    function buildTree(files) {
      const root = { dirs: new Map(), files: [] }
      for (const file of files) {
        const parts = file.path.split('/')
        let node = root
        let soFar = ''
        for (let i = 0; i < parts.length - 1; i += 1) {
          soFar = soFar ? `${soFar}/${parts[i]}` : parts[i]
          if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: soFar, dirs: new Map(), files: [] })
          node = node.dirs.get(parts[i])
        }
        node.files.push(file)
      }
      // IDE 行为：目录下没有文件、只有一个子目录时，合并为一条（src/main/java 而不是三层）
      const collapse = (node) => {
        const dirs = new Map()
        for (const [key, child] of node.dirs.entries()) {
          const collapsed = collapse(child)
          if (collapsed.files.length === 0 && collapsed.dirs.size === 1) {
            const [only] = collapsed.dirs.values()
            dirs.set(`${collapsed.name}/${only.name}`, { name: `${collapsed.name}/${only.name}`, path: only.path, dirs: only.dirs, files: only.files })
          } else {
            dirs.set(key, collapsed)
          }
        }
        return { name: node.name, path: node.path, dirs, files: node.files }
      }
      return collapse(root)
    }

    /**
     * Flat list or the IDE-style tree (buildTree has collapsed single-chain
     * folders). Rows are caller-owned — Commit's rows carry staging checkboxes,
     * Log's carry diff stats — this only walks and sorts.
     * @param {{ files: any[], listMode: string, folders: Record<string, boolean>,
     *          fileEl: (file: any, depth: number) => any,
     *          folderEl: (row: { folder: any, open: boolean, depth: number }) => any }} options
     */
    function walkFileTree({ files, listMode, folders, fileEl, folderEl }) {
      if (listMode !== 'tree') return files.map((file) => fileEl(file, 0))
      const render = (node, depth) => {
        const children = []
        for (const folder of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
          const open = folders[folder.path] !== false
          children.push(folderEl({ folder, open, depth }))
          if (open) children.push(...render(folder, depth + 1))
        }
        for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) children.push(fileEl(file, depth))
        return children
      }
      return render(buildTree(files), 0)
    }

    function sameDir(a, b) {
      if (!a || !b) return false
      const norm = (value) => String(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
      return norm(a) === norm(b)
    }

    const kit = {
      COMMIT_KIND,
      LOG_KIND,
      CONSOLE_KIND,
      DIFF_KIND,
      service,
      serviceWhenReady,
      Api,
      useRepoChanges,
      useSessionDirectory,
      useListMode,
      useCompact,
      listModeStore,
      setListModePersisted,
      useLogGroup,
      logGroupStore,
      useLogSort,
      logSortStore,
      useLogColumns,
      logColumnsStore,
      useLogWidths,
      useLogWidthLead,
      logWidthStore,
      LOG_WIDTH_LIMITS,
      LOG_WIDTH_DEFAULTS,
      LOG_WIDTH_KEYS,
      useFileHistory,
      fileHistoryStore,
      useCompare,
      compareStore,
      diffTargetStore,
      preloadedCommits,
      DiffViewHost,
      ensureDiffView,
      closeDiffView,
      activateDiffView,
      openDiff,
      openTab,
      runNetOp,
      switchBranch,
      config,
      pluginConfig,
      applyConfig,
      statusColor,
      dirPartOf,
      nameOf,
      baseName,
      sameDir,
      collectPaths,
      countFiles,
      buildTree,
      walkFileTree,
      ctx: null,
    }
    return kit
  },
})
