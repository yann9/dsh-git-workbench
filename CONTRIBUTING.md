# Contributing

## Read these three first

- [docs/architecture.md](docs/architecture.md): what host and client each own, and how the chunks are split.
- [docs/jetbrains-parity.md](docs/jetbrains-parity.md): why the interaction looks the way it does; section 9 is the rulebook for any new UI.
- [docs/development.md](docs/development.md): the development loop, tests, screenshots and releases.

## Development loop

```bash
dsh plugin --profile web add link:<absolute path of the repo>
dsh web          # restart after a code change
npm test         # 137 cases, against real git repositories
```

There is no build step: do not introduce a bundler, do not generate artifacts. Both host and client must load directly in Node / the host's module system.

## Code conventions

- **Every git call goes through `src/git/exec.js`**: `spawn('git', argv)`, no string concatenation, no shell. Add new commands there rather than opening another spawn in business code.
- **Writes go through `GitService`** and are serialized by `withWriteLock`; never change the index around it.
- **The host's response is the UI's only source of truth**: the client must not derive ahead/behind, status letters or writability itself.
- Comments are in English and only one line, only where the "why" is not obvious.
- Commit messages follow Conventional Commits: `feat:` / `fix:` / `docs:` / `chore:` / `refactor:`, with the motivation in the body. A breaking change is `feat(scope)!:` or a `BREAKING CHANGE:` in the body; the GitHub Release notes group by exactly these prefixes (see [docs/development.md](docs/development.md)).

## When changing the UI

- Copy must be added to both `zh` and `en` in `src/client/client.i18n.js`; a missing entry falls back to Chinese and then to the key, but a new feature must not exist in only one language.
- Colors come from tokens only: `--gwb-*` and `--dsw-alias-*`. Text hues use the `-ink` variant, text on a colored surface uses `--gwb-on-hue`; never hard-code `#fff` or `#ec1313`.
- Anything that rewrites the worktree goes through the shared confirmation dialog; a destructive button names its verb, is red, and parks focus on "Cancel".
- Check the panel at its ~440 px minimum width: no horizontal scrolling, no label broken into `or…`.
- Look at both light and dark; changing an inline style function such as `statusColor` means updating its contract test in `test/client-pure.test.js`.

## When changing git behaviour

- Write cases against real repositories, never mock git. A case that needs destructive state backs it up and restores it itself, and checks `git status`, the `git diff` hash and the stash list at the end.
- Tests must not touch the DSH data directory a developer uses day to day (`~/.dsh`); use a temporary directory or a separate data directory.
- Errors have to read well in a Chinese interface: a new git refusal goes into the rule table in `localizeError`.

## PR checklist

- [ ] `npm test` is green
- [ ] `node --check` covers every changed host / client file
- [ ] New copy exists in both Chinese and English
- [ ] Dark / light and wide / narrow have all been looked at
- [ ] Docs are in sync: the feature table (`docs/features.md`), the endpoint table (`docs/api.md`), `CHANGELOG.md`
- [ ] No absolute path from your machine, account name or token went into code or docs

## Security

Do not open a public issue for a security problem — see [SECURITY.md](SECURITY.md).
