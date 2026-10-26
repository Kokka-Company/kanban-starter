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
