#!/usr/bin/env bash
# Describe an SObject against the production org (the client's Dev Hub
# alias). Used by the Execution agent's scout subagent to see what fields
# actually exist on a given object in prod, before the parent agent picks
# an API name or proposes a new one.
#
# Usage:
#   prod-describe.sh <prod-alias> <SObject>
#
# Returns the same slim shape as scratch-describe.sh — field API names,
# types, and key flags — to keep the LLM context lean. Read-only by design.

set -euo pipefail

ALIAS="${1:?prod alias required}"
SOBJECT="${2:?sobject API name required}"

sf sobject describe --target-org "$ALIAS" --sobject "$SOBJECT" --json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (data.status !== 0) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(2);
  }
  const r = data.result ?? {};
  const fields = (r.fields ?? []).map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    custom: !!f.custom,
    nillable: !!f.nillable,
    referenceTo: f.referenceTo && f.referenceTo.length ? f.referenceTo : undefined,
    picklistValues:
      f.type === "picklist" || f.type === "multipicklist"
        ? (f.picklistValues ?? []).map((p) => p.value)
        : undefined,
  }));
  console.log(JSON.stringify({
    name: r.name,
    label: r.label,
    custom: !!r.custom,
    fields,
  }, null, 2));
'
