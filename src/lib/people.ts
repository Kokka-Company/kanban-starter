import { useEffect, useState } from 'react'
import { api, type Me, type Person } from './api'

/** Everyone who can see at least one of your workspaces, merged and sorted — for person pickers. */
export function useVisiblePeople(me: Me) {
  const [people, setPeople] = useState<Person[]>([])
  useEffect(() => {
    let live = true
    Promise.all(me.workspaces.map((a) => api.workspaceMembers(a.id).then((r) => r.members).catch(() => [] as Person[]))).then((lists) => {
      if (!live) return
      const byEmail = new Map<string, Person>()
      for (const p of lists.flat()) byEmail.set(p.email, p)
      setPeople([...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name)))
    })
    return () => {
      live = false
    }
  }, [me.workspaces])
  return people
}
