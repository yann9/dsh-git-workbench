// Git calls this as `<editor> <message-file>` for a `reword` todo line.
// The replacement message travels through DSH_REWORD_MESSAGE, so the user's
// text is written verbatim and never parsed as a shell argument.
import { writeFileSync } from 'node:fs'

writeFileSync(process.argv[2], `${process.env.DSH_REWORD_MESSAGE ?? ''}\n`, 'utf8')
