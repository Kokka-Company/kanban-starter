import { useState } from 'react'
import type { ActivityEntry } from '../lib/api'

/** One activity-log line, with the old → new details folded away. */
export default function ActivityRow({ entry: e, workspaceName }: { entry: ActivityEntry; workspaceName?: string }) {
  const [open, setOpen] = useState(false)
  const denied = e.action === 'denied'
  const hasChanges = e.changes && Object.keys(e.changes).length > 0
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] text-fg-subtle" title={new Date(e.at).toLocaleString()}>
          {new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
        <span className={e.actor.type === 'key' ? 'text-accent' : 'text-fg'}>{e.actor.label}</span>
        <span className={denied ? 'text-red-700' : 'text-fg-muted'}>{e.summary}</span>
        {workspaceName && <span className="text-xs text-fg-subtle">{workspaceName}</span>}
        {hasChanges && (
          <button className="ml-auto font-mono text-[11px] text-fg-subtle hover:text-accent" onClick={() => setOpen(!open)}>
            {open ? 'hide' : 'details'}
          </button>
        )}
      </div>
      {open && hasChanges && (
        <pre className="mt-2 overflow-x-auto border border-line bg-surface p-3 font-mono text-[11px] text-fg-muted">
          {JSON.stringify(e.changes, null, 2)}
        </pre>
      )}
    </li>
  )
}
