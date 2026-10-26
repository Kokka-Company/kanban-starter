/**
 * Azure Static Web Apps puts the signed-in user in the `x-ms-client-principal`
 * request header as base64-encoded JSON. The header is injected by the platform and
 * cannot be forged from the browser: SWA strips any client-supplied copy first.
 *
 * Copied from api/shared/principal.mjs — the two api folders deploy to different
 * Static Web Apps, so they cannot import from each other.
 *
 * @typedef {{ userId: string, userDetails: string, identityProvider: string, userRoles: string[], email: string }} Principal
 */

/**
 * @param {{ get(name: string): string | null | undefined } | Record<string, any>} headers
 * @returns {Principal | null}
 */
export function readClientPrincipal(headers) {
  const raw = headerValue(headers, 'x-ms-client-principal')
  if (!raw) return null

  let parsed
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const userDetails = String(parsed.userDetails || '')
  return {
    userId: String(parsed.userId || ''),
    userDetails,
    identityProvider: String(parsed.identityProvider || ''),
    userRoles: Array.isArray(parsed.userRoles) ? parsed.userRoles.map(String) : [],
    // For the Entra ID / Microsoft provider userDetails is the user's email address.
    email: userDetails.includes('@') ? userDetails.toLowerCase() : '',
  }
}

/** Works for both a Fetch `Headers` (Azure Functions) and a Node header object (dev server). */
export function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || ''
  const v = headers?.[name]
  return Array.isArray(v) ? v[0] || '' : v || ''
}
