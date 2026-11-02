export type Point = { x: number; y: number }

/** Where a dnd-kit drag's pointer is now: where it started plus how far it has moved. */
export function pointerOf(e: { activatorEvent: Event | null; delta: { x: number; y: number } }): Point | null {
  const start = e.activatorEvent as Partial<PointerEvent> | null
  if (!start || typeof start.clientX !== 'number' || typeof start.clientY !== 'number') return null
  return { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y }
}

export function inside(el: Element | null | undefined, p: Point | null) {
  if (!el || !p) return false
  const r = el.getBoundingClientRect()
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
}
