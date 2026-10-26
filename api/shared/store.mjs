import { createMemoryStore } from './memoryStore.mjs'

export { CONTAINERS } from './containers.mjs'

/**
 * The storage contract both backends implement:
 *
 *   get(container, id)                 -> doc | null
 *   find(container, where, opts)       -> doc[]
 *       where: { field: value } equality, { field: { in: [...] } }, or ranges
 *              { field: { gte: a, lt: b } } (lt, lte, gt, gte),
 *              or { field: { has: value } } — the array field contains value
 *       opts:  { contains: { fields: [...], text } }  case-insensitive OR across fields
 *              { orderBy: { field, desc } }
 *              { limit }
 *   put(container, doc)                -> doc   (upsert)
 *   remove(container, doc)
 *   increment(counterId)               -> next integer (atomic; starts at 1)
 */

let cached = null

/**
 * Cosmos when COSMOS_ENDPOINT is set (production), otherwise an in-memory store that
 * persists to KANBAN_LOCAL_DATA (local dev). Cosmos is imported lazily so local dev
 * never needs the SDK to load.
 */
export async function getStore(env) {
  if (cached) return cached
  if (env.COSMOS_ENDPOINT) {
    const { createCosmosStore } = await import('./cosmosStore.mjs')
    cached = createCosmosStore({
      endpoint: env.COSMOS_ENDPOINT,
      key: env.COSMOS_KEY,
      database: env.COSMOS_DATABASE || 'kanban',
      throughput: Number(env.COSMOS_DB_THROUGHPUT || 400),
    })
  } else {
    cached = createMemoryStore({ file: env.KANBAN_LOCAL_DATA || '' })
  }
  return cached
}
