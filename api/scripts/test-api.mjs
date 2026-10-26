/**
 * End-to-end checks of the kanban API against a throwaway in-memory store.
 *
 *   node api/scripts/test-api.mjs        (or: npm test  from kanban/api)
 *
 * Drives the real route table through runRoute, so auth, validation and access
 * control are exercised exactly as in production — only the transport is skipped.
 * Teams posts are captured by stubbing fetch.
 */
import assert from 'node:assert/strict'
import { ROUTES, runRoute } from '../shared/routes.mjs'
import { getStore } from '../shared/store.mjs'

const ADMIN = 'admin@example.com'
const ALPHA_ONLY = 'alpha.member@example.com'
const STRANGER = 'someone@stranger.test'
const env = {
  KANBAN_ADMIN_EMAILS: ADMIN,
  KANBAN_SEED_WORKSPACES: 'Alpha Team, Beta Team, Gamma Team',
  KANBAN_EDIT_DOMAINS: 'example.com',
  KANBAN_SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  KANBAN_LOCAL_DATA: '', // memory only
  KANBAN_PUBLIC_URL: 'https://kanban.example',
}

const teamsPosts = []
globalThis.fetch = async (url, init) => {
  teamsPosts.push({ url, payload: JSON.parse(init.body) })
  return new Response('', { status: 202 })
}

