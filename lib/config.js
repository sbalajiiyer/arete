import { DEFAULT_SETTINGS } from './defaults';

// The workspace's live configuration, read fresh on every agent run so edits take effect immediately.
export async function loadConfig(ctx) {
  const [a, s, m] = await Promise.all([
    ctx.supabase.from('agent_configs').select('stage, instructions, rules').eq('org_id', ctx.orgId),
    ctx.supabase.from('org_settings').select('settings').eq('org_id', ctx.orgId).maybeSingle(),
    ctx.supabase.from('org_memory').select('note').eq('org_id', ctx.orgId).order('created_at').limit(40),
  ]);
  return {
    agents: Object.fromEntries((a.data || []).map((r) => [r.stage, r])),
    settings: { ...DEFAULT_SETTINGS, ...(s.data?.settings || {}) },
    memory: (m.data || []).map((r) => r.note),
  };
}
