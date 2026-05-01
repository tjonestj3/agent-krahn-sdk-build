#!/usr/bin/env bash
# Run a SOQL query against the project's default target-org (set by
# `sf config set target-org=<alias>` at orchestrator setup time). Returns
# slim JSON: { totalSize, done, records: [...] } with internal `attributes`
# blocks stripped to keep the LLM context small.
#
# Usage:
#   scratch-query.sh "<soql>"
#
# The default-org behavior means the agent doesn't have to remember a flag
# every call. To target a different org, use raw `sf data query` instead.

set -euo pipefail

SOQL="${1:?soql query required}"

sf data query --query "$SOQL" --json | node -e '
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
