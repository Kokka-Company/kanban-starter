# API

The REST API behind the board. API keys use **`https://<your-domain>/api/v1`**. The web app uses the same endpoints at `/api`, which only accept signed-in people. A key sent to `/api` gets `401 use_api_v1`; a request with no key on `/api/v1` gets `401 api_key_required`.

## Authentication

1. In the app, go to **Admin → API keys → Create a key**. Name it after whoever will use it, e.g. `Claude`, and choose:
   - **Permission:**
     - **Read-only:** see boards, cards and comments.
     - **Cards & comments:** create, edit, move, duplicate and delete cards and comments. Projects need an Admin key. This is the default.
     - **Admin:** also projects and workspaces.
   - **Workspaces:** limit the key to some workspaces. None ticked means all workspaces. Admin keys always cover all workspaces.
   - **Expires:** 30 days, 90 days (the default), 1 year, or never.
2. Copy the key (`kk_…`). It is shown only once.
3. Send it with every request:

```
X-Api-Key: kk_…
```

`Authorization: Bearer kk_…` also works. `X-Api-Key` is preferred because Azure Static Web Apps may rewrite the `Authorization` header.

**No key can manage people or API keys**, not even an Admin key. Only a signed-in human admin can, so a leaked key can't give itself more access.

Everything done with a key is recorded in the activity log as `<key name> (AI key)`, and so are refused attempts. Revoke a key on the same admin page; it stops working immediately. An expired key gets `401 api_key_expired`.

For Claude Code, keep the key in an environment variable rather than pasting it into chats:

```sh
export KANBAN_API_KEY=kk_…
export KANBAN=https://<your-domain>/api/v1
```

## Conventions

- Send JSON bodies with `Content-Type: application/json`. Without that header, POST and PATCH return 415.
- Every response is JSON with `ok: true|false`. Errors look like `{ "ok": false, "error": "invalid_input", "message": "…" }`.
- Status codes:
  - **400:** bad input
  - **401:** missing, invalid, revoked or expired key
  - **403:** not allowed with this key's permission (`read_only`, `admin_only`, `human_admin_only`)
  - **404:** not found. Also returned for things in workspaces the key can't see.
  - **409:** conflict
- IDs are opaque strings. Workspace IDs are slugs of their names (e.g. `engineering`); list them with `GET /workspaces`.
- Columns are always one of `backlog`, `todo`, `doing`, `review`, `done`.
- Dates are `YYYY-MM-DD`. Send `null` to clear a date or an assignee.

## Endpoints

Paths are relative to `/api/v1`.