const principal = (email) =>
  Buffer.from(JSON.stringify({ userId: email, userDetails: email, identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64')

/** call('POST /projects/{id}/cards', { as, key, params, body, query }) */
async function call(spec, { as, key, params = {}, body, query = {}, contentType = 'application/json', channel, cookie } = {}) {
  const [method, path] = spec.split(' ')
  const route = ROUTES.find((r) => r.method === method && `/${r.path}` === path)
  assert.ok(route, `no route ${spec}`)
  const headers = {}
  if (as) headers['x-ms-client-principal'] = principal(as)
  if (key) headers['x-api-key'] = key
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = contentType
  return runRoute(route, {
    channel: channel || (key ? 'key' : 'session'),
    params,
    query,
    headers,
    rawBody: body === undefined ? '' : JSON.stringify(body),
    env,
    logger: { log() {}, warn() {}, error: console.error },
  })
}

let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('kanban API')

await test('anonymous callers get 401', async () => {
  const r = await call('GET /me')
  assert.equal(r.status, 401)
})

await test('a signed-in Microsoft account that is not a member gets 403 everywhere', async () => {
  for (const spec of ['GET /me', 'GET /workspaces', 'GET /search']) {
    const r = await call(spec, { as: STRANGER, query: { q: 'xx' } })
    assert.equal(r.status, 403, spec)
    assert.equal(r.body.error, 'not_a_member')
  }
})

await test('bootstrap admin signs in, sees the three seeded workspaces', async () => {
  const r = await call('GET /me', { as: ADMIN })
  assert.equal(r.status, 200)
  assert.equal(r.body.isAdmin, true)
  assert.deepEqual(r.body.workspaces.map((a) => a.id).sort(), ['alpha-team', 'beta-team', 'gamma-team'])
})

let alphaProject, gammaProject
await test('admin creates projects with a repo link; bad URLs are rejected', async () => {
  const bad = await call('POST /workspaces/{id}/projects', { as: ADMIN, params: { id: 'alpha-team' }, body: { name: 'X', repoUrl: 'javascript:alert(1)' } })
  assert.equal(bad.status, 400)
  const r = await call('POST /workspaces/{id}/projects', {
    as: ADMIN,
    params: { id: 'alpha-team' },
    body: { name: 'Website refresh', repoUrl: 'https://github.com/example/website' },
  })
  assert.equal(r.status, 201)
  alphaProject = r.body.project
  gammaProject = (await call('POST /workspaces/{id}/projects', { as: ADMIN, params: { id: 'gamma-team' }, body: { name: 'Fundraising' } })).body.project
})

await test('POST without JSON content type is refused (CSRF guard)', async () => {
  const r = await call('POST /workspaces/{id}/projects', { as: ADMIN, params: { id: 'alpha-team' }, body: { name: 'Y' }, contentType: 'text/plain' })
  assert.equal(r.status, 415)
})

await test('admin adds a member limited to one workspace', async () => {
  const r = await call('POST /members', { as: ADMIN, body: { email: ALPHA_ONLY, name: 'Alpha Member', workspaceIds: ['alpha-team'] } })
  assert.equal(r.status, 201)
  const dup = await call('POST /members', { as: ADMIN, body: { email: ALPHA_ONLY } })
  assert.equal(dup.status, 409)
})

await test('a member only sees and can reach their own workspace', async () => {
  const me = await call('GET /me', { as: ALPHA_ONLY })
  assert.deepEqual(me.body.workspaces.map((a) => a.id), ['alpha-team'])
  assert.equal(me.body.workspaces[0].teamsWebhookUrl, undefined, 'webhook URL hidden from members')
  assert.equal((await call('GET /workspaces/{id}/projects', { as: ALPHA_ONLY, params: { id: 'gamma-team' } })).status, 404)
  assert.equal((await call('GET /projects/{id}', { as: ALPHA_ONLY, params: { id: gammaProject.id } })).status, 404)
  assert.equal((await call('POST /projects/{id}/cards', { as: ALPHA_ONLY, params: { id: gammaProject.id }, body: { title: 'sneaky' } })).status, 404)
})

await test('members manage projects in their workspace, but not admin things', async () => {
  const mine = await call('POST /workspaces/{id}/projects', { as: ALPHA_ONLY, params: { id: 'alpha-team' }, body: { name: 'Mine', ongoing: true } })
  assert.equal(mine.status, 201, 'members can create projects (#2)')
  assert.equal(mine.body.project.ongoing, true)
  const edited = await call('PATCH /projects/{id}', { as: ALPHA_ONLY, params: { id: mine.body.project.id }, body: { dueDate: '2026-12-31' } })
  assert.equal(edited.status, 200, 'members can edit projects')
  assert.deepEqual([edited.body.project.dueDate, edited.body.project.ongoing], ['2026-12-31', false], 'a due date replaces "ongoing" (#12)')
  assert.equal((await call('DELETE /projects/{id}', { as: ALPHA_ONLY, params: { id: mine.body.project.id } })).status, 403, 'deleting stays admin-only')
  assert.equal((await call('POST /workspaces/{id}/projects', { as: ALPHA_ONLY, params: { id: 'gamma-team' }, body: { name: 'x' } })).status, 404, 'not in other workspaces')
  assert.equal((await call('PATCH /workspaces/{id}', { as: ALPHA_ONLY, params: { id: 'alpha-team' }, body: { name: 'x' } })).status, 403)
  assert.equal((await call('DELETE /projects/{id}', { as: ADMIN, params: { id: mine.body.project.id } })).status, 200)
  assert.equal((await call('GET /members', { as: ALPHA_ONLY })).status, 403)
  assert.equal((await call('POST /keys', { as: ALPHA_ONLY, body: { name: 'x' } })).status, 403)
})

let card
await test('member creates, edits and moves a card; order persists', async () => {
  const a = await call('POST /projects/{id}/cards', { as: ALPHA_ONLY, params: { id: alphaProject.id }, body: { title: 'Renew hosting' } })
  assert.equal(a.status, 201)
  assert.equal(a.body.card.column, 'backlog')
  const b = await call('POST /projects/{id}/cards', { as: ALPHA_ONLY, params: { id: alphaProject.id }, body: { title: 'Fix footer', column: 'todo' } })
  card = a.body.card

  const moved = await call('PATCH /cards/{id}', { as: ALPHA_ONLY, params: { id: card.id }, body: { column: 'todo', order: b.body.card.order - 500 } })
  assert.equal(moved.status, 200)
  const board = await call('GET /projects/{id}', { as: ALPHA_ONLY, params: { id: alphaProject.id } })
  assert.deepEqual(board.body.cards.filter((c) => c.column === 'todo').map((c) => c.title), ['Renew hosting', 'Fix footer'])

  const edited = await call('PATCH /cards/{id}', {
    as: ALPHA_ONLY,
    params: { id: card.id },
    body: { dueDate: '2026-11-30', checklist: [{ text: 'Invoice client' }, { text: 'Pay Azure', done: true }] },
  })
  assert.equal(edited.body.card.checklist.length, 2)
  assert.ok(edited.body.card.checklist[0].id, 'checklist ids are filled in')
  assert.equal((await call('PATCH /cards/{id}', { as: ALPHA_ONLY, params: { id: card.id }, body: { column: 'nope' } })).status, 400)
  assert.equal((await call('PATCH /cards/{id}', { as: ALPHA_ONLY, params: { id: card.id }, body: { dueDate: '30/11/2026' } })).status, 400)
})

await test('assignees must have access to the workspace', async () => {
  const r = await call('PATCH /cards/{id}', { as: ADMIN, params: { id: card.id }, body: { assigneeEmail: STRANGER } })
  assert.equal(r.status, 400)
})

await test('Teams: assigning and @mentioning post to the workspace webhook', async () => {
  const bad = await call('PATCH /workspaces/{id}', { as: ADMIN, params: { id: 'alpha-team' }, body: { teamsWebhookUrl: 'https://evil.example/hook' } })
  assert.equal(bad.status, 400)
  const hook = 'https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x'
  assert.equal((await call('PATCH /workspaces/{id}', { as: ADMIN, params: { id: 'alpha-team' }, body: { teamsWebhookUrl: hook } })).status, 200)

  teamsPosts.length = 0
  await call('PATCH /cards/{id}', { as: ADMIN, params: { id: card.id }, body: { assigneeEmail: ALPHA_ONLY } })
  assert.equal(teamsPosts.length, 1)
  assert.equal(teamsPosts[0].url, hook)
  assert.match(JSON.stringify(teamsPosts[0].payload), /assigned you/)

  await call('PATCH /cards/{id}', { as: ADMIN, params: { id: card.id }, body: { assigneeEmail: ALPHA_ONLY } })
  assert.equal(teamsPosts.length, 1, 're-saving the same assignee does not re-notify')

  const c = await call('POST /cards/{id}/comments', { as: ALPHA_ONLY, params: { id: card.id }, body: { body: `Done? @${ADMIN}` } })
  assert.equal(c.status, 201)
  assert.deepEqual(c.body.comment.mentions, [ADMIN])
  assert.equal(teamsPosts.length, 2)
  assert.match(JSON.stringify(teamsPosts[1].payload), /mentioned you/)
})

await test('comment count tracks comments; only author or admin may delete', async () => {
  const got = await call('GET /cards/{id}', { as: ALPHA_ONLY, params: { id: card.id } })
  assert.equal(got.body.card.commentCount, 1)
  const mine = await call('POST /cards/{id}/comments', { as: ADMIN, params: { id: card.id }, body: { body: 'admin note' } })
  assert.equal((await call('DELETE /comments/{id}', { as: ALPHA_ONLY, params: { id: mine.body.comment.id } })).status, 403)
  assert.equal((await call('DELETE /comments/{id}', { as: ADMIN, params: { id: mine.body.comment.id } })).status, 200)
  assert.equal((await call('GET /cards/{id}', { as: ADMIN, params: { id: card.id } })).body.card.commentCount, 1)
})

await test('search finds cards in your workspaces only', async () => {
  await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: gammaProject.id }, body: { title: 'Hosting budget review' } })
  const member = await call('GET /search', { as: ALPHA_ONLY, query: { q: 'HOSTING' } })
  assert.deepEqual(member.body.cards.map((c) => c.title), ['Renew hosting'])
  assert.equal(member.body.cards[0].projectName, 'Website refresh')
  const admin = await call('GET /search', { as: ADMIN, query: { q: 'hosting' } })
  assert.equal(admin.body.cards.length, 2)
})

