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
  const fields = (r.fields ?? []).map((f) => {
    const isPicklist = f.type === "picklist" || f.type === "multipicklist";
    let picklistValues;
    if (isPicklist) {
      const raw = f.picklistValues ?? [];
      const anyDiffer = raw.some((p) => p.label !== p.value);
      picklistValues = anyDiffer
        ? raw.map((p) => ({ label: p.label, value: p.value }))
        : raw.map((p) => p.value);
    }
    return {
      name: f.name,
      label: f.label,
      type: f.type,
      custom: !!f.custom,
      nillable: !!f.nillable,
      referenceTo: f.referenceTo && f.referenceTo.length ? f.referenceTo : undefined,
      relationshipName:
        f.type === "reference" && f.relationshipName ? f.relationshipName : undefined,
      picklistValues,
    };
  });
  console.log(JSON.stringify({
    name: r.name,
    label: r.label,
    custom: !!r.custom,
    fields,
  }, null, 2));
'
