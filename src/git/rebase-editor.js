// Git calls this as `<editor> <todo-file>` after GIT_SEQUENCE_EDITOR is set.
// The plan itself travels through DSH_REBASE_TODO, so no shell quoting of the
// todo content is ever involved: only two paths, fixed by the host.
import { copyFileSync } from 'node:fs'

copyFileSync(process.env.DSH_REBASE_TODO, process.argv[2])
