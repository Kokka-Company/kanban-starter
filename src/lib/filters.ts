/** True when a card passes a PersonFilter selection. */
export function matchesPeople(assignees: string[], selected: string[]) {
  if (!selected.length) return true
  return selected.some((s) => (s === 'none' ? assignees.length === 0 : assignees.includes(s)))
}
