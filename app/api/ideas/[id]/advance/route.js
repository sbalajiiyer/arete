import { advance } from '../../../../../lib/pipeline';
import { getContext, handle } from '../../../../../lib/server';

export const maxDuration = 120;

export const POST = handle(async (req, { params }) => {
  const { id } = await params;
  const ctx = await getContext(req);
  return { idea: await advance(ctx, id) };
});
