#!/usr/bin/env bash
# Copia este directorio al servidor y dispara el redespliegue en Dokploy.
#
#   export DOKPLOY_API_KEY="..."                  # Settings -> API/CLI en Dokploy
#   export CTP_SSH="ubuntu@144.217.164.56"
#   ./deploy.sh
#
# El código en el servidor vive en /etc/dokploy/cofre, que es el único
# directorio visible a la vez desde el host y desde el contenedor de Dokploy.
set -euo pipefail

: "${DOKPLOY_API_KEY:?exporta DOKPLOY_API_KEY con tu API key de Dokploy}"
: "${CTP_SSH:?exporta CTP_SSH, ej. ubuntu@144.217.164.56}"

DOKPLOY_URL="${DOKPLOY_URL:-https://dokploy.ancordss.me.uk}"
COMPOSE_ID="${CTP_COMPOSE_ID:-lFax-VSahcnDJVSblvDcu}"
DIR_REMOTO="/etc/dokploy/cofre"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SCP=(scp -o StrictHostKeyChecking=accept-new)
SSH=(ssh -o StrictHostKeyChecking=accept-new)
[ -n "${SSHPASS:-}" ] && { SCP=(sshpass -e "${SCP[@]}"); SSH=(sshpass -e "${SSH[@]}"); }

echo "→ subiendo a $DIR_REMOTO"
"${SCP[@]}" -r "$AQUI/server.js" "$AQUI/Dockerfile" "$AQUI/public" "$CTP_SSH:/tmp/ctp-deploy/"
"${SSH[@]}" "$CTP_SSH" "sudo mkdir -p $DIR_REMOTO && sudo rm -rf $DIR_REMOTO/public \
  && sudo cp -r /tmp/ctp-deploy/. $DIR_REMOTO/ && sudo rm -rf /tmp/ctp-deploy"

echo "→ disparando el despliegue"
curl -sS -X POST "$DOKPLOY_URL/api/compose.deploy" \
  -H "x-api-key: $DOKPLOY_API_KEY" -H 'content-type: application/json' \
  -d "{\"composeId\":\"$COMPOSE_ID\"}"
echo
echo "→ sigue el estado en el panel de Dokploy (o consulta /health)"
