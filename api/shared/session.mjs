import { createHmac, timingSafeEqual } from 'node:crypto'
import { headerValue } from './principal.mjs'

/**
 * Our own sign-in pass, as a backstop for SWA. SWA is supposed to attach the
 * signed-in person (x-ms-client-principal) to every API request, but on the live
 * site it intermittently doesn't — the person is signed in, the header just isn't
 * there. So whenever a request *does* arrive with a real principal for a member, the
 * API hands the browser a short-lived pass: the email and an expiry, signed with
 * KANBAN_SESSION_SECRET. A later request missing the header can show the pass instead.
 *
 * The pass can't be forged without the secret, can't be read by page scripts
 * (HttpOnly), is never sent cross-site (SameSite=Strict) and only goes to /api.
 * Without KANBAN_SESSION_SECRET the backstop is off and SWA's header is the only way in.
 */

export const SESSION_COOKIE = 'kanban_session'
const TTL_SECONDS = 8 * 60 * 60
/** Reissue once a pass is this old, so active users never hit the 8-hour wall. */
const REFRESH_AFTER_SECONDS = 15 * 60

function secret(env) {
  const s = String(env.KANBAN_SESSION_SECRET || '')
  return s.length >= 32 ? s : ''
}

const sign = (payload, key) => createHmac('sha256', key).update(payload).digest('base64url')

export function issueSession(email, env, now = Date.now()) {
  const key = secret(env)
  if (!key) return null
  const iat = Math.floor(now / 1000)
  const payload = Buffer.from(JSON.stringify({ e: email, iat, exp: iat + TTL_SECONDS })).toString('base64url')
  return `${payload}.${sign(payload, key)}`
}

function readCookie(headers, name) {
  for (const part of headerValue(headers, 'cookie').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

/** @returns {{ email: string, iat: number } | null} */
export function readSession(headers, env, now = Date.now()) {
  const key = secret(env)
  const token = readCookie(headers, SESSION_COOKIE)
  if (!key || !token) return null
  const [payload, mac] = token.split('.')
  if (!payload || !mac) return null
  const want = Buffer.from(sign(payload, key))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try {
    const { e, iat, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof e !== 'string' || !e.includes('@') || typeof exp !== 'number' || exp * 1000 <= now) return null
    return { email: e.toLowerCase(), iat }
  } catch {
    return null
  }
}

export function needsRefresh(session, now = Date.now()) {
  return !session || now / 1000 - session.iat > REFRESH_AFTER_SECONDS
}

export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; Path=/api; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
}
