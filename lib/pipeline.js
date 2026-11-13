import * as agents from './agents';
import { loadConfig } from './config';
import { notify } from './notify';
import { HttpError, must, checkQuota } from './server';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));

// Scores are computed here, not by a model: weighted average of 1-5 criterion scores, scaled to 0-100.
function weighted(scores, criteria) {
  const by = Object.fromEntries((scores || []).map((s) => [s.key, clamp(s.score, 1, 5)]));
  let total = 0;
  let weight = 0;
  for (const c of criteria || []) {
    if (by[c.key] != null) {
      total += by[c.key] * c.weight;
      weight += c.weight;
    }
  }
  return weight ? Math.round((total / weight / 5) * 100) : null;
}

// Rank order: score discounted by how unsure the Judge is. The weight is a workspace governance setting.
const priority = (i, w) => (Number(i.score) || 0) * (1 - w + (w * (i.confidence == null ? 50 : Number(i.confidence))) / 100);

export async function loadIdea(ctx, id) {
  const { data } = await ctx.supabase.from('ideas').select('*, idea_types(*)').eq('id', id).maybeSingle();
  if (!data) throw new HttpError(404, 'Idea not found.');
  return data;
}

async function learnings(ctx, cfg, excludeId) {
  const rows = must(
    await ctx.supabase
      .from('watch_updates')
      .select('assessment, rag, ideas(title)')
      .eq('org_id', ctx.orgId)
      .neq('idea_id', excludeId)
      .order('created_at', { ascending: false })
      .limit(60),
    'Loading history'
  );
  const fromIdeas = rows
    .filter((r) => r.assessment?.lessons?.length)
    .slice(0, 20)
    .map((r) => ({ idea: r.ideas?.title, status: r.rag, lessons: r.assessment.lessons }));
  return cfg.memory.length ? [{ idea: 'Workspace knowledge', lessons: cfg.memory }, ...fromIdeas] : fromIdeas;
}

export async function log(ctx, idea, stage, agent, summary, output, model = agents.MODEL) {
  must(await ctx.supabase.from('stage_runs').insert({ idea_id: idea.id, org_id: idea.org_id, stage, agent, summary, output, model }), 'Writing the audit log');
}

export async function save(ctx, idea, patch) {
  return must(
    await ctx.supabase.from('ideas').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', idea.id).select('*, idea_types(*)').single(),
    'Saving the idea'
  );
}

export function nextStage(idea) {
  const stages = idea.idea_types.config.stages;
  return stages[stages.indexOf(idea.stage) + 1] || null;
}

const RUNNERS = {
  async scope(ctx, idea, type, cfg) {
    const others = must(
      await ctx.supabase.from('ideas').select('id, title, summary, status, stage').eq('org_id', ctx.orgId).neq('id', idea.id).order('created_at', { ascending: false }).limit(150),
      'Loading the portfolio'
    );
    const out = await agents.scope(cfg, idea, type, others.map((o) => ({ idea_id: o.id, title: o.title, summary: o.summary, status: o.status })), await learnings(ctx, cfg, idea.id));
    const known = new Set(others.map((o) => o.id));
    out.similar_ideas = out.similar_ideas.filter((s) => known.has(s.idea_id));
    if (!out.similar_ideas.length) out.is_duplicate = false;
    const block = out.is_duplicate && cfg.settings.duplicate_action !== 'flag';
    return {
      out,
      patch: { record: { ...idea.record, scope: out }, status: block ? 'duplicate' : 'active' },
      summary: out.is_duplicate ? `Likely duplicate of "${out.similar_ideas[0].title}".` : `Scoped. ${out.similar_ideas.length} similar idea(s), ${out.open_questions.length} open question(s).`,
    };
  },

  async evaluate(ctx, idea, type, cfg) {
    const { data: lastReturn } = await ctx.supabase.from('approvals').select('comment').eq('idea_id', idea.id).eq('decision', 'returned').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const out = await agents.evaluate(cfg, idea, type, await learnings(ctx, cfg, idea.id), lastReturn?.comment);
    const score = weighted(out.scores, type.config.criteria);
    return { out: { ...out, score }, patch: { record: { ...idea.record, evaluate: { ...out, score } }, score, confidence: null }, summary: `Business case built. Score ${score} of 100.` };
  },

  async judge(ctx, idea, type, cfg) {
    const ev = idea.record?.evaluate;
    if (!ev) throw new HttpError(409, 'Evaluate must run before Judge.');
    // The Judge sees the case and the scores, not the Evaluate agent's rationales.
    const out = await agents.judge(cfg, idea, type, { business_case: ev.business_case, scores: ev.scores.map(({ key, score }) => ({ key, score })), recommendation: ev.recommendation });
    const score = weighted(out.adjusted_scores, type.config.criteria) ?? idea.score;
    const confidence = clamp(out.confidence, 0, 100);
    return {
      out: { ...out, score, evaluate_score: ev.score },
      patch: { record: { ...idea.record, judge: { ...out, score, evaluate_score: ev.score } }, score, confidence },
      summary: `Verdict: ${out.verdict}. Score ${ev.score} adjusted to ${score}, confidence ${confidence}.`,
    };
  },

  async rank(ctx, idea, type, cfg) {
    const rows = must(
      await ctx.supabase.from('ideas').select('id, title, summary, score, confidence, rank, idea_types(name)').eq('org_id', ctx.orgId).in('status', ['active', 'awaiting_approval', 'returned']).not('score', 'is', null).limit(300),
      'Loading the portfolio'
    );
    if (!rows.some((r) => r.id === idea.id)) rows.push({ ...idea, idea_types: { name: type.name } });
    const w = Math.min(1, Math.max(0, Number(cfg.settings.confidence_weight) || 0));
    rows.sort((a, b) => priority(b, w) - priority(a, w));
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].rank !== i + 1) must(await ctx.supabase.from('ideas').update({ rank: i + 1 }).eq('id', rows[i].id), 'Updating ranks');
    }
    const position = rows.findIndex((r) => r.id === idea.id) + 1;
    const portfolio = rows.slice(0, 30).map((r, i) => ({ rank: i + 1, title: r.title, summary: r.summary, type: r.idea_types?.name, score: r.score, confidence: r.confidence }));
    const out = await agents.rank(cfg, idea, type, portfolio, position);
    const full = { ...out, position, portfolio_size: rows.length };
    return { out: full, patch: { record: { ...idea.record, rank: full }, rank: position }, summary: `Ranked ${position} of ${rows.length}. Recommendation: ${out.recommendation}.` };
  },

  async commit(ctx, idea, type, cfg) {
    const min = Number(cfg.settings.min_confidence_for_commit) || 0;
    if (idea.confidence != null && Number(idea.confidence) < min) {
      throw new HttpError(409, `The Judge's confidence (${Math.round(idea.confidence)}) is below this workspace's minimum of ${min} for a decision pack. Lower the minimum under How it works, or reject the idea.`);
    }
    const out = await agents.commit(cfg, idea, type);
    return { out, patch: { record: { ...idea.record, commit: out }, status: 'awaiting_approval' }, summary: `Decision pack ready for ${type.config.approver}.` };
  },

  async watch(ctx, idea, type, cfg) {
    const { data: approval } = await ctx.supabase.from('approvals').select('comment').eq('idea_id', idea.id).eq('decision', 'approved').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const out = await agents.handoff(cfg, idea, type, approval?.comment);
    return { out, patch: { record: { ...idea.record, watch_plan: out } }, summary: `Tracking set up: ${out.milestones.length} milestone(s), ${out.success_measures.length} measure(s).` };
  },
};

