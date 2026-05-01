#!/usr/bin/env bash
# Spin a scratch org from a Dev Hub. Used by the orchestrator before the
# Execution agent runs. Returns slim JSON; tokens and noise stripped.
#
# Usage:
#   spin-scratch.sh <devhub-alias> <new-scratch-alias> [duration-days]
#   (must be run from inside an SFDX project — uses ./config/project-scratch-def.json)
#
# Output:
#   { "alias": "...", "orgId": "...", "expirationDate": "...", "loginUrl": "..." }

set -euo pipefail

DEVHUB="${1:?devhub alias required}"
ALIAS="${2:?scratch alias required}"
DAYS="${3:-7}"

DEF_FILE="config/project-scratch-def.json"

if [[ ! -f "$DEF_FILE" ]]; then
  echo "missing $DEF_FILE in $(pwd)" >&2
  exit 2
fi

sf org create scratch \
  --target-dev-hub "$DEVHUB" \
  --definition-file "$DEF_FILE" \
  --alias "$ALIAS" \
  --duration-days "$DAYS" \
  --no-namespace \
  --json | node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (data.status !== 0) {
      console.error(JSON.stringify(data, null, 2));
      process.exit(2);
    }
    const r = data.result ?? {};
    console.log(JSON.stringify({
      alias: r.alias ?? r.username ?? null,
      orgId: r.orgId ?? null,
      username: r.username ?? null,
      expirationDate: r.scratchOrgInfo?.ExpirationDate ?? null,
      loginUrl: r.loginUrl ?? null,
    }, null, 2));
  '
