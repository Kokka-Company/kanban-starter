/**
 * Teams notifications through a Teams *Workflows* webhook ("When a Teams webhook
 * request is received" → post card to a channel). Old Microsoft 365 Connector
 * webhooks are being retired, so they are not supported.
 *
 * Each workspace can have its own webhook URL (set on the admin page). A failed post is
 * logged and swallowed: a Teams outage must never stop someone moving a card.
 */

/** Hosts Teams Workflows webhook URLs are served from. Admin-set, but no reason to POST anywhere else. */
const ALLOWED_HOST_SUFFIXES = ['.logic.azure.com', '.powerplatform.com', '.webhook.office.com']

export function isAllowedWebhookUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && ALLOWED_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s))
}

/** Deep link to the card, or '' when KANBAN_PUBLIC_URL isn't set (the post then has no button). */
function cardLink(env, card) {
  const base = String(env.KANBAN_PUBLIC_URL || '').replace(/\/+$/, '')
  return base ? `${base}/p/${encodeURIComponent(card.projectId)}?card=${encodeURIComponent(card.id)}` : ''
}

/**
 * An Adaptive Card that @mentions people. Mentions use the msteams entity format;
 * if a workflow doesn't resolve them, Teams still shows the person's name.
 *
 * @param {{ heading: string, body: string, people: { email: string, name: string }[], link: string }} opts
 */
function adaptiveCard({ heading, body, people, link }) {
  const mentionText = people.map((p) => `<at>${p.name}</at>`).join(', ')
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: heading, weight: 'Bolder', wrap: true },
            ...(people.length ? [{ type: 'TextBlock', text: mentionText, wrap: true }] : []),
            ...(body ? [{ type: 'TextBlock', text: body, wrap: true, isSubtle: true, maxLines: 6 }] : []),
          ],
          actions: link ? [{ type: 'Action.OpenUrl', title: 'Open card', url: link }] : [],
          msteams: {
            width: 'Full',
            entities: people.map((p) => ({
              type: 'mention',
              text: `<at>${p.name}</at>`,
              mentioned: { id: p.email, name: p.name },
            })),
          },
        },
      },
    ],
  }
}

async function post(url, payload, logger) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) logger.warn(`[teams] webhook responded ${res.status}`)
  } catch (err) {
    logger.warn(`[teams] webhook failed: ${err?.message || err}`)
  }
}

export async function notifyAssigned({ env, logger, workspace, project, card, assignee, actor }) {
  if (!workspace?.teamsWebhookUrl || !assignee) return
  if (assignee.email && assignee.email === actor.email) return // assigning yourself is not news
  await post(
    workspace.teamsWebhookUrl,
    adaptiveCard({
      heading: `${actor.label} assigned you "${card.title}" in ${project.name}`,
      body: card.dueDate ? `Due ${card.dueDate}` : '',
      people: [assignee],
      link: cardLink(env, card),
    }),
    logger,
  )
}

export async function notifyMentioned({ env, logger, workspace, project, card, people, comment, actor }) {
  const targets = people.filter((p) => p.email !== actor.email)
  if (!workspace?.teamsWebhookUrl || !targets.length) return
  await post(
    workspace.teamsWebhookUrl,
    adaptiveCard({
      heading: `${actor.label} mentioned you on "${card.title}" in ${project.name}`,
      body: comment.body,
      people: targets,
      link: cardLink(env, card),
    }),
    logger,
  )
}
