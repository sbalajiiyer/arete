# Idea Management

Seven agents take an idea from capture to tracked outcome: Capture, Scope, Evaluate, Judge, Rank, Commit, Watch.
A person makes every approval decision.

Live: https://idea-management-ten.vercel.app

## Stack

- Next.js 16 (App Router, plain JavaScript), deployed on Vercel
- Supabase: Postgres, sign-in, row-level security (one workspace per account)
- Vercel AI SDK; models from Groq (`openai/gpt-oss-120b`, fallback `openai/gpt-oss-20b`) or Vercel AI Gateway

## Layout

| Path | What it is |
|---|---|
| `app/page.js` | Sign-in, pipeline, idea detail, portfolio, idea types |
| `app/how/page.js` | "How it works": the editable live configuration and the eval suite |
| `app/api/capture` | Capture agent: text, web page or file in, idea records out |
| `app/api/ideas/[id]/advance` | Runs the next stage's agent for an idea |
| `app/api/ideas/[id]/decision` | Records the human approve / return / reject decision |
| `app/api/ideas/[id]/watch` | Assesses a progress update |
| `app/api/evals` | Runs one agent's eval cases against the workspace's configuration |
| `lib/agents.js` | Prompts, output schemas and the model call for each agent |
| `lib/defaults.js` | Default agent briefs, fixed guardrails, default governance settings |
| `lib/pipeline.js` | Orchestrator: stage order, scoring, ranking, governance rules |
| `lib/config.js` | Loads a workspace's live configuration on every run |
| `lib/evals.js` | 13 fixed test cases with pass/fail checks |
| `lib/extract.js` | Text extraction from .docx, .xlsx, .csv and public web pages |
| `lib/server.js` | Request authentication, daily cap, error handling |

## Run locally

```
cp .env.example .env.local   # fill in the values
npm install
npm run dev
```

## Database

The schema is not in this repository yet. It lives in the Supabase project's migration history
(`initial_schema`, `editable_agent_config`). Tables: `orgs`, `org_members`, `idea_types`, `ideas`,
`stage_runs`, `approvals`, `watch_updates`, `agent_configs`, `org_settings`, `org_memory`,
`config_changes`, `eval_runs`. Every table has row-level security keyed on workspace membership.

## Known gaps

See the project's build-status notes: one user per workspace, in-app escalation only, no integrations,
sign-up confirmation email points at the Supabase default site address.