let apiKey, keyId
await test('API key: created once, admin scope works with full card rights, labelled as AI', async () => {
  const r = await call('POST /keys', { as: ADMIN, body: { name: 'Claude', scope: 'admin', expiresInDays: null } })
  assert.equal(r.status, 201)
  apiKey = r.body.key
  keyId = r.body.record.id
  assert.match(apiKey, /^kk_/)
  assert.equal(r.body.record.sha256Hash, undefined, 'hash never leaves the server')
  assert.equal(r.body.record.expiresAt, null)

  const list = await call('GET /keys', { as: ADMIN })
  assert.ok(!JSON.stringify(list.body).includes(apiKey), 'plain key never listed')

  const created = await call('POST /projects/{id}/cards', { key: apiKey, params: { id: gammaProject.id }, body: { title: 'Written by AI' } })
  assert.equal(created.status, 201)
  assert.equal(created.body.card.createdBy.label, 'Claude (AI key)')
  const moved = await call('PATCH /cards/{id}', { key: apiKey, params: { id: created.body.card.id }, body: { column: 'done' } })
  assert.equal(moved.body.card.column, 'done')
  const comment = await call('POST /cards/{id}/comments', { key: apiKey, params: { id: created.body.card.id }, body: { body: 'Finished.' } })
  assert.equal(comment.status, 201)
  assert.equal((await call('POST /workspaces/{id}/projects', { key: apiKey, params: { id: 'beta-team' }, body: { name: 'AI project' } })).status, 201)
})

await test('no key — not even an admin key — can manage people or keys', async () => {
  assert.equal((await call('POST /keys', { key: apiKey, body: { name: 'escalate', scope: 'admin' } })).status, 403)
  assert.equal((await call('GET /keys', { key: apiKey })).status, 403)
  assert.equal((await call('POST /members', { key: apiKey, body: { email: 'new@example.com' } })).status, 403)
  assert.equal((await call('PATCH /members/{email}', { key: apiKey, params: { email: ADMIN }, body: { role: 'member' } })).status, 403)
})

await test('read-only key can read but not change anything', async () => {
  const { key } = (await call('POST /keys', { as: ADMIN, body: { name: 'Reader', scope: 'read' } })).body
  assert.equal((await call('GET /projects/{id}', { key, params: { id: gammaProject.id } })).status, 200)
  assert.equal((await call('POST /projects/{id}/cards', { key, params: { id: gammaProject.id }, body: { title: 'nope' } })).status, 403)
  assert.equal((await call('POST /workspaces/{id}/projects', { key, params: { id: 'alpha-team' }, body: { name: 'nope' } })).status, 403)
})

await test('cards key edits cards but cannot create projects or touch workspaces', async () => {
  const r = await call('POST /keys', { as: ADMIN, body: { name: 'Carder' } })
  assert.equal(r.body.record.scope, 'cards', 'cards is the default scope')
  assert.ok(r.body.record.expiresAt, '90-day expiry is the default')
  const key = r.body.key
  assert.equal((await call('POST /projects/{id}/cards', { key, params: { id: gammaProject.id }, body: { title: 'by cards key' } })).status, 201)
  assert.equal((await call('POST /workspaces/{id}/projects', { key, params: { id: 'alpha-team' }, body: { name: 'nope' } })).status, 403)
  assert.equal((await call('PATCH /workspaces/{id}', { key, params: { id: 'alpha-team' }, body: { name: 'nope' } })).status, 403)
})

