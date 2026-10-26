#!/usr/bin/env bash
#
# Provision everything kanban-starter needs on Azure — 100% Azure CLI.
#
#   1. Resource group
#   2. Cosmos DB for NoSQL account on the FREE TIER (one allowed per subscription)
#   3. A Static Web App (Free plan)
#   4. App settings: Cosmos endpoint + key, admins, workspaces, session secret
#
# Usage (after `az login`):
#
#   SUBSCRIPTION_ID=<your-subscription-id> \
#   KANBAN_ADMIN_EMAILS=you@yourcompany.com \
#   KANBAN_SEED_WORKSPACES="Engineering,Marketing" \
#   KANBAN_EDIT_DOMAINS=yourcompany.com \
#   KANBAN_PUBLIC_URL=https://kanban.yourcompany.com \
#   NAME_PREFIX=acme-kanban \
#   bash api/scripts/provision-azure.sh
#
# Safe to re-run: existing resources are detected and reused. Secrets (the Cosmos key
# and the session secret) go straight into the app's settings — never printed, never
# written to disk.
#
# Your account needs rights to create a resource group, and Microsoft.DocumentDB must
# be registered on the subscription (`az provider register -n Microsoft.DocumentDB`).
#
set -euo pipefail

: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to your Azure subscription id}"
: "${KANBAN_ADMIN_EMAILS:?Set KANBAN_ADMIN_EMAILS to the first admin's email}"
NAME_PREFIX="${NAME_PREFIX:-kanban-starter}"
LOCATION="${LOCATION:-westus2}"
RG="${RG:-$NAME_PREFIX-rg}"
COSMOS_NAME="${COSMOS_NAME:-$NAME_PREFIX-cosmos}"
SWA_NAME="${SWA_NAME:-$NAME_PREFIX}"
SEED="${KANBAN_SEED_WORKSPACES:-General}"
EDIT_DOMAINS="${KANBAN_EDIT_DOMAINS:-}"
PUBLIC_URL="${KANBAN_PUBLIC_URL:-}"

echo "==> Using subscription $SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID"

# ================================ 1. Resource group ================================
if [[ "$(az group exists -n "$RG")" != "true" ]]; then
  echo "==> Creating resource group $RG"
  az group create -n "$RG" -l "$LOCATION" -o none
fi

# ============================ 2. Cosmos DB (free tier) =============================
if az cosmosdb show -n "$COSMOS_NAME" -g "$RG" -o none 2>/dev/null; then
  echo "==> Reusing Cosmos account $COSMOS_NAME"
else
  OTHER_FREE=$(az cosmosdb list --query "[?enableFreeTier].name" -o tsv)
  if [[ -n "$OTHER_FREE" ]]; then
    echo "!! This subscription already has a free-tier Cosmos account: $OTHER_FREE"
    echo "!! Only one is allowed. Stopping rather than creating a paid account."
    exit 1
  fi
  echo "==> Creating Cosmos account $COSMOS_NAME (free tier — takes a few minutes)"
  az cosmosdb create -n "$COSMOS_NAME" -g "$RG" \
    --enable-free-tier true \
    --default-consistency-level Session \
    --locations regionName="$LOCATION" failoverPriority=0 isZoneRedundant=False \
    -o none
fi
COSMOS_ENDPOINT=$(az cosmosdb show -n "$COSMOS_NAME" -g "$RG" --query documentEndpoint -o tsv)

# ============================== 3. Static Web App ==================================
if az staticwebapp show -n "$SWA_NAME" -g "$RG" -o none 2>/dev/null; then
  echo "==> Reusing Static Web App $SWA_NAME"
else
  echo "==> Creating Static Web App $SWA_NAME (Free plan)"
  az staticwebapp create -n "$SWA_NAME" -g "$RG" -l "$LOCATION" --sku Free -o none
fi
SWA_HOST=$(az staticwebapp show -n "$SWA_NAME" -g "$RG" --query defaultHostname -o tsv)

# ================================ 4. App settings ==================================
echo "==> Writing app settings (secrets are piped, not printed)"
az staticwebapp appsettings set -n "$SWA_NAME" -g "$RG" -o none --setting-names \
  "COSMOS_ENDPOINT=$COSMOS_ENDPOINT" \
  "COSMOS_KEY=$(az cosmosdb keys list -n "$COSMOS_NAME" -g "$RG" --type keys --query primaryMasterKey -o tsv)" \
  "COSMOS_DATABASE=kanban" \
  "KANBAN_ADMIN_EMAILS=$KANBAN_ADMIN_EMAILS" \
  "KANBAN_SEED_WORKSPACES=$SEED" \
  "KANBAN_EDIT_DOMAINS=$EDIT_DOMAINS" \
  "KANBAN_PUBLIC_URL=${PUBLIC_URL:-https://$SWA_HOST}" \
  "KANBAN_SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')"

echo
echo "Done."
echo "  Static Web App:  https://$SWA_HOST"
echo "  Cosmos endpoint: $COSMOS_ENDPOINT"
echo
echo "Next: deploy (see README). For a custom domain, add a CNAME to $SWA_HOST, then:"
echo "  az staticwebapp hostname set -n $SWA_NAME -g $RG --hostname <your-domain>"
