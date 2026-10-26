# kanban-starter

A simple, private kanban board for small companies. It has the parts of Jira people actually use, and nothing else.

**Workspaces → Projects → Board.** Every board has five fixed columns: Backlog, To Do, Doing, Review, Done.

- **Cards:** title, description, assignee, due date, checklist, and comments with @mentions.
- **Finding cards:** search across every board, plus filters on each board (by assignee, overdue, or text).
- **Sign-in and access:** people sign in with Microsoft, and each person sees only the workspaces they're given.
- **Roles:** Admin, Member and Viewer. You can also limit editing to your company's email domain.
- **REST API for AI agents and scripts:** keys have a permission level (read-only, cards & comments, or admin), optional workspace limits and an expiry date.
- **Activity log:** every change is recorded with old → new values, and so is every refused attempt. Each card shows its own history.
- **Teams notifications:** a message is posted when someone is assigned a card or @mentioned.
- **Auto-refresh:** everyone sees each other's changes within 15 seconds.

**Left out on purpose:** priorities, labels, attachments, sprints, story points, epics, custom workflows, custom fields and reports.

It runs on **Azure Static Web Apps (Free) + Azure Functions + Cosmos DB (free tier)**, so a small team pays **$0 per month**.

The look is deliberately plain white and grey, as a placeholder for your own brand. See [Make it yours](#make-it-yours).

→ How it fits together: [ARCHITECTURE.md](ARCHITECTURE.md) · API reference: [API.md](API.md) · Security: [SECURITY.md](SECURITY.md)

---

## Run it locally (no Azure needed)

Locally, the API saves to a JSON file and you act as the user named in your settings file.

```sh
git clone https://github.com/Kokka-Company/kanban-starter.git
cd kanban-starter
npm install --legacy-peer-deps
(cd api && npm install)
cp api/local.settings.json.example api/local.settings.json   # set KANBAN_ADMIN_EMAILS + KANBAN_DEV_USER to your email

npm run dev:api     # API on http://localhost:7072, data in api/.local-data.json
npm run dev         # app on http://localhost:5174
npm run test:api    # 30 end-to-end API checks: access control, keys, logging, sessions
```

To act as someone else from curl, send `x-dev-user: their@email`. The dev server is never deployed, so this shortcut doesn't exist in production.

## Deploy to Azure

You need the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and an account that can create a resource group. Cosmos DB must be enabled on the subscription: `az provider register -n Microsoft.DocumentDB`.

**1. Provision** the resource group, a free-tier Cosmos DB, the Static Web App and its settings:

```sh
az login
SUBSCRIPTION_ID=<your-subscription-id> \
KANBAN_ADMIN_EMAILS=you@yourcompany.com \
KANBAN_SEED_WORKSPACES="Engineering,Marketing,Operations" \
KANBAN_EDIT_DOMAINS=yourcompany.com \
NAME_PREFIX=acme-kanban \
bash api/scripts/provision-azure.sh
```

**2. Deploy:**

```sh
npm run build
(cd api && npm install --omit=dev)
npx -y @azure/static-web-apps-cli deploy ./dist --api-location ./api \
  --api-language node --api-version 20 --env production \
  --app-name acme-kanban --resource-group acme-kanban-rg --subscription-id <your-subscription-id>
```

**3. Optional custom domain:** add a DNS **CNAME** from e.g. `kanban.yourcompany.com` to the app's `*.azurestaticapps.net` hostname. If your DNS is on Cloudflare, set the record to **DNS only** (grey cloud). Then run:

```sh
az staticwebapp hostname set -n acme-kanban -g acme-kanban-rg --hostname kanban.yourcompany.com
```

Azure issues the HTTPS certificate automatically. See [Custom domains with Azure Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/custom-domain).

**4. Sign in** as the admin email from step 1. Then add people under **Admin → People & access**.

### Settings

| Setting | What it does |
|---|---|
| `KANBAN_ADMIN_EMAILS` | Comma-separated emails that are always admins. This is how the first person gets in. |
| `KANBAN_SEED_WORKSPACES` | Workspace names created on first start. Default: `General`. Admins can add more in the app. |
| `KANBAN_EDIT_DOMAINS` | Optional, e.g. `yourcompany.com`. If set, only those domains can edit and everyone else is a viewer. |
| `KANBAN_PUBLIC_URL` | The site's address. Used for "Open card" links in Teams posts. |
| `KANBAN_SESSION_SECRET` | 32+ random characters that sign the session pass. The provision script generates it. |
| `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE` | The database. Leave empty locally to use the JSON file store instead. |
| `VITE_APP_NAME` | Build-time. The name in the header. Default: `Kanban`. |

### Teams notifications

For each workspace:
1. In the Teams channel, create a Workflow from the template **"Post to a channel when a webhook request is received"**.
2. Paste its URL into **Admin → Workspaces & Teams**.

## Make it yours

- **Colours:** every colour is a CSS variable at the top of [`src/index.css`](src/index.css): page, panels, lines, text and one accent. Change those values and the whole app follows.
- **Logo and name:** replace [`public/favicon.svg`](public/favicon.svg) and set `VITE_APP_NAME`.
- **Workspace logos:** [`src/components/WorkspaceMark.tsx`](src/components/WorkspaceMark.tsx) shows each workspace's initial. Swap in real logos there.
- **Column colours:** the `COLUMN_COLORS` greys in [`src/components/Board.tsx`](src/components/Board.tsx).

## Project layout

```
src/                 React app (Vite + Tailwind)
  pages/             Home, Workspace, Project (board), Search, Admin
  components/        Board (drag & drop), CardDrawer, ActivityRow, Layout, …
  lib/api.ts         Typed client for the API
api/                 Azure Functions (Node 20)
  shared/routes.mjs  The whole API as one route table + the request pipeline
  shared/handlers.mjs  Every endpoint
  shared/auth.mjs    Who's calling: signed-in people, API keys, roles
  shared/session.mjs Signed session pass (backstop for SWA)
  shared/activity.mjs  Activity log
  shared/*Store.mjs  Cosmos DB and local JSON stores behind one interface
  scripts/           Dev server, end-to-end tests, Azure provisioning
public/staticwebapp.config.json   Routes, login, security headers
```

## License

[Apache 2.0](LICENSE).

---

Built by [Kokka & Company](https://kokkaco.com).
