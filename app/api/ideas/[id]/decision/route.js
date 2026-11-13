import { advance, loadIdea, log, save } from '../../../../../lib/pipeline';
import { getContext, handle, must, HttpError } from '../../../../../lib/server';

export const maxDuration = 120;

// The approval decision is always made by a person. Agents prepare the pack and act on the outcome.
export const POST = handle(async (req, { params }) => {
  const { id } = await params;
  const ctx = await getContext(req);
  const { decision, comment = '' } = await req.json();
  if (!['approved', 'rejected', 'returned'].includes(decision)) throw new HttpError(400, 'Unknown decision.');
  if (!['admin', 'approver'].includes(ctx.role)) throw new HttpError(403, 'Only approvers can decide.');
  const idea = await loadIdea(ctx, id);
  if (idea.status !== 'awaiting_approval') throw new HttpError(409, 'This idea is not waiting for a decision.');

  must(await ctx.supabase.from('approvals').insert({ idea_id: id, org_id: idea.org_id, decision, comment: String(comment).slice(0, 4000) }), 'Recording the decision');
  const stages = idea.idea_types.config.stages;
  const patch =
    decision === 'returned'
      ? { status: 'returned', stage: stages.includes('scope') ? 'scope' : 'capture' }
      : { status: decision, rank: null };
  let saved = await save(ctx, idea, patch);
  await log(ctx, idea, 'commit', 'Human approver', `Decision: ${decision}.${comment ? ` Comment: ${comment}` : ''}`, { decision, comment, decided_by: ctx.user.email }, null);

  let warning = null;
  if (decision === 'approved') {
    try {
      saved = await advance(ctx, id);
    } catch (e) {
      warning = `Approved, but tracking could not be set up yet: ${e.message}`;
    }
  }
  return { idea: saved, warning };
});
