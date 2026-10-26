/** A workspace's initial in a ring. Swap in real logos here if you have them. */
export default function WorkspaceMark({ name, size = 40 }: { id?: string; name: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border-2 border-line-strong bg-muted font-display font-semibold text-fg-muted"
      style={{ height: size, width: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {name.trim()[0]?.toUpperCase() || '?'}
    </span>
  )
}
