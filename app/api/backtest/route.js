import { judge, MODEL } from '../../../lib/agents';
import { loadConfig } from '../../../lib/config';
import { getContext, handle, must, HttpError } from '../../../lib/server';

export const maxDuration = 120;

// Runs the Judge on one past project as it stood at approval. The real outcome is stored beside the
// verdict for comparison and is never shown to the model.
export const POST = handle(async (req) => {
  const ctx = await getContext(req);
  if (!['admin', 'member'].includes(ctx.role)) throw new HttpError(403, 'Only admins and analysts can run a backtest.');
  const body = await req.json();
  const title = String(body.title || '').slice(0, 200).trim();
  const text = String(body.case || '').slice(0, 8000).trim();
  if (!title || text.length < 40) throw new HttpError(400, 'Each project needs a title and a description of the case as approved.');
  if (!['success', 'partial', 'failed'].includes(body.actual)) throw new HttpError(400, 'The result must be success, partial or failed.');
  if (!/^[0-9a-f-]{36}$/i.test(String(body.batch))) throw new HttpError(400, 'Missing batch.');
  const since = new Date(Date.now() - 86400000).toISOString();
  const { count } = await ctx.supabase.from('backtest_runs').select('id', { count: 'exact', head: true }).eq('org_id', ctx.orgId).gte('created_at', since);
  if ((count || 0) >= 60) throw new HttpError(429, 'Backtest limit reached for today (60 projects).');

  const types = must(await ctx.supabase.from('idea_types').select('*').eq('org_id', ctx.orgId).order('created_at'), 'Loading idea types');
  const type = types.find((t) => t.config.stages.includes('judge')) || types[0];
  if (!type) throw new HttpError(409, 'Add an idea type first.');
  const out = await judge(await loadConfig(ctx), { title, summary: text.slice(0, 600), record: { fields: {} } }, type, {
    business_case: { summary: text },
    note:
      'This is a past project, summarised as it stood when it was approved. Only this summary survives and criterion scores were not recorded, so do not mark it down for being brief or for detail a summary would not carry. ' +
      'Judge what it does say. If its main figures rest on measurements, trials or firm quotes and delivery has been thought through, the verdict is proceed with confidence above 60. ' +
      'If its main figures are assumed, borrowed or unsourced, or an obvious delivery risk is ignored, the verdict is revise or reject.',
  });
  const concerns = [...out.inconsistencies.map((i) => i.issue), ...out.optimistic_assumptions, ...out.missing_evidence].slice(0, 4);
  const row = must(
    await ctx.supabase
      .from('backtest_runs')
      .insert({ org_id: ctx.orgId, batch: body.batch, title, actual: body.actual, verdict: out.verdict, confidence: Math.min(100, Math.max(0, Number(out.confidence) || 0)), concerns, summary: out.summary, model: MODEL })
      .select()
      .single(),
    'Saving the result'
  );
  return { run: row };
});
