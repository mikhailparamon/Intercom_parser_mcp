const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const started = Date.now();
const outDir = path.join(__dirname, 'data');
const jsonlPath = path.join(outDir, 'conversations.jsonl');
const manifestPath = path.join(outDir, 'manifest.json');

function loadEnv() {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function clean(text) {
  if (typeof text !== 'string') return '';
  let s = text
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED]');
  s = s.replace(/\b(password|passwd|pwd|token|api[_ -]?key|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  s = s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]');
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, '[REDACTED]');
  s = s.replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ru|ru|co|app|dev|ai|info|biz|me|xyz|tech|online|site|store|cloud|pro|рф)\b/gi, '[REDACTED]');
  s = s.replace(/(?<!\w)(?:(?:\+\d{1,3}|8)[\s().-]*\d{3,4}(?:[\s().-]*\d{2,4}){2,3}|\(?\d{3,4}\)?[\s.-]+\d{2,4}(?:[\s.-]+\d{2,4}){1,2})(?!\w)/g, '[REDACTED]');
  s = s.replace(/(?:^|\n)\s*(?:с уважением|уважением|best regards|kind regards|regards|sincerely|cheers|отправлено с (?:моего )?(?:iphone|ipad|android)).*[\s\S]*$/i, '');
  return s.trim();
}
function iso(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
function extract(r) {
  const text = (r.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  if (!text) throw new Error('MCP returned no text payload');
  try { return JSON.parse(text); } catch { throw new Error('MCP returned an unparseable payload'); }
}
function redactPhone(text) { return text; }

async function main() {
  loadEnv();
  if (!process.env.INTERCOM_ACCESS_TOKEN) throw new Error('INTERCOM_ACCESS_TOKEN is missing from .env');
  const now = new Date();
  const end = process.env.END_DATE ? new Date(`${process.env.END_DATE}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = process.env.START_DATE ? new Date(`${process.env.START_DATE}T00:00:00Z`) : (() => {
    const y = now.getUTCFullYear(), m = now.getUTCMonth() - 3, d = now.getUTCDate();
    const first = new Date(Date.UTC(y, m, 1));
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate())));
  })();
  if (!(start < end)) throw new Error('Invalid interval: start must be before end');
  const mode = (process.env.EXPORT_TYPE || 'all').toLowerCase();
  if (!['new', 'updated', 'all'].includes(mode)) throw new Error('EXPORT_TYPE must be new, updated, or all');
  const lo = Math.floor(start.getTime() / 1000), hi = Math.floor(end.getTime() / 1000);
  const client = new Client({ name: 'intercom-clean-export', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.intercom.com/mcp'), { requestInit: { headers: { Authorization: `Bearer ${process.env.INTERCOM_ACCESS_TOKEN}` } } });
  const errors = [], limitations = [], ids = new Map();
  let selected = [];
  let searchPages = 0, incompleteSearch = false;
  const search = async filters => {
    let cursor;
    do {
      const args = { ...filters, per_page: 150 };
      if (cursor) args.starting_after = cursor;
      const data = extract(await client.callTool({ name: 'search_conversations', arguments: args }));
      searchPages++;
      const rows = data.conversations || data.results || [];
      for (const row of rows) if (row.id != null) ids.set(String(row.id), row);
      cursor = data.pages?.next?.starting_after;
      if (data.isError || (!Array.isArray(data.conversations) && !Array.isArray(data.results))) throw new Error('Unexpected search response shape');
      if (!cursor && data._note) { incompleteSearch = true; limitations.push('Search response indicated additional pages but provided no usable cursor.'); }
    } while (cursor);
  };
  const records = [];
  try {
    await client.connect(transport);
    if (mode === 'new' || mode === 'all') await search({ created_at: { operator: '>=', value: lo } });
    if (mode === 'updated' || mode === 'all') await search({ created_at: { operator: '<', value: lo }, updated_at: { operator: '>=', value: lo } });
    // The updated search's upper bound is checked against returned timestamps locally.
    selected = [...ids.values()].filter(c => {
      const created = Number(c.created_at), updated = Number(c.updated_at);
      const isNew = created >= lo && created < hi;
      const isUpdated = created < lo && updated >= lo && updated < hi;
      return mode === 'new' ? isNew : mode === 'updated' ? isUpdated : (isNew || isUpdated);
    });
    let processed = 0;
    const fetchOne = async summary => {
      try {
        const c = extract(await client.callTool({ name: 'get_conversation', arguments: { id: String(summary.id) } }));
        const record = { id: String(c.id) };
        if (c.title !== undefined && c.title !== null) record.title = clean(c.title);
        const created = iso(c.created_at), updated = iso(c.updated_at);
        if (created) record.created_at = created;
        if (updated) record.updated_at = updated;
        const messages = [];
        const sourceText = clean(c.source?.body);
        if (sourceText.trim()) messages.push({ role: 'customer', part_type: 'source', text: sourceText });
        const hist = c.conversation_parts;
        const parts = hist?.conversation_parts;
        if (!Array.isArray(parts)) {
          limitations.push(`Conversation ${c.id}: MCP did not return a conversation_parts array.`);
        } else {
          if (Number.isFinite(hist.total_count) && hist.total_count > parts.length) limitations.push(`Conversation ${c.id}: MCP returned ${parts.length} of ${hist.total_count} conversation parts.`);
          for (const part of parts) {
            const body = clean(part.body);
            if (!body.trim()) continue;
            const typ = part.author?.type;
            const role = typ === 'user' ? 'customer' : typ === 'admin' ? 'operator' : typ === 'bot' ? 'bot' : 'unknown';
            const msg = { role };
            if (part.part_type !== undefined && part.part_type !== null) msg.part_type = part.part_type;
            msg.text = body;
            messages.push(msg);
          }
        }
        record.messages = messages;
        return record;
      } catch (e) { errors.push(`Conversation ${summary.id}: ${e.message}`); return null; }
    };
    const concurrency = 20;
    for (let i = 0; i < selected.length; i += concurrency) {
      const batch = await Promise.all(selected.slice(i, i + concurrency).map(fetchOne));
      records.push(...batch.filter(Boolean));
      processed += batch.length;
      if (processed % 50 < concurrency || processed === selected.length) console.log(`Fetched ${processed}/${selected.length}`);
    }
  } catch (e) { errors.push(e.message); }
  finally { try { await client.close(); } catch {} }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jsonlPath, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  const status = errors.length || limitations.length || incompleteSearch ? 'partial' : 'complete';
  const manifest = {
    period: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), interval: '[start, end)', timezone: 'UTC' },
    selection_type: mode,
    found_conversations: ids.size,
    selected_conversations: selected.length,
    saved_conversations: records.length,
    search_pages: searchPages,
    errors,
    duration_seconds: Math.round((Date.now() - started) / 1000 * 100) / 100,
    status,
    limitations: [...new Set(limitations)]
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ saved: records.length, found: ids.size, status, jsonlPath, manifestPath }));
}
main().catch(e => { console.error(e.message); process.exit(1); });
