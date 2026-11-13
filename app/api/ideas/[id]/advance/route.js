import { advance } from '../../../../../lib/pipeline';
import { getContext, handle, HttpError } from '../../../../../lib/server';

export const maxDuration = 120;

export const POST = handle(async (req, { params }) => {
  const { id } = await params;
  const ctx = await getContext(req);
  if (ctx.role === 'submitter') throw new HttpError(403, 'Submitters can capture ideas but cannot run the agents.');
  return { idea: await advance(ctx, id, new URL(req.url).origin) };
});
