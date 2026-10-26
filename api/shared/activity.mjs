import { randomUUID } from 'node:crypto'

/**
 * The activity log: one entry per change, and per blocked attempt, by people and by
 * API keys alike. Written by runRoute from the `audit` a write handler returns, so a
 * handler can't forget to log. Reads are not logged — only things that change data
 * or were refused.
 *
 * Entries are partitioned by workspace ('global' for people and key changes) and keyed
 * for filtering by `actorId`: the email for a person, `key:<id>` for an API key.
 */
export function actorId(actor) {
  return actor.type === 'key' ? `key:${actor.keyId}` : actor.email
}

export async function recordActivity(store, actor, entry, log) {
  try {
    await store.put('activity', {
      id: randomUUID(),
      at: new Date().toISOString(),
      workspaceId: entry.workspaceId || 'global',
      actorId: actorId(actor),
      actor: { type: actor.type, email: actor.email, label: actor.label, ...(actor.keyId ? { keyId: actor.keyId } : {}) },
      action: entry.action,
      summary: entry.summary,
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      ...(entry.cardId ? { cardId: entry.cardId } : {}),
      ...(entry.changes && Object.keys(entry.changes).length ? { changes: entry.changes } : {}),
      route: entry.route,
      ...(entry.status ? { status: entry.status } : {}),
    })
  } catch (err) {
    // The change itself already succeeded; losing its log line is bad but must not
    // turn a saved card into an error for the user.
    log.error('[kanban] could not write activity entry:', err)
  }
}
