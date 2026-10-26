import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Check, Copy, Trash2 } from 'lucide-react'
import {
  api,
  errorMessage,
  timeAgo,
  KEY_SCOPE_LABELS,
  type ActivityEntry,
  type Workspace,
  type ApiKeyRecord,
  type KeyScope,
  type Label,
  type LabelColor,
  type Member,
  type Role,
} from '../lib/api'
import { useMe } from '../lib/me'
import { ErrorNote, PageHeader, Spinner } from '../components/ui'
import ActivityRow from '../components/ActivityRow'
import { LabelChip } from '../components/pickers'
import { useLabels } from '../lib/labels'

type Tab = 'members' | 'workspaces' | 'labels' | 'keys' | 'activity'

/** `/admin` — who can get in and see what, workspace settings, API keys for AI, and the activity log. */
export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('members')
  const tabs: [Tab, string][] = [
    ['members', 'People & access'],
    ['workspaces', 'Workspaces & Teams'],
    ['keys', 'API keys'],
    ['labels', 'Labels'],
    ['activity', 'Activity log'],
  ]
  return (
    <>
      <PageHeader title="Admin" />
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px shrink-0 border-b-2 px-4 py-2 text-sm transition ${tab === id ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'members' && <MembersTab />}
      {tab === 'workspaces' && <WorkspacesTab />}
      {tab === 'keys' && <KeysTab />}
      {tab === 'labels' && <LabelsTab />}
      {tab === 'activity' && <ActivityTab />}
    </>
  )
}

// --- people & access ----------------------------------------------------------------