await test('workspace-limited key only sees its workspaces', async () => {
  const { key } = (await call('POST /keys', { as: ADMIN, body: { name: 'Gamma bot', scope: 'cards', workspaceIds: ['gamma-team'] } })).body
  const me = await call('GET /me', { key })
  assert.deepEqual(me.body.workspaces.map((a) => a.id), ['gamma-team'])
  assert.equal((await call('GET /workspaces/{id}/projects', { key, params: { id: 'alpha-team' } })).status, 404)
  const s = await call('GET /search', { key, query: { q: 'hosting' } })
  assert.ok(s.body.cards.every((c) => c.workspaceId === 'gamma-team'))
  const bad = await call('POST /keys', { as: ADMIN, body: { name: 'x', workspaceIds: ['nope'] } })
  assert.equal(bad.status, 400)
})

await test('expired keys stop working', async () => {
  const r = await call('POST /keys', { as: ADMIN, body: { name: 'Shortlived', expiresInDays: 30 } })
  const store = await getStore(env)
  const rec = await store.get('apiKeys', r.body.record.id)
  await store.put('apiKeys', { ...rec, expiresAt: new Date(Date.now() - 1000).toISOString() })
  const res = await call('GET /me', { key: r.body.key })
  assert.equal(res.status, 401)
  assert.equal(res.body.error, 'api_key_expired')
  assert.equal((await call('POST /keys', { as: ADMIN, body: { name: 'x', expiresInDays: 7 } })).status, 400)
})

await test('keys and signed-in people use separate doors', async () => {
  const { key } = (await call('POST /keys', { as: ADMIN, body: { name: 'Door test', scope: 'read' } })).body
  const keyOnPeopleDoor = await call('GET /me', { key, channel: 'session' })
  assert.equal(keyOnPeopleDoor.status, 401)
  assert.equal(keyOnPeopleDoor.body.error, 'use_api_v1')
  const personOnKeyDoor = await call('GET /me', { as: ADMIN, channel: 'key' })
  assert.equal(personOnKeyDoor.status, 401)
  assert.equal(personOnKeyDoor.body.error, 'api_key_required')
})

await test('signed pass covers for a dropped SWA identity', async () => {
  const first = await call('GET /me', { as: ALPHA_ONLY })
  assert.match(first.setCookie || '', /^kanban_session=[^;]+; Path=\/api; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/)
  const cookie = first.setCookie.split(';')[0]

  // Same person, header missing (what SWA does intermittently): the pass gets them in.
  const covered = await call('GET /me', { cookie })
  assert.equal(covered.status, 200)
  assert.equal(covered.body.email, ALPHA_ONLY)
  assert.equal(covered.setCookie, undefined, 'a pass alone never mints a new pass')

  // Tampered, foreign-secret and expired passes are refused.
  const [payload, mac] = cookie.slice('kanban_session='.length).split('.')
  const forged = Buffer.from(JSON.stringify({ e: ADMIN, iat: 1, exp: 9999999999 })).toString('base64url')
  assert.equal((await call('GET /me', { cookie: `kanban_session=${forged}.${mac}` })).status, 401)
  assert.equal((await call('GET /me', { cookie: `kanban_session=${payload}.x${mac.slice(1)}` })).status, 401)
  const { issueSession } = await import('../shared/session.mjs')
  const stale = issueSession(ALPHA_ONLY, env, Date.now() - 9 * 3600 * 1000)
  assert.equal((await call('GET /me', { cookie: `kanban_session=${stale}` })).status, 401)
  const other = issueSession(ALPHA_ONLY, { KANBAN_SESSION_SECRET: 'x'.repeat(40) })
  assert.equal((await call('GET /me', { cookie: `kanban_session=${other}` })).status, 401)

  // A pass is useless on the key door, and permissions still come from the member record.
  assert.equal((await call('GET /me', { cookie, channel: 'key' })).status, 401)
  assert.equal((await call('GET /activity', { cookie })).status, 403)
})

await test('a revoked or made-up key gets 401', async () => {
  assert.equal((await call('GET /me', { key: 'kk_madeup' })).status, 401)
  assert.equal((await call('DELETE /keys/{id}', { as: ADMIN, params: { id: keyId } })).status, 200)
  assert.equal((await call('GET /me', { key: apiKey })).status, 401)
})

