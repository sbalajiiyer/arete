import { HttpError } from './server';

const MAX_CHARS = 40000;
const clip = (s) => s.replace(/\u0000/g, '').slice(0, MAX_CHARS).trim();

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    return '';
  }
  return String(v);
}

export async function extractFile(filename, base64) {
  const buf = Buffer.from(base64, 'base64');
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'docx') {
    const mammoth = (await import('mammoth')).default;
    return clip((await mammoth.extractRawText({ buffer: buf })).value);
  }
  if (ext === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    let out = '';
    wb.eachSheet((ws) => {
      out += `Sheet: ${ws.name}\n`;
      ws.eachRow((row) => {
        out += row.values.slice(1).map(cellText).join(' | ') + '\n';
      });
    });
    return clip(out);
  }
  if (['txt', 'md', 'csv', 'json', 'vtt', 'srt'].includes(ext)) return clip(buf.toString('utf8'));
  throw new HttpError(400, 'Unsupported file type. Use .docx, .xlsx, .csv, .txt or .md.');
}

// Only public web addresses: no IP literals, no local or internal hostnames, and every redirect is re-checked.
function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'That is not a valid web address.');
  }
  const h = u.hostname.toLowerCase();
  const blocked =
    !['http:', 'https:'].includes(u.protocol) ||
    h === 'localhost' ||
    !h.includes('.') ||
    h.includes(':') ||
    /^[\d.]+$/.test(h) ||
    /\.(local|internal|localhost|lan|home|corp)$/.test(h);
  if (blocked) throw new HttpError(400, 'Only public web pages can be captured.');
  return u;
}

export async function extractUrl(raw) {
  let url = assertPublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'IdeaCaptureBot/0.1' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = assertPublicUrl(new URL(res.headers.get('location'), url).toString());
      continue;
    }
    if (!res.ok) throw new HttpError(400, `Could not read that page (status ${res.status}).`);
    const html = (await res.text()).slice(0, 2000000);
    const text = html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ');
    return clip(text);
  }
  throw new HttpError(400, 'Too many redirects.');
}
