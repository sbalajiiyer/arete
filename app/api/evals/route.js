import { MODEL } from '../../../lib/agents';
import { loadConfig } from '../../../lib/config';
import { runEvals, EVAL_COUNTS } from '../../../lib/evals';
import { getContext, handle, must, HttpError } from '../../../lib/server';

export const maxDuration = 120;

// Runs one agent's test cases against the workspace's current configuration and stores the result.
export const POST = handle(async (req) => {
  const ctx = await getContext(req);
  const { stage } = await req.json();
  if (!EVAL_COUNTS[stage]) throw new HttpError(400, 'Unknown agent.');
  const since = new Date(Date.now() - 86400000).toISOString();
  const { count } = await ctx.supabase.from('eval_runs').select('id', { count: 'exact', head: true }).eq('org_id', ctx.orgId).gte('created_at', since);
  if ((count || 0) >= 70) throw new HttpError(429, 'Eval limit reached for today (10 full runs).');

  const cfg = await loadConfig(ctx);
  const details = await runEvals(cfg, stage);
  // A call that never reached the model (rate limit, outage) says nothing about the agent, so it is not scored.
  const failed = details.find((d) => d.detail.startsWith('Agent call failed'));
  if (failed) throw new HttpError(503, `The model could not be reached, so nothing was scored. ${failed.detail}`);
  const row = must(
    await ctx.supabase
      .from('eval_runs')
      .insert({
        org_id: ctx.orgId,
        stage,
        passed: details.filter((d) => d.pass).length,
        total: details.length,
        details,
        model: MODEL,
        customized: !!cfg.agents[stage] || cfg.settings.guardrails.length > 0,
      })
      .select()
      .single(),
    'Saving the eval result'
  );
  return { run: row };
});
