/**
 * Standalone dev server.
 *
 * Runs the exact handler the plugin registers, outside DeepSeek Harness, so
 * the workbench can be exercised in a browser (and screenshotted) without
 * booting the host. `node scripts/dev-server.js <repo> [port]`
 */

import http from 'node:http'
import path from 'node:path'
import { GitService } from '../src/git/service.js'
import { createHandler } from '../src/http/routes.js'

const dir = process.argv[2] ?? process.cwd()
const port = Number(process.argv[3] ?? 5178)

const service = new GitService({ defaultDir: path.resolve(dir) })
const handler = createHandler(service, {})

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`git workbench → http://127.0.0.1:${port}/dsh-git/`)
  console.log(`repo: ${path.resolve(dir)}`)
})
