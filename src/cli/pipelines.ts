import { supabase } from '../db/client.js';

const args = process.argv.slice(2);
const first = args[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (first && UUID_RE.test(first)) {
  // Detail view: full row + last 20 events
  const { data: row, error: rowErr } = await supabase
    .from('pipelines')
    .select()
    .eq('id', first)
    .maybeSingle();

  if (rowErr) {
    console.error(`pipeline lookup failed: ${rowErr.message}`);
    process.exit(2);
  }
  if (!row) {
    console.error(`no pipeline with id ${first}`);
    process.exit(2);
  }

  const { data: events } = await supabase
    .from('pipeline_events')
    .select('event_type, stage, payload, created_at')
    .eq('pipeline_id', first)
    .order('created_at', { ascending: true })
    .limit(100);

  const telemetry = summarizeTelemetry(events ?? []);

  console.log(
    JSON.stringify(
      {
        pipeline: row,
        events: events ?? [],
        telemetry_summary: telemetry,
      },
      null,
      2,
    ),
  );

  function summarizeTelemetry(rows: { event_type: string; payload: unknown }[]) {
    const stages: Record<string, {
      agent: string;
      model: string;
      num_turns: number | null;
      total_cost_usd: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_input_tokens: number | null;
      cache_creation_input_tokens: number | null;
    }> = {};
    let totalCost = 0;
    let totalTurns = 0;
    for (const r of rows) {
      if (r.event_type !== 'stage_telemetry') continue;
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const stage = String(p.agent ?? 'unknown');
      stages[stage] = {
        agent: String(p.agent ?? ''),
        model: String(p.model ?? ''),
        num_turns: numOrNull(p.num_turns),
        total_cost_usd: numOrNull(p.total_cost_usd),
        input_tokens: numOrNull(p.input_tokens),
        output_tokens: numOrNull(p.output_tokens),
        cache_read_input_tokens: numOrNull(p.cache_read_input_tokens),
        cache_creation_input_tokens: numOrNull(p.cache_creation_input_tokens),
      };
      if (typeof p.total_cost_usd === 'number') totalCost += p.total_cost_usd;
      if (typeof p.num_turns === 'number') totalTurns += p.num_turns;
    }
    return {
      per_stage: stages,
      total_cost_usd: totalCost || null,
      total_turns: totalTurns || null,
    };
  }

  function numOrNull(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
} else {
  // List view: filter by status if given
  const status = first;

  let q = supabase
    .from('pipelines')
    .select('id, status, current_stage, source, created_at, client_id, dev_hub_alias')
    .order('created_at', { ascending: false })
    .limit(20);

  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) {
    console.error(`list failed: ${error.message}`);
    process.exit(2);
  }

  if (!data || data.length === 0) {
    console.log(status ? `(no pipelines with status="${status}")` : '(no pipelines yet)');
    process.exit(0);
  }

  console.table(
    data.map((r) => ({
      id: r.id.slice(0, 8) + '…',
      status: r.status,
      stage: r.current_stage ?? '',
      source: r.source,
      client: r.client_id ?? '',
      dev_hub: r.dev_hub_alias ?? '',
      created: new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19),
    })),
  );
  console.log(`\n${data.length} row${data.length === 1 ? '' : 's'}. Use \`npm run pipelines -- <full-id>\` for detail.`);
}
