// Med check — 轻量 Web Push 后端
// 职责：1) 提供 VAPID 公钥  2) 存储设备订阅 + 每设备提醒时刻  3) 到点向推送服务发通知
// 存储用本地 subs.json（演示/小流量足够）；生产请换数据库。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const PORT = process.env.PORT || 8787;
const STATIC_DIR = process.env.STATIC_DIR || path.join(process.cwd(), '..');
const VAPID = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.vapid.json'), 'utf8'));
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:medcheck@example.com';
const SUBS_FILE = path.join(process.cwd(), 'subs.json');

webpush.setVapidDetails(VAPID_SUBJECT, VAPID.publicKey, VAPID.privateKey);

// ── 订阅存储 ──
let subs = [];
try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) { subs = []; }
function saveSubs() { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)); }

// ── 工具：把"用户本地时区的今天 HH:MM"转成可比较的本地日期/分钟 ──
function userNowInfo(tzOffsetMin) {
  // tzOffsetMin = new Date().getTimezoneOffset() （UTC - 本地，单位分钟）
  const utc = Date.now();
  const local = new Date(utc - tzOffsetMin * 60000); // 用户本地墙钟时间
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const d = String(local.getDate()).padStart(2, '0');
  const hh = String(local.getHours()).padStart(2, '0');
  const mm = String(local.getMinutes()).padStart(2, '0');
  return { dateStr: `${y}-${m}-${d}`, hhmm: `${hh}:${mm}` };
}

// ── 调度器：每 30 秒扫一次 ──
function tick() {
  const now = Date.now();
  subs.forEach((s) => {
    const off = typeof s.tzOffset === 'number' ? s.tzOffset : 0;
    const info = userNowInfo(off);
    const sched = s.schedule || {};
    ['morning', 'noon', 'evening'].forEach((slot) => {
      const r = sched[slot];
      if (!r || r.push !== true || !r.time) return;
      if (r.time > info.hhmm) return; // 还没到点（字符串比较 HH:MM 足够）
      const key = info.dateStr + '__' + slot;
      s.lastPushed = s.lastPushed || {};
      if (s.lastPushed[key]) return; // 今天该时段已推
      s.lastPushed[key] = now;
      const slotLabel = slot === 'morning' ? 'Morning' : slot === 'noon' ? 'Noon' : 'Evening';
      const payload = JSON.stringify({
        title: 'Med check ♡',
        body: `Time for your meds — ${slotLabel} ♡`,
        slot,
        url: '/'
      });
      webpush.sendNotification(s.subscription, payload, { TTL: 0 })
        .catch((err) => {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) {
            // 订阅已失效，移除
            subs = subs.filter((x) => x !== s);
            saveSubs();
          }
        });
    });
  });
  saveSubs();
}
setInterval(tick, 30000);
tick();

// ── HTTP 路由 ──
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
function serveStatic(req, res, urlPath) {
  var rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越
  var safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  var filePath = path.join(STATIC_DIR, safe);
  if (!filePath.startsWith(path.resolve(STATIC_DIR))) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, function (err, buf) {
    if (err) {
      // SPA 回退到 index.html
      fs.readFile(path.join(STATIC_DIR, 'index.html'), function (e2, buf2) {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(buf2);
      });
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/vapid') {
    return send(res, 200, { publicKey: VAPID.publicKey });
  }

  if (req.method === 'POST' && url === '/api/subscribe') {
    const body = await readBody(req);
    if (!body.subscription || !body.subscription.endpoint) return send(res, 400, { error: 'no subscription' });
    const ep = body.subscription.endpoint;
    const exist = subs.find((x) => x.subscription.endpoint === ep);
    const rec = {
      subscription: body.subscription,
      schedule: body.schedule || {},
      tzOffset: typeof body.tzOffset === 'number' ? body.tzOffset : new Date().getTimezoneOffset(),
      lastPushed: exist ? exist.lastPushed : {},
      updatedAt: Date.now()
    };
    if (exist) Object.assign(exist, rec);
    else subs.push(rec);
    saveSubs();
    return send(res, 200, { ok: true, count: subs.length });
  }

  if (req.method === 'POST' && url === '/api/schedule') {
    const body = await readBody(req);
    const ep = body.endpoint;
    const s = subs.find((x) => x.subscription.endpoint === ep);
    if (!s) return send(res, 404, { error: 'unknown subscription' });
    s.schedule = body.schedule || s.schedule;
    s.tzOffset = typeof body.tzOffset === 'number' ? body.tzOffset : s.tzOffset;
    s.updatedAt = Date.now();
    saveSubs();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && (url === '/health' || url === '/api/health')) {
    return send(res, 200, { ok: true, subs: subs.length });
  }

  // 非 API 的 GET 请求 → 托管 PWA 静态文件（同端口既托管又推送）
  if (req.method === 'GET' && !url.startsWith('/api/')) {
    return serveStatic(req, res, url);
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`[push-server] listening on :${PORT}`));
