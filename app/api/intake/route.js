import { createClient } from '@supabase/supabase-js';
import { capture, MODEL } from '../../../lib/agents';
import { DEFAULT_SETTINGS } from '../../../lib/defaults';
import { handle, HttpError } from '../../../lib/server';

export const maxDuration = 120;

// Lets other tools (a Teams workflow, an email forwarder, a script) submit raw text as ideas.
// Authenticated by a workspace intake key, not a user session. Only the Capture agent runs here.
export const POST = handle(async (req) => {
  const key = (req.headers.get('x-intake-key') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')).trim();
  if (!key.startsWith('ak_')) throw new HttpError(401, 'Send the workspace intake key in the x-intake-key header.');
  const body = await req.json().catch(() => ({}));
  const text = String(body.text || '').slice(0, 40000).trim();
  if (text.length < 15) throw new HttpError(400, 'Send the request as JSON with a "text" field of at least 15 characters.');
  const source = `Intake${body.sender ? ` from ${String(body.sender).slice(0, 120)}` : ''}`;

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: ctx, error } = await supabase.rpc('intake_context', { k: key });
  if (error) throw new HttpError(500, `Intake lookup failed: ${error.message}`);
  if (!ctx) throw new HttpError(401, 'That intake key is not recognised.');
  if (!ctx.types.length) throw new HttpError(409, 'The workspace has no idea types.');
  if (ctx.runs_today >= Number(process.env.DAILY_AGENT_RUNS || 300)) throw new HttpError(429, 'Daily agent limit reached for this workspace.');

  const cfg = { agents: ctx.capture ? { capture: ctx.capture } : {}, settings: { ...DEFAULT_SETTINGS, ...(ctx.settings || {}) }, memory: [] };
  const { ideas } = await capture(cfg, `${body.subject ? `Subject: ${String(body.subject).slice(0, 300)}\n\n` : ''}${text}`, ctx.types);
  if (!ideas.length) throw new HttpError(422, 'No idea was found in that text.');

  const items = ideas.slice(0, 8).map((found) => {
    const type = ctx.types.find((t) => t.name.toLowerCase() === found.idea_type.toLowerCase()) || ctx.types[0];
    const allowed = new Set(type.config.fields.map((f) => f.key));
    return { idea_type_id: type.id, title: found.title, summary: found.summary, missing_info: found.missing_info, fields: Object.fromEntries(found.fields.filter((f) => allowed.has(f.key) && f.value).map((f) => [f.key, f.value])) };
  });
  const made = await supabase.rpc('intake_create', { k: key, items, source_label: source, source_text: text, model: MODEL });
  if (made.error) throw new HttpError(500, `Saving failed: ${made.error.message}`);
  return { ideas: made.data };
});