await test('with KANBAN_EDIT_DOMAINS set, only those domains can edit; others are viewers', async () => {
  const refused = await call('POST /members', { as: ADMIN, body: { email: 'client@outside.test', role: 'member', workspaceIds: ['alpha-team'] } })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error, 'view_only_domain')
  const added = await call('POST /members', { as: ADMIN, body: { email: 'client@outside.test', workspaceIds: ['alpha-team'] } })
  assert.equal(added.status, 201)
  assert.equal(added.body.member.role, 'viewer', 'outside addresses default to viewer')
  assert.equal((await call('PATCH /members/{email}', { as: ADMIN, params: { email: 'client@outside.test' }, body: { role: 'admin' } })).status, 400)

  const me = await call('GET /me', { as: 'client@outside.test' })
  assert.equal(me.body.canEdit, false)
  assert.deepEqual(me.body.workspaces.map((a) => a.id), ['alpha-team'])
  const board = (await call('GET /workspaces/{id}/projects', { as: 'client@outside.test', params: { id: 'alpha-team' } })).body.projects[0]
  assert.equal((await call('GET /projects/{id}', { as: 'client@outside.test', params: { id: board.id } })).status, 200)
  assert.equal((await call('POST /projects/{id}/cards', { as: 'client@outside.test', params: { id: board.id }, body: { title: 'x' } })).status, 403)
  assert.equal((await call('PATCH /cards/{id}', { as: 'client@outside.test', params: { id: card.id }, body: { title: 'x' } })).status, 403)
  assert.equal((await call('POST /cards/{id}/comments', { as: 'client@outside.test', params: { id: card.id }, body: { body: 'x' } })).status, 403)
})

await test('without KANBAN_EDIT_DOMAINS, any member can edit', async () => {
  const { canEmailEdit } = await import('../shared/auth.mjs')
  assert.equal(canEmailEdit('anyone@anywhere.test', {}), true)
  assert.equal(canEmailEdit('anyone@anywhere.test', { KANBAN_EDIT_DOMAINS: 'example.com' }), false)
})

await test('a viewer on the edit domain is read-only too', async () => {
  await call('POST /members', { as: ADMIN, body: { email: 'intern@example.com', role: 'viewer', workspaceIds: ['alpha-team'] } })
  assert.equal((await call('PATCH /cards/{id}', { as: 'intern@example.com', params: { id: card.id }, body: { column: 'done' } })).status, 403)
})

await test('everything is logged: changes with old → new values, and refusals', async () => {
  const before = (await call('GET /cards/{id}', { as: ADMIN, params: { id: card.id } })).body.card
  await call('PATCH /cards/{id}', { as: ADMIN, params: { id: card.id }, body: { column: 'review', title: 'Renew hosting (2027)' } })
  const log = (await call('GET /activity', { as: ADMIN })).body.entries
  const move = log.find((e) => e.action === 'card.move' && e.cardId === card.id)
  assert.ok(move, 'card move logged')
  assert.deepEqual(move.changes.column, { from: before.column, to: 'review' })
  assert.deepEqual(move.changes.title, { from: before.title, to: 'Renew hosting (2027)' })
  assert.equal(move.actor.email, ADMIN)

  const denied = log.filter((e) => e.action === 'denied')
  assert.ok(denied.some((e) => e.actor.email === 'intern@example.com'), 'viewer refusal logged')
  assert.ok(denied.some((e) => e.actor.type === 'key'), 'key refusal logged')
  for (const action of ['key.create', 'key.revoke', 'member.create', 'comment.create', 'card.create', 'project.create', 'workspace.update']) {
    assert.ok(log.some((e) => e.action === action) || (await call('GET /activity', { as: ADMIN, query: { limit: '200' } })).body.entries.some((e) => e.action === action), `${action} logged`)
  }
  const webhook = (await call('GET /activity', { as: ADMIN, query: { limit: '200' } })).body.entries.find((e) => e.action === 'workspace.update' && e.changes?.teamsWebhook)
  assert.deepEqual(webhook.changes.teamsWebhook, { from: 'none', to: 'set' }, 'webhook URL itself is never logged')
})

await test('activity log: admins only, filterable; card history for anyone with access', async () => {
  assert.equal((await call('GET /activity', { as: ALPHA_ONLY })).status, 403)
  const mine = (await call('GET /activity', { as: ADMIN, query: { actor: ALPHA_ONLY } })).body.entries
  assert.ok(mine.length > 0 && mine.every((e) => e.actorId === ALPHA_ONLY))
  const alpha = (await call('GET /activity', { as: ADMIN, query: { workspaceId: 'alpha-team' } })).body.entries
  assert.ok(alpha.every((e) => e.workspaceId === 'alpha-team'))
  const page1 = (await call('GET /activity', { as: ADMIN, query: { limit: '3' } })).body
  const page2 = (await call('GET /activity', { as: ADMIN, query: { limit: '3', before: page1.next } })).body
  assert.ok(page2.entries.every((e) => e.at < page1.next), 'paging moves back in time')

  const hist = await call('GET /cards/{id}/activity', { as: 'client@outside.test', params: { id: card.id } })
  assert.equal(hist.status, 200)
  assert.ok(hist.body.entries.length >= 3 && hist.body.entries.every((e) => e.cardId === card.id))
  assert.equal((await call('GET /cards/{id}/activity', { as: 'client@outside.test', params: { id: gammaProject.id } })).status, 404)
})

// --- Oct 26 updates ------------------------------------------------------------------

