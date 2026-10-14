const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createClient } = require('redis');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });

let redis = null;
async function getRedis() {
  if (redis && redis.isOpen) return redis;
  redis = createClient({ url: config.redisUrl });
  redis.on('error', (e) => console.error('redis error', e.message));
  await redis.connect();
  return redis;
}

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// ---- Redis jobs (things Postgres shouldn't do) ----

async function rateLimit(ip) {
  const r = await getRedis();
  const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, 60);
  return n <= config.rateLimitPerMin;
}

async function cachedBalance(fetchFn) {
  const r = await getRedis();
  const key = 'balance:event:1';
  const hit = await r.get(key);
  if (hit) return { ...JSON.parse(hit), cached: true };
  const fresh = await fetchFn();
  await r.set(key, JSON.stringify(fresh), { EX: config.balanceCacheSeconds });
  return { ...fresh, cached: false };
}

async function invalidateBalance() {
  const r = await getRedis();
  await r.del('balance:event:1');
}

// ---- Postgres jobs (durable data) ----

async function getEvent() {
  const { rows } = await pool.query('SELECT * FROM events ORDER BY id LIMIT 1');
  return rows[0];
}

async function getItems(eventId) {
  const { rows } = await pool.query(
    'SELECT id, label, amount FROM items WHERE event_id = $1 ORDER BY id',
    [eventId],
  );
  return rows;
}

async function getContributors(eventId) {
  const { rows } = await pool.query(
    'SELECT id, name, pledged, paid, note FROM contributors WHERE event_id = $1 ORDER BY id',
    [eventId],
  );
  return rows;
}

async function markPaid(id) {
  await pool.query('UPDATE contributors SET paid = true WHERE id = $1', [id]);
}

async function computeBalance() {
  const ev = await getEvent();
  const items = await getItems(ev.id);
  const contributors = await getContributors(ev.id);

  const spent = items.reduce((s, i) => s + i.amount, 0);
  const pledgedTotal = contributors.reduce((s, c) => s + c.pledged, 0);
  const received = contributors
    .filter((c) => c.paid && c.name !== ev.payer_name)
    .reduce((s, c) => s + c.pledged, 0);
  const outstanding = contributors
    .filter((c) => !c.paid && c.name !== ev.payer_name && c.pledged > 0)
    .reduce((s, c) => s + c.pledged, 0);
  const overage = spent - pledgedTotal;

  return { spent, pledgedTotal, received, outstanding, overage };
}

// ---- HTML rendering ----

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function render(ev, items, contributors, balance) {
  const itemRows = items
    .map((i) => `<tr><td>${esc(i.label)}</td><td class="num">₹${i.amount}</td></tr>`)
    .join('');
  const contribRows = contributors
    .map((c) => {
      const isPayer = c.name === ev.payer_name;
      const status = isPayer
        ? '<span class="payer">payer</span>'
        : c.pledged === 0
          ? '<span class="free">free</span>'
          : c.paid
            ? '<span class="paid">paid</span>'
            : `<form method="post" action="/pay/${c.id}"><button type="submit">mark paid</button></form>`;
      return `<tr>
        <td>${esc(c.name)}${c.note ? `<small> · ${esc(c.note)}</small>` : ''}</td>
        <td class="num">₹${c.pledged}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CakeBudget</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#0f172a}
  h1{margin-bottom:4px}
  .sub{color:#64748b;margin-top:0}
  table{width:100%;border-collapse:collapse;margin:12px 0 24px}
  th,td{padding:8px 4px;border-bottom:1px solid #e2e8f0;text-align:left}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  small{color:#64748b}
  button{font:inherit;padding:4px 10px;cursor:pointer}
  .paid{color:#16a34a;font-weight:600}
  .payer{color:#7c3aed;font-weight:600}
  .free{color:#94a3b8}
  .stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:16px 0}
  .stat{background:#f1f5f9;padding:12px;border-radius:8px}
  .stat b{display:block;font-size:22px}
  .warn{color:#dc2626}
  .ok{color:#16a34a}
</style></head><body>
<h1>CakeBudget</h1>
<p class="sub">${esc(ev.name)} · estimated ₹${ev.estimate_lo}–${ev.estimate_hi} · paid upfront by <b>${esc(ev.payer_name)}</b></p>

<div class="stats">
  <div class="stat"><small>Spent</small><b>₹${balance.spent}</b></div>
  <div class="stat"><small>Pledged</small><b>₹${balance.pledgedTotal}</b></div>
  <div class="stat"><small>Received</small><b class="ok">₹${balance.received}</b></div>
  <div class="stat"><small>Outstanding</small><b class="${balance.outstanding > 0 ? 'warn' : ''}">₹${balance.outstanding}</b></div>
</div>
<p class="sub">${balance.overage > 0
    ? `${esc(ev.payer_name)} absorbs ₹${balance.overage} over the pledges.`
    : `Pledges cover the spend.`}
  ${balance.cached ? ' · <i>cached</i>' : ''}
</p>

<h2>Items</h2>
<table><thead><tr><th>Item</th><th class="num">Amount</th></tr></thead>
<tbody>${itemRows}</tbody></table>

<h2>Contributors</h2>
<table><thead><tr><th>Person</th><th class="num">Pledged</th><th>Status</th></tr></thead>
<tbody>${contribRows}</tbody></table>

</body></html>`;
}

// ---- HTTP server ----

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }

    if (req.method === 'GET' && req.url === '/') {
      const ip = req.socket.remoteAddress || 'unknown';
      const allowed = await rateLimit(ip);
      if (!allowed) {
        res.writeHead(429, { 'content-type': 'text/plain' });
        return res.end('Too many requests, slow down.');
      }
      const ev = await getEvent();
      const items = await getItems(ev.id);
      const contributors = await getContributors(ev.id);
      const balance = await cachedBalance(computeBalance);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(render(ev, items, contributors, balance));
    }

    const payMatch = req.method === 'POST' && req.url.match(/^\/pay\/(\d+)$/);
    if (payMatch) {
      await markPaid(Number(payMatch[1]));
      await invalidateBalance();
      res.writeHead(303, { location: '/' });
      return res.end();
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Something went wrong.');
  }
});

ensureSchema()
  .then(() => {
    server.listen(config.port, config.host, () => {
      console.log(`cakebudget listening on http://${config.host}:${config.port}`);
    });
  })
  .catch((err) => {
    console.error('schema init failed', err);
    process.exit(1);
  });

process.on('SIGTERM', () => {
  server.close(() => pool.end().then(() => process.exit(0)));
});