| Method | Path | What it does |
|---|---|---|
| GET | `/me` | Who you are and the workspaces you can see |
| GET | `/workspaces` | Workspaces, each with a project count |
| POST | `/workspaces` | Create an workspace: `{ name }` |
| PATCH | `/workspaces/{id}` | Update an workspace: `{ name?, prefix?, teamsWebhookUrl? }`. `prefix` is the 2–5 character start of its task numbers (`ENG` → `ENG-12`) |
| DELETE | `/workspaces/{id}` | Delete an workspace (only if it has no projects) |
| GET | `/workspaces/{id}/members` | People who can be assigned in this workspace |
| GET | `/workspaces/{id}/projects` | Projects (add `?archived=true` to include archived ones) |
| POST | `/workspaces/{id}/projects` | Create a project: `{ name, description?, repoUrl?, dueDate?, ongoing?, labelIds? }` |
| GET | `/projects/{id}` | The whole board: project, workspace, cards and members |
| PATCH | `/projects/{id}` | Update a project: `{ name?, description?, repoUrl?, archived?, dueDate?, ongoing?, labelIds? }`. Set `ongoing: true` for no end date |
| DELETE | `/projects/{id}` | Delete a project with all its cards and comments |
| GET | `/projects/{id}/cards` | Cards (filter with `?column=todo` and/or `?assignee=email`) |
| POST | `/projects/{id}/cards` | Create a card: `{ title, description?, column?, assigneeEmails?, startDate?, dueDate?, estimateHours?, labelIds?, checklist?, delayed?, delayReason? }` |
| GET | `/cards/{id}` | One card plus its comments |
| PATCH | `/cards/{id}` | Update any of `title, description, column, order, assigneeEmails, startDate, dueDate, estimateHours, labelIds, checklist, delayed, delayReason` |
| DELETE | `/cards/{id}` | Delete a card |
| POST | `/cards/{id}/duplicate` | Copy a card (everything but comments and the delay flag; checklist unticked), placed right under it. Body `{}` |
| POST | `/cards/{id}/convert` | Turn a card into a project in the same workspace. Checklist items become its tasks; the card stays as the linked parent. Body `{}` or `{ name }`. Needs an Admin key |
| GET | `/cards?labelId=&workspaceId=&assignee=&column=` | Cards across projects, with planned-hour totals. For billing, CRM and reports |
| GET | `/labels` | The shared label list |
| POST | `/labels` | Create a label: `{ name, color? }` |
| PATCH/DELETE | `/labels/{id}` | Rename or recolour a label, or delete it (also removes it from every project and card). Admin key |
| GET | `/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&workspaceId=&assignee=&labelId=` | Cards overlapping the range (max 120 days), undated open cards, and planned hours per person |
| GET | `/cards/{id}/comments` | List comments |
| POST | `/cards/{id}/comments` | Add a comment: `{ body }`. Writing `@name@yourcompany.com` in the body mentions that person |
| DELETE | `/comments/{id}` | Delete a comment |
| GET | `/search?q=text` | Search card titles and descriptions (at least 2 characters; returns up to 50). A task key like `ENG-12` finds that task |
| GET | `/members` | List members (Admin key) |
| GET | `/activity` | The activity log, newest first (Admin key). Filters: `?workspaceId=`, `?actor=email-or-key:<id>`, `?before=<ISO time>`, `?limit=` (max 200). Response has `next` for paging |
| GET | `/cards/{id}/activity` | One card's history |

People (`/members`) and keys (`/keys`) can only be changed by a signed-in admin in the app. Keys get `403 human_admin_only` there.

**People and editing:** if `KANBAN_EDIT_DOMAINS` is set, only addresses on those domains can edit; anyone else can be added only as a viewer. Viewers are read-only everywhere.

Notes:
- **Card fields:**
  - `key` (e.g. `ENG-12`) and `number` are assigned automatically.
  - `assigneeEmails` is a list. The older single `assigneeEmail` is still accepted.
  - `estimateHours` is the guess; `plannedHours` (read-only) is the guess plus 30%.
  - Setting `delayed: true` requires a `delayReason`.
  - `startDate` can't be after `dueDate`.
- **Moving a card:** `PATCH /cards/{id}` with `{ "column": "done" }` puts it at the bottom of that column. To place it in a specific spot, also send an `order` number. Cards in a column are sorted by `order`, so pick a number between the two neighbours.
- **Checklists:** send the whole list each time: `[{ "text": "…", "done": false }]`. Keep each existing item's `id`; new items get one automatically.
- **Teams:** assigning someone, or @mentioning them in a comment, posts to that workspace's Teams channel if a webhook is set.

## Examples

```sh
H=(-H "X-Api-Key: $KANBAN_API_KEY" -H "Content-Type: application/json")

# What can I see?
curl -s "${H[@]}" $KANBAN/workspaces

# Projects in Engineering
curl -s "${H[@]}" $KANBAN/workspaces/engineering/projects

# Add a card to a project
curl -s "${H[@]}" -X POST $KANBAN/projects/PROJECT_ID/cards \
  -d '{"title":"Renew domain for 2027","column":"todo","dueDate":"2026-12-01"}'

# Find a card and move it to Done
curl -s "${H[@]}" "$KANBAN/search?q=renew%20domain"
curl -s "${H[@]}" -X PATCH $KANBAN/cards/CARD_ID -d '{"column":"done"}'

# Comment and mention someone
curl -s "${H[@]}" -X POST $KANBAN/cards/CARD_ID/comments \
  -d '{"body":"Renewed until Dec 2027. @someone@yourcompany.com FYI"}'
```
