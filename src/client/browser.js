/**
 * dsh-git-workbench — client entry (thin wiring).
 *
 * The code lives in package-local chunks next to this file (client.*.js),
 * the host module system's native code-splitting unit:
 *   client.i18n.js    strings + error localisation
 *   client.styles.js  design-token stylesheet
 *   client.core.js    api/stores/hooks/git-shared-actions (the kit)
 *   client.ui.js      atoms + overlays (menus, toasts, confirm)
 *   client.shell.js   header chip, dock pill, workspace menu
 *   client.panes.js   commit + log tool windows
 *   client.diff.js    diff body (lazy-loaded on first open)
 *
 * Chunk scripts arrive asynchronously (`require.async`), so `apply` is async
 * and materialises them in dependency order before registering anything — the
 * cordis fiber awaits the plugin function. Inside a chunk, `require` against
 * an already-materialised sibling is synchronous.
 *
 * Loader contract: classic script handing a factory to window.__ModuleLoader__;
 * require resolves the host's shared React instance.
 */
window.__ModuleLoader__.load({
  id: '@yann9/dsh-git-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const name = 'git-workbench-client'
    const pkgName = '@yann9/dsh-git-workbench'
    const inject = ['slots', 'locale']

    /**
     * Dependency order matters: each chunk synchronously requires its
     * predecessors at materialisation, so they must arrive one by one.
     * Started eagerly at factory time so the wait is usually a no-op.
     */
    const ready = (async () => {
      const i18n = await require.async('./client.i18n.js')
      const styles = await require.async('./client.styles.js')
      const core = await require.async('./client.core.js')
      const ui = await require.async('./client.ui.js')
      const shell = await require.async('./client.shell.js')
      const panes = await require.async('./client.panes.js')
      return { i18n, styles, core, ui, shell, panes }
    })()

    async function apply(ctx) {
      const { i18n, styles, core: kit, ui, shell, panes } = await ready
      const { tt } = i18n
      const { injectStyles } = styles
      const { service, serviceWhenReady, COMMIT_KIND, LOG_KIND, CONSOLE_KIND, DIFF_KIND } = kit
      const { Safe, GitIcon } = ui
      const { GitHeaderWidget, GitHeroBranch, GitSettingsTab, GitPluginSection, CardAction, makeEntry } = shell
      const { CommitPane, LogPane, ConsolePane } = panes

      kit.ctx = ctx
      injectStyles()
      // Follow DSH's stored language preference (Settings → General) instead of
      // the raw browser language; the dictionaries also join the locale registry
      // so other plugins can bind this namespace.
      ctx.effect(() => i18n.attachLocale(ctx.locale), 'git-workbench: locale dictionaries')
      if (!ctx.slots || typeof ctx.slots.register !== 'function') {
        console.warn('[git-workbench] slot registry unavailable; Git panels not registered')
        return
      }

      /** Every slot-visible component renders inside the error boundary. */
      const guarded = (Component) =>
        function Guarded(props) {
          i18n.useLocaleVersion()
          return h(Safe, null, h(Component, props))
        }

      // Session-scoped panes receive `sessionId` + the host store hooks; pass
      // them through so the repo always follows the session being viewed.
      const CommitPaneBody = (props) => h(Safe, null, h(CommitPane, props))
      const LogPaneBody = (props) => h(Safe, null, h(LogPane, props))
      const ConsolePaneBody = (props) => h(Safe, null, h(ConsolePane, props))

      const registerTypes = (hostCtx) => {
        const definitions = [
          {
            id: `${COMMIT_KIND}/page`,
            kind: COMMIT_KIND,
            keepMounted: true,
            priority: 'builtin',
            title: () => tt('tab.commit'),
            guide: [
              {
                id: 'commit',
                order: 10,
                title: () => tt('guide.commit.title'),
                description: () => tt('guide.commit.desc'),
                icon: GitIcon,
              },
            ],
          },
          {
            id: `${LOG_KIND}/page`,
            kind: LOG_KIND,
            keepMounted: true,
            priority: 'builtin',
            title: () => tt('tab.log'),
            guide: [
              {
                id: 'log',
                order: 11,
                title: () => tt('guide.log.title'),
                description: () => tt('guide.log.desc'),
                icon: GitIcon,
              },
            ],
          },
          {
            id: `${CONSOLE_KIND}/page`,
            kind: CONSOLE_KIND,
            keepMounted: true,
            priority: 'builtin',
            title: () => tt('tab.console'),
            guide: [
              {
                id: 'console',
                order: 12,
                title: () => tt('guide.console.title'),
                description: () => tt('guide.console.desc'),
                icon: GitIcon,
              },
            ],
          },
          {
            id: `${DIFF_KIND}/page`,
            kind: DIFF_KIND,
            keepMounted: true,
            priority: 'builtin',
            title: () => tt('tab.diffPane'),
          },
        ]
        const disposers = []
        // A refused id never becomes free later (the type is registered for the
        // page's life), so retrying that failure only buries the real error
        // under 60 identical warnings.
        let refused = false

        const registerAll = () => {
          const tabs = service(hostCtx, 'sidebarRightTabs')
          if (!tabs || typeof tabs.register !== 'function') return false
          for (const definition of definitions) {
            try {
              const dispose = tabs.register(definition)
              if (typeof dispose === 'function') disposers.push(dispose)
            } catch (error) {
              refused = /already registered/i.test(String(error?.message ?? ''))
              console.warn(`[git-workbench] tab type ${definition.kind} was refused`, error)
              return false
            }
          }
          return true
        }

        if (registerAll()) return () => disposers.forEach((dispose) => dispose())

        let tries = 0
        const timer = window.setInterval(() => {
          tries += 1
          if (registerAll() || refused || tries > 60) {
            window.clearInterval(timer)
            if (!refused && tries > 60) console.warn('[git-workbench] right sidebar never became available; the Git tabs are disabled')
          }
        }, 250)

        return () => {
          window.clearInterval(timer)
          disposers.forEach((dispose) => dispose())
        }
      }

      const disposeTypes = registerTypes(ctx)

      const pane = (key, Component) => {
        // The pane stays mounted across a language switch, so it must subscribe
        // to the locale revision itself; the host does not remount slot content.
        const LocaleAware = (props) => {
          i18n.useLocaleVersion()
          return h(Component, props)
        }
        return ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key }, LocaleAware),
        )
      }
      pane(`${COMMIT_KIND}/page`, CommitPaneBody)
      pane(`${LOG_KIND}/page`, LogPaneBody)
      pane(`${CONSOLE_KIND}/page`, ConsolePaneBody)
      // Fallback home for the diff: a session without messages has no
      // conversation view ring, so a file click would otherwise land nowhere.
      pane(`${DIFF_KIND}/page`, (props) => h(Safe, null, h(kit.DiffViewHost, props)))

      // dsh-better-sidebar owns a second tab bar and lists only what its own
      // registry holds, so the panes have to be offered to it as well. The
      // lookup stays soft on purpose: that plugin is optional, and naming it in
      // `dsh.client.inject` would break every install that does not have it.
      // `bottomOnly` keeps the offer inside that bar — without the flag the
      // plugin also mints a native right-sidebar type per registration, which
      // would shadow the ones registered above.
      const offerToBetterSidebar = (sidebar) => {
        if (typeof sidebar?.registerTab !== 'function') return null
        const offers = [
          ['git-workbench:commit', 'tab.commit', 'guide.commit.desc', CommitPaneBody, 10],
          ['git-workbench:log', 'tab.log', 'guide.log.desc', LogPaneBody, 11],
          ['git-workbench:console', 'tab.console', 'guide.console.desc', ConsolePaneBody, 12],
        ]
        const disposers = []
        for (const [id, titleKey, descriptionKey, Component, order] of offers) {
          try {
            const dispose = sidebar.registerTab({
              id,
              title: () => tt(titleKey),
              description: () => tt(descriptionKey),
              icon: () => h(GitIcon),
              order,
              single: true,
              bottomOnly: true,
              // That bar hands the component a session scope rather than the
              // host slot's store hooks, and `ctx.sessions` is off-limits
              // without an `inject` entry the plugin cannot demand. The scope
              // already carries the session cwd — that plugin subscribes to
              // the session list and re-renders on it — so the pane's lookup is
              // answered straight from the scope instead of the store.
              component: ({ scope }) => h(Component, {
                sessionId: scope?.sessionId ?? '',
                useSessions: scope?.sessionId
                  ? (selector) => selector({ byId: { [scope.sessionId]: { cwd: scope.cwd ?? '' } } })
                  : undefined,
              }),
            })
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch (error) {
            console.warn(`[git-workbench] better-sidebar refused the ${id} tab`, error)
          }
        }
        return () => disposers.forEach((dispose) => dispose())
      }
      ctx.effect(() => serviceWhenReady(ctx, 'betterSidebar', offerToBetterSidebar), 'git-workbench: better-sidebar tabs')

      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({ name: 'conversation.session.header.actions', id: 'git-workbench', order: 20 }, guarded(GitHeaderWidget)),
      )

      // Only the *new session* screen gets a branch picker: the hero option row
      // is not rendered once the conversation has messages, so nothing clutters
      // an ongoing session (its branch lives in the header chip).
      ctx.slots.inject('conversation.hero.options', () =>
        ctx.slots.register({ name: 'conversation.hero.options', id: 'git-workbench', order: 20 }, guarded(GitHeroBranch)),
      )

      // Settings → 插件: every knob is editable in the app, not only in YAML.
      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          { name: 'settings.plugins.tab', id: 'git-workbench', order: 40, label: () => tt('settings.tab') },
          guarded(GitSettingsTab),
        ),
      )
      // …and on the plugin's own detail page in the plugin manager, which is
      // where users expect "configure this plugin" to live. The bundle slot
      // renders between the description and 包含的组件; `detail.section` would
      // put the same form at the very bottom instead.
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: pkgName, order: 40 }, guarded(GitPluginSection)),
      )

      ctx.slots.inject('deliverables.file.actions', () =>
        ctx.slots.register({ name: 'deliverables.file.actions', id: 'git-workbench', order: 10 }, guarded(CardAction)),
      )
      ctx.slots.inject('deliverables.review.file.actions', () =>
        ctx.slots.register({ name: 'deliverables.review.file.actions', id: 'git-workbench', order: 10 }, guarded(CardAction)),
      )

      ctx.slots.inject('sidebar.right.tab.files.actions', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.files.actions', id: 'git-workbench', order: 20 }, guarded(makeEntry())),
      )

      if (disposeTypes) ctx.effect(() => disposeTypes, 'git-workbench: tab types')
    }

    return { name, inject, apply }
  },
})