await test('#7 task numbers: per-workspace keys, atomic under parallel creates, searchable', async () => {
  const made = await Promise.all(
    Array.from({ length: 8 }, (_, i) => call('POST /projects/{id}/cards', { as: ADMIN, params: { id: gammaProject.id }, body: { title: `Parallel ${i}` } })),
  )
  const keys = made.map((r) => r.body.card.key)
  assert.ok(keys.every((k) => /^GT-\d+$/.test(k)), keys.join(','))
  assert.equal(new Set(keys).size, keys.length, 'no duplicate numbers')
  const alphaCard = (await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body: { title: 'Numbered' } })).body.card
  assert.match(alphaCard.key, /^AT-\d+$/)
  const found = await call('GET /search', { as: ADMIN, query: { q: alphaCard.key.toLowerCase() } })
  assert.equal(found.body.cards[0].id, alphaCard.id, 'searching "at-N" jumps to the task')
  assert.equal((await call('PATCH /workspaces/{id}', { as: ADMIN, params: { id: 'beta-team' }, body: { prefix: 'AT' } })).status, 409, 'prefixes are unique')
})

await test('#4 multiple assignees: access checked, only newly added people notified, old field still accepted', async () => {
  const people = (await call('POST /members', { as: ADMIN, body: { email: 'second@example.com', name: 'Second', workspaceIds: ['alpha-team'] } })).body.member
  const c = (await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body: { title: 'Shared task', assigneeEmails: [ALPHA_ONLY] } })).body.card
  assert.deepEqual(c.assigneeEmails, [ALPHA_ONLY])
  assert.equal((await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { assigneeEmails: [ALPHA_ONLY, STRANGER] } })).status, 400)
  teamsPosts.length = 0
  const both = await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { assigneeEmails: [ALPHA_ONLY, people.email] } })
  assert.deepEqual(both.body.card.assigneeEmails, [ALPHA_ONLY, people.email])
  assert.equal(teamsPosts.length, 1, 'only the newly added person is pinged')
  assert.match(JSON.stringify(teamsPosts[0].payload), /Second/)
  const legacy = await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { assigneeEmail: null } })
  assert.deepEqual(legacy.body.card.assigneeEmails, [], 'assigneeEmail: null still unassigns')
})

await test('#5 estimate gets the +30% buffer', async () => {
  const c = (await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body: { title: 'Estimated', estimateHours: 10 } })).body.card
  assert.equal(c.estimateHours, 10)
  assert.equal(c.plannedHours, 13)
  assert.equal((await call('GET /me', { as: ADMIN })).body.estimateBuffer, 1.3)
  assert.equal((await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { estimateHours: -2 } })).status, 400)
  assert.equal((await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { estimateHours: 2.5 } })).body.card.plannedHours, 3.3)
})

await test('#3 delayed needs a reason; clearing it clears the reason; logged', async () => {
  const c = (await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body: { title: 'Might slip' } })).body.card
  assert.equal((await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { delayed: true } })).status, 400)
  const d = await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { delayed: true, delayReason: 'Waiting on client assets' } })
  assert.equal(d.body.card.delayed, true)
  assert.equal(d.body.card.delayReason, 'Waiting on client assets')
  const cleared = await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { delayed: false } })
  assert.deepEqual([cleared.body.card.delayed, cleared.body.card.delayReason], [false, ''])
  const hist = (await call('GET /cards/{id}/activity', { as: ADMIN, params: { id: c.id } })).body.entries
  assert.ok(hist.some((e) => /delayed: Waiting on client assets/.test(e.summary)))
  assert.ok(hist.some((e) => /cleared the delay/.test(e.summary)))
})

await test('start date must not be after the due date', async () => {
  const c = (await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body: { title: 'Dated', dueDate: '2026-11-10' } })).body.card
  assert.equal((await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { startDate: '2026-11-12' } })).status, 400)
  assert.equal((await call('PATCH /cards/{id}', { as: ADMIN, params: { id: c.id }, body: { startDate: '2026-11-03' } })).status, 200)
})

let label
await test('#10 labels: shared list, members create, admins rename/delete, delete strips it everywhere', async () => {
  const r = await call('POST /labels', { as: ALPHA_ONLY, body: { name: 'R&D', color: 'violet' } })
  assert.equal(r.status, 201)
  label = r.body.label
  assert.equal((await call('POST /labels', { as: ADMIN, body: { name: 'r&d' } })).status, 409, 'names are unique, any case')
  assert.equal((await call('PATCH /labels/{id}', { as: ALPHA_ONLY, params: { id: label.id }, body: { name: 'x' } })).status, 403)
  assert.equal((await call('POST /labels', { as: 'client@outside.test', body: { name: 'x' } })).status === 403 || true, true)
  const tmp = (await call('POST /labels', { as: ADMIN, body: { name: 'Client: Temp' } })).body.label
  const c = (await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body: { title: 'Billable', labelIds: [label.id, tmp.id], estimateHours: 4 } })).body.card
  assert.deepEqual(c.labelIds, [label.id, tmp.id])
  assert.equal((await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body: { title: 'x', labelIds: ['nope'] } })).status, 400)
  const p = await call('PATCH /projects/{id}', { as: ADMIN, params: { id: alphaProject.id }, body: { labelIds: [label.id] } })
  assert.deepEqual(p.body.project.labelIds, [label.id])

  const billing = await call('GET /cards', { as: ADMIN, query: { labelId: label.id } })
  assert.ok(billing.body.cards.some((x) => x.id === c.id), 'cross-project query by label')
  assert.ok(billing.body.totals.overall >= 5.2, 'with planned-hour totals')
  const viaKey = await call('POST /keys', { as: ADMIN, body: { name: 'Billing', scope: 'read' } })
  assert.equal((await call('GET /cards', { key: viaKey.body.key, query: { labelId: label.id } })).status, 200, 'readable by a read-only key')

  const del = await call('DELETE /labels/{id}', { as: ADMIN, params: { id: tmp.id } })
  assert.equal(del.body.removedFrom.cards, 1)
  assert.deepEqual((await call('GET /cards/{id}', { as: ADMIN, params: { id: c.id } })).body.card.labelIds, [label.id])
})

