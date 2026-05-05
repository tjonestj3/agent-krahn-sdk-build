#!/usr/bin/env bash
# Run a read-only SOQL query against the production org (which, in this
# pipeline, is always the Dev Hub alias for the client). Used by the
# Execution agent's scout subagent to verify what already exists in prod
# before the parent agent makes naming or schema decisions.
#
# Usage:
#   prod-query.sh <prod-alias> "<soql>"
#
# Returns slim JSON: { totalSize, done, records: [...] } with internal
# `attributes` blocks stripped. NEVER use this wrapper for DML — use only
# SELECT statements. The scout's prompt forbids DML; this script does not
# enforce it (sf data query is read-only by design).

set -euo pipefail

ALIAS="${1:?prod alias required}"
SOQL="${2:?soql query required}"

sf data query --target-org "$ALIAS" --query "$SOQL" --json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (data.status !== 0) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(2);
  }
  const r = data.result ?? {};
  const records = (r.records ?? []).map((rec) => {
    const { attributes, ...rest } = rec;
    return rest;
  });
  console.log(JSON.stringify({
    totalSize: r.totalSize ?? records.length,
    done: r.done ?? true,
    records,
  }, null, 2));
'
