#!/usr/bin/env bash
# Describe an SObject against the project's default target-org. Returns a
# slim shape — just field API names, types, and key flags — instead of the
# full describe payload (which can be 50KB+ and fills the LLM context with
# noise the agent doesn't need).
#
# Usage:
#   scratch-describe.sh <SObject>

set -euo pipefail

SOBJECT="${1:?sobject API name required}"

sf sobject describe --sobject "$SOBJECT" --json | node -e '
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