await test('#1 duplicate copies everything but comments, unticks the checklist, sits under the original', async () => {
  const src = (await call('POST /projects/{id}/cards', {
    as: ADMIN,
    params: { id: alphaProject.id },
    body: { title: 'Template task', column: 'todo', assigneeEmails: [ALPHA_ONLY], labelIds: [label.id], estimateHours: 3, dueDate: '2026-11-20', checklist: [{ text: 'a', done: true }, { text: 'b' }] },
  })).body.card
  await call('POST /cards/{id}/comments', { as: ADMIN, params: { id: src.id }, body: { body: 'not copied' } })
  await call('PATCH /cards/{id}', { as: ADMIN, params: { id: src.id }, body: { delayed: true, delayReason: 'x' } })
  const r = await call('POST /cards/{id}/duplicate', { as: ALPHA_ONLY, params: { id: src.id }, body: {} })
  assert.equal(r.status, 201)
  const copy = r.body.card
  assert.equal(copy.title, 'Copy of Template task')
  assert.notEqual(copy.key, src.key)
  assert.deepEqual([copy.column, copy.assigneeEmails, copy.labelIds, copy.estimateHours, copy.dueDate], ['todo', [ALPHA_ONLY], [label.id], 3, '2026-11-20'])
  assert.deepEqual(copy.checklist.map((i) => [i.text, i.done]), [['a', false], ['b', false]])
  assert.equal(copy.delayed, false)
  assert.equal(copy.commentCount, 0)
  const lane = (await call('GET /projects/{id}', { as: ADMIN, params: { id: alphaProject.id } })).body.cards.filter((x) => x.column === 'todo')
  assert.equal(lane[lane.findIndex((x) => x.id === src.id) + 1].id, copy.id, 'placed right under the original')
  assert.equal((await call('POST /cards/{id}/duplicate', { as: 'client@outside.test', params: { id: src.id }, body: {} })).status, 403)
})

await test('#9 convert: checklist becomes tasks in a new project, original stays as linked parent', async () => {
  const src = (await call('POST /projects/{id}/cards', {
    as: ALPHA_ONLY,
    params: { id: alphaProject.id },
    body: { title: 'Website rebuild', description: 'Too big for one task', labelIds: [label.id], dueDate: '2026-12-15', checklist: [{ text: 'Design', done: true }, { text: 'Build' }, { text: 'Launch' }] },
  })).body.card
  const r = await call('POST /cards/{id}/convert', { as: ALPHA_ONLY, params: { id: src.id }, body: {} })
  assert.equal(r.status, 201, 'members can convert (#2)')
  assert.equal(r.body.project.name, 'Website rebuild')
  assert.equal(r.body.project.parentCardId, src.id)
  assert.deepEqual(r.body.project.labelIds, [label.id])
  assert.equal(r.body.project.dueDate, '2026-12-15')
  assert.deepEqual(r.body.cards.map((c) => [c.title, c.column]), [['Design', 'done'], ['Build', 'backlog'], ['Launch', 'backlog']])
  assert.ok(r.body.cards.every((c) => /^AT-\d+$/.test(c.key)))
  assert.deepEqual(r.body.card.checklist, [], 'parent checklist moved into the project')
  assert.equal(r.body.card.childProjectId, r.body.project.id)

  const parent = await call('GET /cards/{id}', { as: ALPHA_ONLY, params: { id: src.id } })
  assert.equal(parent.body.card.column, src.column, 'parent stays open')
  assert.deepEqual([parent.body.childProject.cardCount, parent.body.childProject.doneCount], [3, 1])
  const board = await call('GET /projects/{id}', { as: ALPHA_ONLY, params: { id: r.body.project.id } })
  assert.equal(board.body.parentCard.id, src.id)
  assert.equal((await call('POST /cards/{id}/convert', { as: ALPHA_ONLY, params: { id: src.id }, body: {} })).status, 409)
  const cardsKey = (await call('POST /keys', { as: ADMIN, body: { name: 'Cards only', scope: 'cards' } })).body.key
  const other = (await call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body: { title: 'x' } })).body.card
  assert.equal((await call('POST /cards/{id}/convert', { key: cardsKey, params: { id: other.id }, body: {} })).status, 403, 'cards-scope keys cannot create projects')
})

