#!/usr/bin/env bash
# Returns a slim JSON view of `sf org list --json` with secrets and chatter
# stripped. Used by the Router agent so the LLM context stays small AND so
# access tokens never end up in a model prompt.
#
# Output shape:
# {
#   "orgs": [
#     { "alias": "krahn", "username": "...", "orgId": "00D...",
#       "isDevHub": true, "connectedStatus": "Connected",
#       "isDefaultDevHub": true, "lastUsed": "2026-04-30T..." },
#     ...
#   ]
# }

set -euo pipefail

sf org list --json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const buckets = ["nonScratchOrgs", "scratchOrgs", "sandboxes", "other"];
  const all = [];
  for (const k of buckets) {
    const v = data.result?.[k];
    if (Array.isArray(v)) all.push(...v);
  }
  const seen = new Set();
  const slim = [];
  for (const o of all) {
    const id = o.orgId ?? `${o.alias ?? ""}::${o.username ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    slim.push({
      alias: o.alias ?? null,
      username: o.username ?? null,
      orgId: o.orgId ?? null,
      isDevHub: o.isDevHub === true,
      connectedStatus: o.connectedStatus ?? null,
      isDefaultDevHub: o.defaultMarker === "(D)",
      lastUsed: o.lastUsed ?? null,
    });
  }
  console.log(JSON.stringify({ orgs: slim }, null, 2));
'
