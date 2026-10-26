import { app } from '@azure/functions'
import { ROUTES, runRoute } from '../../shared/routes.mjs'
import { clearSessionCookieHeader } from '../../shared/session.mjs'

/**
 * Registers every entry in the shared route table twice:
 *   /api/<path>     for signed-in people (SWA requires login on this prefix)
 *   /api/v1/<path>  for API keys (SWA leaves it open; only a key is accepted)
 * Each is a thin wrapper: collect params/query/body, hand off to runRoute, return its
 * {status, body}. See staticwebapp.config.json for the matching route rules.
 *
 * Both prefixes are open at the SWA layer: SWA's "authenticated" route rule turned out
 * to bounce signed-in people intermittently, so the gatekeeping is all in runRoute.
 */
const CHANNELS = [
  { channel: 'session', prefix: '', tag: '' },
  { channel: 'key', prefix: 'v1/', tag: 'v1_' },
]

for (const { channel, prefix, tag } of CHANNELS) {
  for (const route of ROUTES) {
    const name = `${tag}${route.method}_${route.path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_')}`
    app.http(name, {
      methods: [route.method],
      authLevel: 'anonymous',
      route: prefix + route.path,
      handler: async (request, context) => {
        const result = await runRoute(route, {
          params: request.params || {},
          query: Object.fromEntries(new URL(request.url).searchParams),
          headers: request.headers,
          rawBody: route.method === 'POST' || route.method === 'PATCH' ? await request.text() : '',
          env: process.env,
          logger: context,
          channel,
        })
        const headers = { 'cache-control': 'no-store' }
        if (result.setCookie) headers['set-cookie'] = result.setCookie
        return { status: result.status, jsonBody: result.body, headers }
      },
    })
  }
}

// /logout lands here (staticwebapp.config.json): drop our pass, then SWA's own sign-out.
app.http('logout', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'logout',
  handler: async () => ({
    status: 302,
    headers: {
      location: '/.auth/logout?post_logout_redirect_uri=/',
      'set-cookie': clearSessionCookieHeader(),
      'cache-control': 'no-store',
    },
  }),
})
