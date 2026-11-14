import { loadConfig } from '../../../lib/config';
import { extractOutcome } from '../../../lib/pipeline';
import { getContext, handle, must, HttpError } from '../../../lib/server';

export const maxDuration = 120;

// Works out "result against plan" for closed ideas that do not have it yet, two per call.
export const POST = handle(async (req) => {
  const ctx = await getContext(req);
  if (!['admin', 'member'].includes(ctx.role)) throw new HttpError(403, 'Only admins and analysts can update the track record.');
  const rows = must(await ctx.supabase.from('ideas').select('*, idea_types(*)').eq('org_id', ctx.orgId).eq('status', 'done').limit(200), 'Loading closed ideas');
  const missing = rows.filter((r) => !r.record?.outcome);
  const cfg = await loadConfig(ctx);
  let updated = 0;
  for (const idea of missing.slice(0, 2)) {
    await extractOutcome(ctx, cfg, idea);
    updated += 1;
  }
  return { updated, remaining: missing.length - updated };
});