export async function advance(ctx, id, origin) {
  const idea = await loadIdea(ctx, id);
  const type = idea.idea_types;
  if (idea.status === 'awaiting_approval') throw new HttpError(409, 'This idea is waiting for an approval decision.');
  if (['rejected', 'duplicate', 'done'].includes(idea.status)) throw new HttpError(409, `This idea is marked ${idea.status} and cannot move forward.`);
  const stage = nextStage(idea);
  if (!stage) throw new HttpError(409, 'This idea is already at its final stage.');
  if (stage === 'watch' && idea.status !== 'approved') throw new HttpError(409, 'This idea needs approval before it can be tracked.');
  await checkQuota(ctx);
  const cfg = await loadConfig(ctx);
  const { out, patch, summary } = await RUNNERS[stage](ctx, idea, type, cfg);
  const saved = await save(ctx, idea, { ...(idea.status === 'returned' ? { status: 'active' } : {}), ...patch, stage });
  await log(ctx, idea, stage, agents.AGENTS[stage], summary, out);
  if (stage === 'commit') await notify(ctx, idea, 'approval', `Decision needed: ${idea.title}`, `A decision pack is ready for ${type.config.approver}.`, { roles: ['admin', 'approver'] }, origin);
  if (stage === 'scope' && saved.status === 'duplicate') await notify(ctx, idea, 'duplicate', `Possible duplicate: ${idea.title}`, summary, { users: [idea.created_by] }, origin);
  return saved;
}

export async function recordWatchUpdate(ctx, id, update, origin) {
  const idea = await loadIdea(ctx, id);
  if (idea.stage !== 'watch') throw new HttpError(409, 'Progress updates start once the idea is approved and being tracked.');
  if (idea.status === 'done') throw new HttpError(409, 'This idea is already closed.');
  await checkQuota(ctx);
  const previous = must(await ctx.supabase.from('watch_updates').select('note, percent_complete, rag, created_at').eq('idea_id', id).order('created_at', { ascending: false }).limit(8), 'Loading earlier updates');
  const cfg = await loadConfig(ctx);
  const out = await agents.watch(cfg, idea, idea.idea_types, update, previous);
  // Escalation follows the workspace governance setting. An on-track update is never an escalation.
  const rule = cfg.settings.escalate_on;
  if (rule === 'red') out.escalate = out.status === 'red';
  else if (rule === 'amber') out.escalate = out.status !== 'green';
  else if (out.status === 'green') out.escalate = false;
  if (!out.escalate) out.escalation_message = '';
  must(
    await ctx.supabase.from('watch_updates').insert({ idea_id: id, org_id: idea.org_id, note: update.note, percent_complete: update.percent_complete, rag: out.status, escalate: out.escalate, assessment: out }),
    'Saving the update'
  );
  const saved = await save(ctx, idea, { escalated: update.done ? false : out.escalate, status: update.done ? 'done' : idea.status });
  await log(ctx, idea, 'watch', agents.AGENTS.watch, `${update.done ? 'Closed' : 'Update assessed'}: ${out.status}${out.escalate ? ', escalated' : ''}.`, out);
  if (out.escalate) await notify(ctx, idea, 'escalation', `Escalated: ${idea.title}`, out.escalation_message || out.assessment, { roles: ['admin', 'approver'] }, origin);
  return saved;
}
