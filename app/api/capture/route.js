import { capture, AGENTS } from '../../../lib/agents';
import { loadConfig } from '../../../lib/config';
import { extractFile, extractUrl } from '../../../lib/extract';
import { log } from '../../../lib/pipeline';
import { getContext, checkQuota, handle, must, HttpError } from '../../../lib/server';

export const maxDuration = 120;

export const POST = handle(async (req) => {
  const ctx = await getContext(req);
  const body = await req.json();
  let text;
  if (body.kind === 'url') text = await extractUrl(body.url);
  else if (body.kind === 'file') text = await extractFile(body.filename, body.data || '');
  else text = String(body.text || '').slice(0, 40000).trim();
  if (!text || text.length < 15) throw new HttpError(400, 'There is not enough content to capture an idea from.');

  const types = must(await ctx.supabase.from('idea_types').select('*').eq('org_id', ctx.orgId).order('created_at'), 'Loading idea types');
  if (!types.length) throw new HttpError(409, 'Add at least one idea type first.');
  await checkQuota(ctx);

  const { ideas } = await capture(await loadConfig(ctx), text, types);
  if (!ideas.length) throw new HttpError(422, 'No idea was found in that material.');

  const sourceKind = ['url', 'file'].includes(body.kind) ? body.kind : 'text';
  const sourceLabel = body.kind === 'url' ? body.url : body.kind === 'file' ? body.filename : 'Pasted text';
  const created = [];
  for (const found of ideas.slice(0, 8)) {
    const type = types.find((t) => t.name.toLowerCase() === found.idea_type.toLowerCase()) || types[0];
    const allowed = new Set(type.config.fields.map((f) => f.key));
    const fields = Object.fromEntries(found.fields.filter((f) => allowed.has(f.key) && f.value).map((f) => [f.key, f.value]));
    const idea = must(
      await ctx.supabase
        .from('ideas')
        .insert({
          org_id: ctx.orgId,
          idea_type_id: type.id,
          title: found.title.slice(0, 200),
          summary: found.summary,
          source_kind: sourceKind,
          source_text: text,
          record: { fields, missing_info: found.missing_info, source: sourceLabel },
        })
        .select()
        .single(),
      'Saving the idea'
    );
    await log(ctx, idea, 'capture', AGENTS.capture, `Captured from ${sourceLabel} as "${type.name}". ${found.missing_info.length} gap(s) noted.`, { ...found, fields });
    created.push({ id: idea.id, title: idea.title });
  }
  return { ideas: created };
});
