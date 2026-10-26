import { CosmosClient } from '@azure/cosmos'
import { CONTAINERS, RANGE_OPS, assertField, rangeOps, stripSystemFields } from './containers.mjs'

/**
 * Production store on Azure Cosmos DB for NoSQL. One database with shared throughput
 * (the free tier covers the first 1000 RU/s); containers inherit it.
 *
 * Containers are created on first use, so a fresh database needs no manual setup.
 */
export function createCosmosStore({ endpoint, key, database, throughput }) {
  const client = new CosmosClient({ endpoint, key })
  let ready = null

  const init = () =>
    (ready ||= (async () => {
      const { database: db } = await client.databases.createIfNotExists({ id: database, throughput })
      const handles = {}
      for (const [name, pk] of Object.entries(CONTAINERS)) {
        const { container } = await db.containers.createIfNotExists({
          id: name,
          partitionKey: { paths: [`/${pk}`] },
        })
        handles[name] = container
      }
      return handles
    })().catch((err) => {
      ready = null // let the next request retry instead of caching the failure
      throw err
    }))

  async function container(name) {
    const handles = await init()
    if (!handles[name]) throw new Error(`unknown container: ${name}`)
    return handles[name]
  }

  async function query(name, sql, parameters, partitionKey) {
    const c = await container(name)
    const { resources } = await c.items
      .query({ query: sql, parameters }, partitionKey !== undefined ? { partitionKey } : {})
      .fetchAll()
    return resources.map(stripSystemFields)
  }

  return {
    async get(name, id) {
      if (CONTAINERS[name] === 'id') {
        const c = await container(name)
        try {
          const { resource } = await c.item(id, id).read()
          return stripSystemFields(resource ?? null)
        } catch (err) {
          if (err.code === 404) return null
          throw err
        }
      }
      const [doc] = await query(name, 'SELECT * FROM c WHERE c.id = @id', [{ name: '@id', value: id }])
      return doc ?? null
    },

    async find(name, where = {}, opts = {}) {
      const clauses = []
      const parameters = []
      let partitionKey
      Object.entries(where).forEach(([field, want], i) => {
        const p = `@p${i}`
        if (want && typeof want === 'object' && Array.isArray(want.in)) {
          clauses.push(`ARRAY_CONTAINS(${p}, c.${assertField(field)})`)
        } else if (want && typeof want === 'object' && 'has' in want) {
          clauses.push(`ARRAY_CONTAINS(c.${assertField(field)}, ${p})`)
          parameters.push({ name: p, value: want.has })
          return
        } else if (rangeOps(want)) {
          rangeOps(want).forEach((op, j) => {
            clauses.push(`c.${assertField(field)} ${RANGE_OPS[op]} ${p}_${j}`)
            parameters.push({ name: `${p}_${j}`, value: want[op] })
          })
          return
        } else {
          clauses.push(`c.${assertField(field)} = ${p}`)
          if (field === CONTAINERS[name]) partitionKey = want
        }
        parameters.push({ name: p, value: want?.in ?? want })
      })
      if (opts.contains?.text) {
        parameters.push({ name: '@q', value: opts.contains.text })
        const ors = opts.contains.fields.map((f) => `CONTAINS(c.${assertField(f)}, @q, true)`)
        clauses.push(`(${ors.join(' OR ')})`)
      }
      const top = opts.limit ? `TOP ${Number(opts.limit) | 0} ` : ''
      const order = opts.orderBy ? ` ORDER BY c.${assertField(opts.orderBy.field)} ${opts.orderBy.desc ? 'DESC' : 'ASC'}` : ''
      const sql = `SELECT ${top}* FROM c${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}${order}`
      return query(name, sql, parameters, partitionKey)
    },

    async put(name, doc) {
      const c = await container(name)
      const { resource } = await c.items.upsert(doc)
      return stripSystemFields(resource)
    },

    /** Atomic: Cosmos applies the partial-update `incr` server-side, so parallel callers never get the same number. */
    async increment(id) {
      const c = await container('counters')
      const bump = async () => (await c.item(id, id).patch([{ op: 'incr', path: '/value', value: 1 }])).resource.value
      try {
        return await bump()
      } catch (err) {
        if (err.code !== 404) throw err
        try {
          await c.items.create({ id, value: 0 })
        } catch (e) {
          if (e.code !== 409) throw e // someone else created it first: fine
        }
        return bump()
      }
    },

    async remove(name, doc) {
      const c = await container(name)
      try {
        await c.item(doc.id, doc[CONTAINERS[name]]).delete()
      } catch (err) {
        if (err.code !== 404) throw err
      }
    },
  }
}
