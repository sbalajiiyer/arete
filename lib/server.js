import { createClient } from '@supabase/supabase-js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DAILY_AGENT_RUNS = Number(process.env.DAILY_AGENT_RUNS || 300);

// Every request runs as the signed-in user, so row-level security applies to all reads and writes.
export async function getContext(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Sign in first.');
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const { data: member } = await supabase.from('org_members').select('org_id, role').eq('user_id', data.user.id).limit(1).maybeSingle();
  if (!member) throw new HttpError(403, 'No workspace found for this account.');
  return { supabase, user: data.user, orgId: member.org_id, role: member.role };
}

export async function checkQuota(ctx) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count } = await ctx.supabase
    .from('stage_runs')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', ctx.orgId)
    .gte('created_at', since.toISOString());
  if ((count || 0) >= DAILY_AGENT_RUNS) throw new HttpError(429, 'Daily agent limit reached for this workspace. Try again tomorrow.');
}

export function must(result, what) {
  if (result.error) throw new HttpError(500, `${what}: ${result.error.message}`);
  return result.data;
}

export function handle(fn) {
  return async (req, routeCtx) => {
    try {
      return Response.json(await fn(req, routeCtx));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      const message = e instanceof HttpError ? e.message : `Something went wrong: ${e?.message || 'unknown error'}`;
      return Response.json({ error: message }, { status });
    }
  };
}
