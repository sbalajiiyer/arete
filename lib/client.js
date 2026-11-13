'use client';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_KEY);

export async function api(path, body) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token || ''}` },
    body: JSON.stringify(body || {}),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = { error: res.status === 504 ? 'The agent took too long. Try again.' : `Request failed (${res.status}).` };
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  return json;
}

export const STAGES = ['capture', 'scope', 'evaluate', 'judge', 'rank', 'commit', 'watch'];
export const label = (k) => String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
