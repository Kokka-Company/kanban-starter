# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub's [private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (the **Security** tab → **Report a vulnerability**).

## What the template does for you

See [ARCHITECTURE.md → Access model](ARCHITECTURE.md#access-model):
- an email allowlist of members
- per-workspace visibility
- roles
- scoped, expiring and hashed API keys
- an activity log of every change and every refused attempt
- an HMAC-signed session pass
- the JSON-only CSRF guard

## What you should do when you deploy

- **Keep secrets out of git.** Keep `api/local.settings.json` out of the repo; `.gitignore` already excludes it.
- **Session secret:** set `KANBAN_SESSION_SECRET` to at least 32 random characters. The provision script does this for you.
- **Edit domains:** set `KANBAN_EDIT_DOMAINS` if outside guests should only ever be able to view.
- **Least privilege for keys:** give each key the smallest permission and the fewest workspaces it needs, and an expiry.
- **Watch the log:** review **Admin → Activity log** now and then. Refused attempts show in red.
- **Cosmos key rotation:** if you rotate the Cosmos key, update `COSMOS_KEY` in the Static Web App settings.
