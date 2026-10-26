/**
 * Every collection and the field it is partitioned on. Cosmos needs the partition
 * key for point reads and deletes; the memory store ignores it.
 */
export const CONTAINERS = {
  workspaces: 'id',
  members: 'id', // id is the lower-cased email
  projects: 'workspaceId',
  cards: 'projectId',
  comments: 'cardId',
  apiKeys: 'id',
  activity: 'workspaceId', // 'global' for events not tied to one workspace (people, keys)
  labels: 'id', // shared across workspaces
  counters: 'id', // `task-<workspaceId>` → next task number
}

/** Range operators accepted in a `where` value, e.g. { dueDate: { gte: '2026-11-01' } }. */
export const RANGE_OPS = { lt: '<', lte: '<=', gt: '>', gte: '>=' }

export function rangeOps(want) {
  if (!want || typeof want !== 'object' || Array.isArray(want.in) || 'has' in want) return null
  const ops = Object.keys(want).filter((k) => k in RANGE_OPS)
  return ops.length ? ops : null
}

/** Field names are only ever ours, but they are interpolated into Cosmos SQL — keep them boring. */
export function assertField(name) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`bad field name: ${name}`)
  return name
}

export function stripSystemFields(doc) {
  if (!doc) return doc
  const { _rid, _self, _etag, _attachments, _ts, ...rest } = doc
  return rest
}