function MembersTab() {
  const { me, reload } = useMe()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([api.members(), api.workspaces()])
      setMembers(m.members)
      setWorkspaces(a.workspaces)
    } catch (err) {
      setError(errorMessage(err, 'Could not load members.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const update = async (m: Member, patch: Partial<{ role: Role; workspaceIds: string[]; name: string }>) => {
    setError('')
    try {
      const { member } = await api.updateMember(m.email, patch)
      setMembers((prev) => prev?.map((x) => (x.email === m.email ? { ...x, ...member } : x)) ?? null)
      if (m.email === me.email) void reload()
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'))
    }
  }

  const remove = async (m: Member) => {
    if (!window.confirm(`Remove ${m.email}? They will lose access immediately.`)) return
    try {
      await api.deleteMember(m.email)
      setMembers((prev) => prev?.filter((x) => x.email !== m.email) ?? null)
    } catch (err) {
      setError(errorMessage(err, 'Could not remove.'))
    }
  }

  if (!members) return error ? <ErrorNote message={error} /> : <Spinner />

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-fg-muted">
        People sign in with their Microsoft account. Only email addresses listed here can get in, and each person only
        sees the workspaces ticked for them. <strong className="text-fg">Members</strong> can edit cards,{' '}
        <strong className="text-fg">Viewers</strong> can only look, and <strong className="text-fg">Admins</strong>{' '}
        see every workspace and manage projects, people and keys.
        {me.editDomains.length > 0 && <> Only @{me.editDomains.join(', @')} addresses can edit; anyone else can be added as a viewer.</>}
      </p>
      <ErrorNote message={error} />
      <AddMember workspaces={workspaces} onAdded={(m) => setMembers((prev) => [...(prev ?? []), m])} />

      <div className="overflow-x-auto glass">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
              <th className="px-4 py-2 font-medium">Person</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Workspaces</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {members.map((m) => {
              const isAdmin = m.role === 'admin'
              return (
                <tr key={m.email}>
                  <td className="px-4 py-3">
                    <input
                      className="w-full border-0 bg-transparent p-0 font-medium text-fg focus:ring-0"
                      defaultValue={m.name}
                      onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== m.name && void update(m, { name: e.target.value.trim() })}
                      aria-label={`Name for ${m.email}`}
                    />
                    <div className="text-xs text-fg-subtle">{m.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    {m.bootstrapAdmin ? (
                      <span className="text-fg-muted" title="Set in the KANBAN_ADMIN_EMAILS app setting">Admin (owner)</span>
                    ) : (
                      <RoleSelect value={m.role} canEdit={m.canEdit} onChange={(role) => void update(m, { role })} />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isAdmin ? (
                      <span className="text-fg-subtle">All workspaces</span>
                    ) : (
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {workspaces.map((a) => (
                          <label key={a.id} className="flex items-center gap-1.5 whitespace-nowrap">
                            <input
                              type="checkbox"
                              checked={m.workspaceIds.includes(a.id)}
                              onChange={(e) =>
                                void update(m, {
                                  workspaceIds: e.target.checked ? [...m.workspaceIds, a.id] : m.workspaceIds.filter((id) => id !== a.id),
                                })
                              }
                            />
                            {a.name}
                          </label>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {m.email !== me.email && !m.bootstrapAdmin && (
                      <button className="btn-danger p-1.5" title="Remove" onClick={() => void remove(m)}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AddMember({ workspaces, onAdded }: { workspaces: Workspace[]; onAdded: (m: Member) => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const { me } = useMe()
  const [role, setRole] = useState<Role>('member')
  const domainCanEdit =
    me.editDomains.length === 0 || me.editDomains.includes(email.trim().toLowerCase().split('@')[1] || '') || !email.includes('@')
  const effective: Role = domainCanEdit ? role : 'viewer'
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { member } = await api.createMember({ email, name, role: effective, workspaceIds })
      onAdded(member)
      setEmail('')
      setName('')
      setRole('member')
      setWorkspaceIds([])
    } catch (err) {
      setError(errorMessage(err, 'Could not add.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 glass p-5">
      <h2 className="font-medium text-fg">Add a person</h2>
      <div className="grid gap-3 sm:grid-cols-[2fr_1.5fr_8rem]">
        <input className="input" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
        <input className="input" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
        <RoleSelect value={effective} canEdit={domainCanEdit} onChange={setRole} />
      </div>
      {!domainCanEdit && (
        <p className="text-xs text-amber-800">
          This address isn't @{me.editDomains.join(', @')}, so they can only be added as a viewer.
        </p>
      )}
      {effective !== 'admin' && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {workspaces.map((a) => (
            <label key={a.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={workspaceIds.includes(a.id)}
                onChange={(e) => setWorkspaceIds((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id)))}
              />
              {a.name}
            </label>
          ))}
        </div>
      )}
      <ErrorNote message={error} />
      <button className="btn-primary" disabled={busy || !email}>Add person</button>
    </form>
  )
}

/** Admin / Member / Viewer. Addresses outside the edit domains only get Viewer. */
function RoleSelect({ value, canEdit, onChange }: { value: Role; canEdit: boolean; onChange: (r: Role) => void }) {
  return (
    <select
      className="input w-32 py-1"
      value={value}
      disabled={!canEdit}
      title={canEdit ? undefined : 'Only company addresses can edit'}
      onChange={(e) => onChange(e.target.value as Role)}
      aria-label="Role"
    >
      {canEdit && <option value="admin">Admin</option>}
      {canEdit && <option value="member">Member</option>}
      <option value="viewer">Viewer</option>
    </select>
  )
}

// --- workspaces & Teams ---------------------------------------------------------------

function WorkspacesTab() {
  const { reload } = useMe()
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setWorkspaces((await api.workspaces()).workspaces)
    } catch (err) {
      setError(errorMessage(err, 'Could not load workspaces.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
      await Promise.all([load(), reload()])
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  if (!workspaces) return error ? <ErrorNote message={error} /> : <Spinner />

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-fg-muted">
        To send Teams notifications for an workspace, create a Workflow in the Teams channel from the template “Post to a
        channel when a webhook request is received”. Then paste its URL here. People get pinged when they're assigned a
        card or @mentioned in a comment.
      </p>
      <ErrorNote message={error} />
      <ul className="divide-y divide-line glass">
        {workspaces.map((a) => (
          <WorkspaceRow key={a.id} workspace={a} onSave={(patch) => act(() => api.updateWorkspace(a.id, patch))} onDelete={() => act(() => api.deleteWorkspace(a.id))} />
        ))}
      </ul>
      <form
        className="flex max-w-lg gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            await api.createWorkspace(newName)
            setNewName('')
          })
        }}
      >
        <input className="input" placeholder="New workspace name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="btn-primary shrink-0" disabled={!newName.trim()}>Add workspace</button>
      </form>
    </div>
  )
}

function WorkspaceRow({
  workspace,
  onSave,
  onDelete,
}: {
  workspace: Workspace
  onSave: (patch: Partial<Pick<Workspace, 'name' | 'teamsWebhookUrl' | 'prefix'>>) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [name, setName] = useState(workspace.name)
  const [prefix, setPrefix] = useState(workspace.prefix || '')
  const [hook, setHook] = useState(workspace.teamsWebhookUrl || '')
  const dirty = name !== workspace.name || prefix !== (workspace.prefix || '') || hook !== (workspace.teamsWebhookUrl || '')

  return (
    <li className="grid gap-3 p-5 md:grid-cols-[14rem_6rem_1fr_auto] md:items-end">
      <div>
        <label className="label" htmlFor={`ag-${workspace.id}`}>Name</label>
        <input id={`ag-${workspace.id}`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor={`pre-${workspace.id}`} title="Task numbers look like PREFIX-12">Prefix</label>
        <input
          id={`pre-${workspace.id}`}
          className="input font-mono uppercase"
          maxLength={5}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
        />
      </div>
      <div>
        <label className="label" htmlFor={`hook-${workspace.id}`}>Teams Workflow webhook URL</label>
        <input
          id={`hook-${workspace.id}`}
          className="input font-mono text-xs"
          placeholder="https://….logic.azure.com/… or https://….powerplatform.com/…"
          value={hook}
          onChange={(e) => setHook(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={!dirty} onClick={() => void onSave({ name, teamsWebhookUrl: hook, ...(prefix !== (workspace.prefix || '') ? { prefix } : {}) })}>Save</button>
        <button
          className="btn-danger"
          title={workspace.projectCount ? 'Delete its projects first' : 'Delete workspace'}
          disabled={Boolean(workspace.projectCount)}
          onClick={() => window.confirm(`Delete ${workspace.name}?`) && void onDelete()}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  )
}

// --- labels (#10) ----------------------------------------------------------------------

function LabelsTab() {
  const { labels, colors, reload } = useLabels()
  const [name, setName] = useState('')
  const [color, setColor] = useState<LabelColor>('slate')
  const [error, setError] = useState('')

  const act = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
      await reload()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-fg-muted">
        Labels are shared by every workspace, like epics in Jira: one label per client, R&amp;D, internal work and so on.
        Use the same label on projects and tasks so billing and the CRM can pull everything for it in one go
        (<code className="bg-muted px-1">GET /api/v1/cards?labelId=…</code>). Anyone who can edit can create labels;
        only admins rename or delete them. Deleting a label removes it from every project and task.
      </p>
      <ErrorNote message={error} />
      <form
        className="glass flex flex-wrap items-end gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            await api.createLabel(name.trim(), color)
            setName('')
          })
        }}
      >
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="lb-name">New label</label>
          <input id="lb-name" className="input" placeholder="e.g. Client: Acme" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <ColorSelect value={color} colors={colors} onChange={setColor} id="lb-color" />
        <button className="btn-primary" disabled={!name.trim()}>Add label</button>
      </form>
      {labels.length === 0 ? (
        <p className="text-sm text-fg-subtle">No labels yet.</p>
      ) : (
        <ul className="glass divide-y divide-line">
          {labels.map((l) => (
            <LabelRow key={`${l.id}-${l.name}-${l.color}`} label={l} colors={colors} onSave={(patch) => act(() => api.updateLabel(l.id, patch))} onDelete={() => act(() => api.deleteLabel(l.id))} />
          ))}
        </ul>
      )}
    </div>
  )
}

function ColorSelect({ value, colors, onChange, id }: { value: LabelColor; colors: LabelColor[]; onChange: (c: LabelColor) => void; id: string }) {
  return (
    <div>
      <label className="label" htmlFor={id}>Colour</label>
      <select id={id} className="input w-32 capitalize" value={value} onChange={(e) => onChange(e.target.value as LabelColor)}>
        {colors.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    </div>
  )
}

function LabelRow({ label, colors, onSave, onDelete }: { label: Label; colors: LabelColor[]; onSave: (p: Partial<Pick<Label, 'name' | 'color'>>) => Promise<void>; onDelete: () => Promise<void> }) {
  const [name, setName] = useState(label.name)
  const [color, setColor] = useState<LabelColor>(label.color)
  const dirty = name.trim() !== label.name || color !== label.color
  return (
    <li className="flex flex-wrap items-end gap-3 px-5 py-4">
      <div className="w-40 pb-2">
        <LabelChip label={{ ...label, name: name || label.name, color }} />
      </div>
      <div className="min-w-48 flex-1">
        <label className="label" htmlFor={`lbn-${label.id}`}>Name</label>
        <input id={`lbn-${label.id}`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <ColorSelect value={color} colors={colors} onChange={setColor} id={`lbc-${label.id}`} />
      <button className="btn-primary" disabled={!dirty || !name.trim()} onClick={() => void onSave({ name: name.trim(), color })}>Save</button>
      <button className="btn-danger" title="Delete label" onClick={() => window.confirm(`Delete "${label.name}"? It is removed from every project and task.`) && void onDelete()}>
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  )
}

// --- API keys -------------------------------------------------------------------------

const EXPIRY_CHOICES: [string, number | null][] = [
  ['30 days', 30],
  ['90 days', 90],
  ['1 year', 365],
  ['Never', null],
]

const SCOPE_HELP: Record<KeyScope, string> = {
  read: 'Can see boards, cards and comments. Cannot change anything.',
  cards: 'Can create, edit, move and delete cards and comments. Cannot touch projects, workspaces, people or keys.',
  admin: 'Everything a key can do, including projects and workspaces. Still cannot manage people or create keys.',
}

function KeysTab() {
  const { me } = useMe()
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null)
  const [name, setName] = useState('Claude')
  const [scope, setScope] = useState<KeyScope>('cards')
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([])
  const [expiry, setExpiry] = useState<number | null>(90)
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const workspaceName = Object.fromEntries(me.workspaces.map((a) => [a.id, a.name]))

  const load = useCallback(async () => {
    try {
      setKeys((await api.keys()).keys)
    } catch (err) {
      setError(errorMessage(err, 'Could not load keys.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const r = await api.createKey({ name, scope, workspaceIds: scope === 'admin' ? [] : workspaceIds, expiresInDays: expiry })
      setFresh({ key: r.key, name: r.record.name })
      setCopied(false)
      void load()
    } catch (err) {
      setError(errorMessage(err, 'Could not create the key.'))
    }
  }

  const revoke = async (k: ApiKeyRecord) => {
    if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) return
    try {
      await api.revokeKey(k.id)
      void load()
    } catch (err) {
      setError(errorMessage(err, 'Could not revoke.'))
    }
  }

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-fg-muted">
        API keys let Claude or a script use the board through the REST API. Give each key the least it needs, and limit
        it to the workspaces it works on. Everything a key does is recorded in the activity log under the key's name, e.g.
        “Claude (AI key)”. No key can manage people or create other keys; only a signed-in admin can. Keys use{' '}
        <code className="bg-muted px-1">/api/v1</code> on this site; see{' '}
        <code className="bg-muted px-1">kanban/API.md</code>.
      </p>
      <ErrorNote message={error} />

      {fresh && (
        <div className="border border-amber-400/40 bg-amber-400/10 p-5">
          <p className="mb-2 text-sm font-medium text-amber-800">
            Copy the key for “{fresh.name}” now. It won't be shown again.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap border border-amber-400/30 bg-surface px-3 py-2 font-mono text-xs">{fresh.key}</code>
            <button
              className="btn-primary shrink-0"
              onClick={() => {
                void navigator.clipboard.writeText(fresh.key)
                setCopied(true)
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button className="mt-3 text-xs text-amber-800 underline" onClick={() => setFresh(null)}>I've saved it</button>
        </div>
      )}

      <form onSubmit={create} className="glass space-y-4 p-5">
        <h2 className="font-medium text-fg">Create a key</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="key-name">Name</label>
            <input id="key-name" className="input" placeholder="e.g. Claude" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="key-scope">Permission</label>
            <select id="key-scope" className="input" value={scope} onChange={(e) => setScope(e.target.value as KeyScope)}>
              {(Object.keys(KEY_SCOPE_LABELS) as KeyScope[]).map((s) => (
                <option key={s} value={s}>{KEY_SCOPE_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="key-exp">Expires</label>
            <select
              id="key-exp"
              className="input"
              value={expiry === null ? 'never' : String(expiry)}
              onChange={(e) => setExpiry(e.target.value === 'never' ? null : Number(e.target.value))}
            >
              {EXPIRY_CHOICES.map(([label, days]) => (
                <option key={label} value={days === null ? 'never' : String(days)}>{label}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-fg-subtle">{SCOPE_HELP[scope]}</p>
        {scope !== 'admin' && (
          <div>
            <span className="label">Workspaces</span>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {me.workspaces.map((a) => (
                <label key={a.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={workspaceIds.includes(a.id)}
                    onChange={(e) => setWorkspaceIds((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id)))}
                  />
                  {a.name}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-fg-subtle">{workspaceIds.length ? 'Only the ticked workspaces.' : 'None ticked means all workspaces.'}</p>
          </div>
        )}
        <button className="btn-primary" disabled={!name.trim()}>Create key</button>
      </form>

      {!keys ? (
        <Spinner />
      ) : keys.length === 0 ? (
        <p className="text-sm text-fg-subtle">No keys yet.</p>
      ) : (
        <ul className="glass divide-y divide-line">
          {keys.map((k) => {
            const dead = k.revoked || k.expired
            return (
              <li key={k.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm ${dead ? 'opacity-50' : ''}`}>
                <span className="font-medium text-fg">{k.name}</span>
                <span className="border border-accent/40 px-1.5 py-0.5 font-mono text-[11px] text-accent">{KEY_SCOPE_LABELS[k.scope]}</span>
                <span className="text-xs text-fg-subtle">
                  {k.workspaceIds.length ? k.workspaceIds.map((id) => workspaceName[id] || id).join(', ') : 'All workspaces'}
                </span>
                <code className="font-mono text-xs text-fg-subtle">{k.keyPreview}</code>
                <span className="text-xs text-fg-subtle">
                  {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : 'never used'} ·{' '}
                  {k.expiresAt ? `${k.expired ? 'expired' : 'expires'} ${new Date(k.expiresAt).toLocaleDateString()}` : 'no expiry'}
                </span>
                <span className="flex-1" />
                {k.revoked ? (
                  <span className="text-xs">Revoked</span>
                ) : k.expired ? (
                  <span className="text-xs">Expired</span>
                ) : (
                  <button className="btn-danger py-1" onClick={() => void revoke(k)}>Revoke</button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// --- activity log ---------------------------------------------------------------------

function ActivityTab() {
  const { me } = useMe()
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [who, setWho] = useState('')
  const [error, setError] = useState('')
  const workspaceName: Record<string, string> = { global: 'People & keys', ...Object.fromEntries(me.workspaces.map((a) => [a.id, a.name])) }

  const load = useCallback(
    async (before?: string) => {
      setError('')
      try {
        const r = await api.activity({ workspaceId, actor: who.trim(), before })
        setEntries((prev) => (before ? [...(prev ?? []), ...r.entries] : r.entries))
        setNext(r.next)
      } catch (err) {
        setError(errorMessage(err, 'Could not load the activity log.'))
      }
    },
    [workspaceId, who],
  )

  useEffect(() => {
    setEntries(null)
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-fg-muted">
        Every change made by people and by API keys, newest first, with old → new values. Refused attempts are shown in red.
      </p>
      <div className="flex flex-wrap gap-2">
        <select className="input w-56" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="Workspace">
          <option value="">All workspaces</option>
          {Object.entries(workspaceName).map(([id, n]) => (
            <option key={id} value={id}>{n}</option>
          ))}
        </select>
        <input
          className="input w-72"
          placeholder="Filter by email or key:<id>"
          defaultValue={who}
          onKeyDown={(e) => e.key === 'Enter' && setWho((e.target as HTMLInputElement).value)}
          onBlur={(e) => setWho(e.target.value)}
          aria-label="Who"
        />
      </div>
      <ErrorNote message={error} />
      {!entries ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="text-sm text-fg-subtle">Nothing logged yet.</p>
      ) : (
        <ul className="glass divide-y divide-line">
          {entries.map((e) => (
            <ActivityRow key={e.id} entry={e} workspaceName={workspaceName[e.workspaceId] || e.workspaceId} />
          ))}
        </ul>
      )}
      {next && (
        <button className="btn-ghost border border-line-strong" onClick={() => void load(next)}>
          Load older
        </button>
      )}
    </div>
  )
}
