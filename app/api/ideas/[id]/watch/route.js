import { recordWatchUpdate } from '../../../../../lib/pipeline';
import { getContext, handle, HttpError } from '../../../../../lib/server';

export const maxDuration = 120;

export const POST = handle(async (req, { params }) => {
  const { id } = await params;
  const ctx = await getContext(req);
  const body = await req.json();
  const note = String(body.note || '').slice(0, 8000).trim();
  if (note.length < 5) throw new HttpError(400, 'Describe the progress in a sentence or two.');
  const pct = body.percent_complete === '' || body.percent_complete == null ? null : Math.min(100, Math.max(0, Math.round(Number(body.percent_complete))));
  return { idea: await recordWatchUpdate(ctx, id, { note, percent_complete: Number.isNaN(pct) ? null : pct, done: !!body.done }) };
});
