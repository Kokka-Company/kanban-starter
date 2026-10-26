/**
 * Local dev server for the kanban API — no Azure Functions Core Tools needed.
 *
 *   node api/scripts/dev-server.mjs         (or: npm run dev:api  from kanban/)
 *
 * Serves the same route table the deployed Functions use, with settings from
 * api/local.settings.json. Vite proxies /api/* here (kanban/vite.config.ts).
 *
 * Auth: there is no Static Web Apps layer locally, so nobody is "signed in". The
 * caller is KANBAN_DEV_USER from local.settings.json, or an `x-dev-user: <email>`
 * header to act as someone else (curl testing). Neither exists in production: this
 * file is never deployed and the Functions entry point does not read them.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ROUTES, runRoute } from '../shared/routes.mjs'
import { clearSessionCookieHeader } from '../shared/session.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 7072)
const env = loadSettings()

/** "workspaces/{id}/projects" -> /^workspaces\/([^/]+)\/projects$/ with names ['id'] */
const compiled = ['key', 'session'].flatMap((channel) =>
  ROUTES.map((route) => {
    const names = []
    const pattern = route.path.replace(/\{(\w+)\}/g, (_, n) => {
      names.push(n)
      return '([^/]+)'
    })
    return { route, channel, names, re: new RegExp(`^/api/${channel === 'key' ? 'v1/' : ''}${pattern}/?$`) }
  }),
)

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const match = compiled
    .filter((c) => c.route.method === req.method)
    .map((c) => ({ c, m: c.re.exec(url.pathname) }))
    .find((x) => x.m)
  if (req.method === 'GET' && url.pathname === '/api/logout') {
    res.writeHead(302, { location: '/', 'set-cookie': clearSessionCookieHeader() })
    return res.end()
  }
  if (!match) return json(res, 404, { ok: false, error: 'not_found' })

  let rawBody = ''
  for await (const chunk of req) rawBody += chunk

  const params = Object.fromEntries(match.c.names.map((n, i) => [n, decodeURIComponent(match.m[i + 1])]))
  const result = await runRoute(match.c.route, {
    params,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    rawBody,
    env,
    logger: console,
    devUser: String(req.headers['x-dev-user'] || env.KANBAN_DEV_USER || ''),
    channel: match.c.channel,
  })
  json(res, result.status, result.body, result.setCookie)
})

server.listen(PORT, () => {
  console.log(`kanban API dev server on http://localhost:${PORT}`)
  console.log(`  store: ${env.COSMOS_ENDPOINT ? 'Cosmos DB' : `local file ${env.KANBAN_LOCAL_DATA}`}`)
  console.log(`  acting as: ${env.KANBAN_DEV_USER || '(nobody — send x-dev-user)'}`)
})

function json(res, status, body, setCookie) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(setCookie ? { 'set-cookie': setCookie } : {}),
  })
  res.end(JSON.stringify(body))
}

function loadSettings() {
  let values = {}
  try {
    values = JSON.parse(readFileSync(resolve(here, '../local.settings.json'), 'utf8')).Values || {}
  } catch {
    console.warn('No api/local.settings.json — using defaults (copy local.settings.json.example).')
  }
  const merged = { ...values, ...process.env }
  merged.KANBAN_LOCAL_DATA ||= resolve(here, '../.local-data.json')
  return merged
}
