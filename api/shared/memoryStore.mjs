import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { CONTAINERS, assertField, rangeOps } from './containers.mjs'

/**
 * Local-dev store: plain objects, optionally saved to a JSON file after every write
 * so data survives a dev-server restart. Not for production — one process only.
 */
export function createMemoryStore({ file = '' } = {}) {
  /** @type {Record<string, Record<string, any>>} */
  let data = {}
  if (file && existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      data = {}
    }
  }
  for (const name of Object.keys(CONTAINERS)) data[name] ||= {}

  const save = () => {
    if (file) writeFileSync(file, JSON.stringify(data, null, 2))
  }
  const clone = (v) => (v == null ? v : structuredClone(v))
  const bucket = (container) => {
    if (!data[container]) throw new Error(`unknown container: ${container}`)
    return data[container]
  }

  return {
    async get(container, id) {
      return clone(bucket(container)[id] ?? null)
    },

    async find(container, where = {}, opts = {}) {
      let docs = Object.values(bucket(container)).filter((doc) =>
        Object.entries(where).every(([field, want]) => {
          assertField(field)
          if (want && typeof want === 'object' && Array.isArray(want.in)) return want.in.includes(doc[field])
          if (want && typeof want === 'object' && 'has' in want) return Array.isArray(doc[field]) && doc[field].includes(want.has)
          const ops = rangeOps(want)
          if (ops) {
            const v = doc[field]
            if (v === undefined || v === null) return false
            return ops.every((op) =>
              op === 'lt' ? v < want.lt : op === 'lte' ? v <= want.lte : op === 'gt' ? v > want.gt : v >= want.gte,
            )
          }
          return doc[field] === want
        }),
      )
      if (opts.contains?.text) {
        const needle = opts.contains.text.toLowerCase()
        docs = docs.filter((doc) =>
          opts.contains.fields.some((f) => String(doc[assertField(f)] ?? '').toLowerCase().includes(needle)),
        )
      }
      if (opts.orderBy) {
        const { field, desc } = opts.orderBy
        assertField(field)
        docs.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (desc ? -1 : 1))
      }
      if (opts.limit) docs = docs.slice(0, opts.limit)
      return docs.map(clone)
    },

    async put(container, doc) {
      bucket(container)[doc.id] = clone(doc)
      save()
      return clone(doc)
    },

    async remove(container, doc) {
      delete bucket(container)[doc.id]
      save()
    },

    async increment(id) {
      const counters = bucket('counters')
      const value = (counters[id]?.value || 0) + 1
      counters[id] = { id, value }
      save()
      return value
    },
  }
}
