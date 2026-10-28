# Security policy

## Supported versions

Security fixes target the latest published version only.

| Version | Supported |
|---|---|
| The latest minor | ✅ |
| Anything older | ❌ |

## Reporting a problem

**Do not open a public issue.** Report it privately through the GitHub repository's
*Security → Report a vulnerability* (Security Advisory), or contact the maintainer directly.
Please include the affected version, the reproduction steps, the impact (for example "arbitrary
code execution in the victim's repository"), and the fix direction you have in mind, if any.

Once confirmed, you are credited in the release that ships the fix (unless you prefer to stay anonymous).

## What the plugin promises not to do

These boundaries are part of the design; anything that gets around them is a security defect:

- **No shell**: every git call is `spawn('git', argv)`; paths, branch names, remote names and script
  names all appear as argv segments and are validated against allow lists. User input is never
  concatenated into a command string.
- **No arbitrary command execution**: the pre-commit checks only run named scripts that already exist
  in the repository's `package.json`, and the name must match `^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$`;
  no endpoint accepts a command line.
- **No credentials collected**: network operations set `GIT_TERMINAL_PROMPT=0` and never ask for a
  password or token in the page.
- **No escape from the repository directory**: path parameters reject `..` escapes, and a command's
  `cwd` is fixed to the resolved repository root.
- **Writes are serialized**: every index / worktree change goes through `withWriteLock`, so they never
  trample each other.
- **Cross-site requests rejected**: a request whose `Origin` does not match `Host` returns 403;
  `/dsh-git/` exposes only the API, with no static directory, and request bodies cap at 2 MB.
- **Fully read-only if asked**: under `readOnly: true` every POST except `/config` returns 403, and
  the UI renders no write entry points either.

## Known non-goals

- The plugin does not defend against **malicious repository content** (a crafted `.git/config`,
  huge files, hostile fields). It is built for "your own repository", not for opening untrusted
  repositories inside a sandbox.
- The plugin runs with the same privileges as the DSH host process. Do not run `dsh web` under a
  highly privileged account while opening untrusted pages in the same session.