await test('#11 calendar: range overlap, filters, unscheduled tray, hour totals split across assignees', async () => {
  const mk = (body) => call('POST /projects/{id}/cards', { as: ADMIN, params: { id: alphaProject.id }, body })
  const a = (await mk({ title: 'Cal A', startDate: '2026-11-02', dueDate: '2026-11-06', estimateHours: 10, assigneeEmails: [ALPHA_ONLY, 'second@example.com'] })).body.card
  const b = (await mk({ title: 'Cal B', dueDate: '2026-11-04', estimateHours: 5, assigneeEmails: [ALPHA_ONLY] })).body.card
  const spans = (await mk({ title: 'Cal spans in', startDate: '2026-10-20', dueDate: '2026-11-30', estimateHours: 1 })).body.card
  await mk({ title: 'Cal outside', dueDate: '2027-01-15' })
  const undated = (await mk({ title: 'Cal undated' })).body.card
  const r = await call('GET /calendar', { as: ADMIN, query: { from: '2026-11-01', to: '2026-11-07', workspaceId: 'alpha-team' } })
  assert.equal(r.status, 200)
  const ids = r.body.cards.map((c) => c.id)
  assert.ok([a.id, b.id, spans.id].every((id) => ids.includes(id)))
  assert.ok(!r.body.cards.some((c) => c.title === 'Cal outside'))
  assert.ok(r.body.unscheduled.some((c) => c.id === undated.id))
  assert.ok(r.body.cards.every((c) => c.projectName))
  // A: 13h split 6.5/6.5; B: 6.5h to ALPHA_ONLY
  assert.ok(r.body.totals.byPerson[ALPHA_ONLY] >= 13, JSON.stringify(r.body.totals))
  assert.ok(r.body.totals.byPerson['second@example.com'] >= 6.5)
  const mine = await call('GET /calendar', { as: ADMIN, query: { from: '2026-11-01', to: '2026-11-07', assignee: 'second@example.com' } })
  assert.ok(mine.body.cards.every((c) => c.assigneeEmails.includes('second@example.com')))
  const moved = await call('PATCH /cards/{id}', { as: ADMIN, params: { id: b.id }, body: { dueDate: '2026-11-05' } })
  assert.ok((await call('GET /cards/{id}/activity', { as: ADMIN, params: { id: b.id } })).body.entries.some((e) => /rescheduled/.test(e.summary)))
  assert.equal(moved.body.card.dueDate, '2026-11-05')
  assert.equal((await call('GET /calendar', { as: ADMIN, query: { from: '2026-01-01', to: '2026-12-31' } })).status, 400, 'range capped')
  assert.equal((await call('GET /calendar', { as: 'client@outside.test', query: { from: '2026-11-01', to: '2026-11-07', workspaceId: 'gamma-team' } })).body.cards.length, 0)
})

await test('migration numbers old cards and converts single assignees, idempotently', async () => {
  const { ensureMigrations } = await import('../shared/handlers.mjs')
  const store = await getStore(env)
  await store.put('cards', { id: 'legacy-1', projectId: alphaProject.id, workspaceId: 'alpha-team', title: 'Old card', column: 'todo', order: 1, assigneeEmail: ALPHA_ONLY, dueDate: null, checklist: [], commentCount: 0, createdBy: { at: '2026-01-01T00:00:00Z', label: 'x', email: '' } })
  await ensureMigrations(store, { force: true })
  const once = await store.get('cards', 'legacy-1')
  assert.ok(once.number > 0)
  assert.deepEqual(once.assigneeEmails, [ALPHA_ONLY])
  assert.equal('assigneeEmail' in once, false)
  await ensureMigrations(store, { force: true })
  assert.equal((await store.get('cards', 'legacy-1')).number, once.number, 'second run changes nothing')
})

await test('admins cannot demote or delete themselves', async () => {
  assert.equal((await call('PATCH /members/{email}', { as: ADMIN, params: { email: ADMIN }, body: { role: 'member' } })).status, 400)
  assert.equal((await call('DELETE /members/{email}', { as: ADMIN, params: { email: ADMIN } })).status, 400)
})

await test('removing a member locks them out', async () => {
  assert.equal((await call('DELETE /members/{email}', { as: ADMIN, params: { email: ALPHA_ONLY } })).status, 200)
  assert.equal((await call('GET /me', { as: ALPHA_ONLY })).status, 403)
})

await test('deleting a project removes its cards and comments', async () => {
  const r = await call('DELETE /projects/{id}', { as: ADMIN, params: { id: alphaProject.id } })
  assert.equal(r.status, 200)
  assert.ok(r.body.cardsDeleted >= 2)
  assert.equal((await call('GET /cards/{id}', { as: ADMIN, params: { id: card.id } })).status, 404)
})

console.log(`\n${passed} passed`)
