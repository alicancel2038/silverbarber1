// پیرایش سیلور - نسخه‌ی Vercel (سرورلس + دیتابیس Upstash Redis)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ============ تنظیمات ============ */
// روی Vercel بهتر است این‌ها را در Environment Variables بگذاری (در غیر این صورت مقدار پیش‌فرض استفاده می‌شود)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '1234';      // حتماً در Vercel عوضش کن!
const SECRET = process.env.ADMIN_SECRET || crypto.createHash('sha256').update('silver|' + ADMIN_PASS).digest('hex');
const OPEN_HOUR = 10, CLOSE_HOUR = 22;
const LUNCH_START = 14, LUNCH_END = 16;
const SLOT_MINUTES = 30, DAYS_AHEAD = 7;
const CLOSED_WEEKDAYS = [5];
const CLOSE_ON_OFFICIAL_HOLIDAYS = false;
/* ================================== */

const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function rcall(p, payload) {
  if (!RURL || !RTOK) throw new Error('REDIS_NOT_CONFIGURED');
  const r = await fetch(RURL + p, { method: 'POST', headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.json();
}
const R = async (...cmd) => { const j = await rcall('', cmd); if (j.error) throw new Error(j.error); return j.result; };
const RP = async cmds => (await rcall('/pipeline', cmds)).map(x => { if (x.error) throw new Error(x.error); return x.result; });

const pad = n => String(n).padStart(2, '0');
// همه‌ی تاریخ‌ها و ساعت‌ها بر اساس وقت تهران حساب می‌شوند (حتی اگر ساعت سرور UTC باشد)
const tehranNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const todayKey = () => tehranNow().date;
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return { date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`, wd: dt.getUTCDay() }; };
const isDateKey = k => /^\d{4}-\d{2}-\d{2}$/.test(k || '') && addDays(k, 0).date === k;
const jMonthKey = ds => { const p = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric' }).formatToParts(new Date(ds + 'T12:00:00Z')); return p.find(x => x.type === 'year').value + '-' + p.find(x => x.type === 'month').value; };
const fa2en = s => String(s).replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c));
function slotsForDay() {
  const out = [];
  for (let m = OPEN_HOUR * 60; m + SLOT_MINUTES <= CLOSE_HOUR * 60; m += SLOT_MINUTES) {
    if (m >= LUNCH_START * 60 && m < LUNCH_END * 60) continue;   // ناهار
    out.push(`${pad(m / 60 | 0)}:${pad(m % 60)}`);
  }
  return out;
}
/* ---------- تقویم رسمی ایران ---------- */
// تعطیلات ثابت شمسی (هر سال تکرار می‌شوند): 'ماه-روز'
const SOLAR_HOLIDAYS = { '1-1': 'عید نوروز', '1-2': 'عید نوروز', '1-3': 'عید نوروز', '1-4': 'عید نوروز', '1-12': 'روز جمهوری اسلامی', '1-13': 'روز طبیعت (سیزده‌بدر)', '3-14': 'رحلت امام خمینی', '3-15': 'قیام ۱۵ خرداد', '11-22': 'پیروزی انقلاب اسلامی', '12-29': 'ملی شدن صنعت نفت', '12-30': 'ملی شدن صنعت نفت' };
// تعطیلات مذهبی (قمری) هر سال جابه‌جا می‌شوند و باید سالانه به‌روز شوند. تاریخ میلادی: مناسبت (مطابق تقویم رسمی ۱۴۰۵ تا اوایل ۱۴۰۶)
const LUNAR_HOLIDAYS = {
  '2026-11-13': 'شهادت حضرت فاطمه زهرا (س)',           // ۲۲ آبان ۱۴۰۵
  '2026-12-23': 'ولادت امام علی (ع) و روز پدر',        // ۲ دی ۱۴۰۵
  '2027-01-06': 'مبعث رسول اکرم (ص)',                  // ۱۶ دی ۱۴۰۵
  '2027-01-24': 'ولادت حضرت قائم (عج) - نیمه شعبان',   // ۴ بهمن ۱۴۰۵
  '2027-02-28': 'شهادت امام علی (ع)',                  // ۹ اسفند ۱۴۰۵
  '2027-03-10': 'عید سعید فطر',                        // ۱۹ اسفند ۱۴۰۵
  '2027-03-11': 'تعطیل به مناسبت عید فطر',             // ۲۰ اسفند ۱۴۰۵
  '2027-04-03': 'شهادت امام جعفر صادق (ع)'             // ۱۴ فروردین ۱۴۰۶
};
// بعد از تاریخ زیر، تقویم رسمی هنوز منتشر نشده و تعطیلات مذهبی خودکار «تخمین» زده می‌شوند و با برچسب (احتمالی) دیده می‌شوند
const OFFICIAL_LUNAR_UNTIL = '2027-04-07';   // ۱۸ فروردین ۱۴۰۶
const LUNAR_RULES = { '1-9': 'تاسوعای حسینی', '1-10': 'عاشورای حسینی', '2-20': 'اربعین حسینی', '2-28': 'رحلت رسول اکرم (ص) و شهادت امام حسن (ع)', '3-8': 'شهادت امام حسن عسکری (ع)', '3-17': 'میلاد رسول اکرم (ص) و امام جعفر صادق (ع)', '6-3': 'شهادت حضرت فاطمه زهرا (س)', '7-13': 'ولادت امام علی (ع) و روز پدر', '7-27': 'مبعث رسول اکرم (ص)', '8-15': 'ولادت حضرت قائم (عج) - نیمه شعبان', '9-21': 'شهادت امام علی (ع)', '10-1': 'عید سعید فطر', '10-2': 'تعطیل به مناسبت عید فطر', '10-25': 'شهادت امام جعفر صادق (ع)', '12-10': 'عید سعید قربان', '12-18': 'عید سعید غدیر خم' };
const hijriOf = (ds, off) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + off); const p = new Intl.DateTimeFormat('en-u-ca-islamic-nu-latn', { timeZone: 'UTC', month: 'numeric', day: 'numeric' }).formatToParts(d); return { m: +p.find(x => x.type === 'month').value, d: +p.find(x => x.type === 'day').value }; };
// تقویم رسمی ایران نسبت به محاسبه‌ی نجومی معمولاً یک روز عقب‌تر است (روی تعطیلات ۱۴۰۵ تست شد: ۹ از ۱۰ مورد درست)
const estLunar = ds => { const h = hijriOf(ds, -1), next = hijriOf(ds, 0); if (h.m === 2 && next.m === 3) return 'شهادت امام رضا (ع)'; return LUNAR_RULES[h.m + '-' + h.d] || null; };
const jParts = ds => { const p = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(ds + 'T12:00:00Z')); const g = t => +p.find(x => x.type === t).value; return { y: g('year'), m: g('month'), d: g('day') }; };
const holiday = ds => {
  if (LUNAR_HOLIDAYS[ds]) return { name: LUNAR_HOLIDAYS[ds], est: false };
  const j = jParts(ds), sol = SOLAR_HOLIDAYS[j.m + '-' + j.d]; if (sol) return { name: sol, est: false };
  if (ds > OFFICIAL_LUNAR_UNTIL) { const e = estLunar(ds); if (e) return { name: e + ' (احتمالی)', est: true }; }
  return null;
};
const holidayOf = ds => (holiday(ds) || {}).name || null;

const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(a => a[0]));
const ipOf = req => String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '').trim().slice(0, 64);
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const hex = n => crypto.randomBytes(n).toString('hex');
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const isAdmin = req => { const t = cookies(req).adm; if (!t) return false; const [exp, sig] = t.split('.'); return !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp)); };

const loadClosures = async () => ((await R('HVALS', 'cl')) || []).map(x => JSON.parse(x));
const loadBookings = async () => { const a = (await R('HGETALL', 'bk')) || []; const out = []; for (let i = 1; i < a.length; i += 2) out.push(JSON.parse(a[i])); return out; };
const slotKey = (d, t) => `slot:${d}:${t}`;
const SLOT_TTL = 100 * 86400;
async function limited(key, max, sec) { const k = 'rl:' + key; const n = await R('INCR', k); if (n === 1) await R('EXPIRE', k, sec); return n > max; }
async function release(bk) { const keys = [slotKey(bk.date, bk.time), ...(bk.lims || [])]; await R('DEL', ...keys); }

const closureOf = (cls, date) => { let all = false; const times = new Set(); for (const c of cls) if (c.date === date) { if (c.all) all = true; else c.times.forEach(t => times.add(t)); } return { all, times }; };
const weeklyClosed = date => CLOSED_WEEKDAYS.includes(addDays(date, 0).wd);
const dayClosedAll = (cls, date) => weeklyClosed(date) || closureOf(cls, date).all || (CLOSE_ON_OFFICIAL_HOLIDAYS && !!(holiday(date) && !holiday(date).est));
function validDays(cls) {
  const out = [], t = todayKey();
  for (let i = 0; i < DAYS_AHEAD; i++) { const d = addDays(t, i); out.push({ date: d.date, open: !dayClosedAll(cls, d.date), holiday: holidayOf(d.date) }); }
  return out;
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
async function body(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return new Promise(resolve => { let s = ''; req.on('data', c => { s += c; if (s.length > 5000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); req.on('error', () => resolve({})); });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.searchParams.get('__p') || decodeURIComponent(url.pathname);
  const ip = ipOf(req), ck = cookies(req);
  const SEC = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';   // روی Vercel همیشه https است
  let did = ck.did; const setDid = [];
  if (!did || !/^[a-f0-9]{32}$/.test(did)) { did = hex(16); setDid.push(`did=${did}; Path=/; Max-Age=31536000; HttpOnly${SEC}; SameSite=Lax`); }
  try {
    /* ---------- API عمومی ---------- */
    if (p === '/api/days' && req.method === 'GET') {
      const cls = await loadClosures(), n = tehranNow();
      return send(res, 200, { days: validDays(cls), slots: slotsForDay(), today: n.date, now: n.time }, { 'Set-Cookie': setDid });
    }
    if (p === '/api/taken' && req.method === 'GET') {
      const d = url.searchParams.get('date'), n = tehranNow(), slots = slotsForDay();
      if (!isDateKey(d)) return send(res, 400, { error: 'تاریخ معتبر نیست.' });
      const cls = await loadClosures(), cl = closureOf(cls, d);
      const closed = dayClosedAll(cls, d) ? slots : [...cl.times];
      const m = await R('MGET', ...slots.map(t => slotKey(d, t)));
      const booked = slots.filter((t, i) => m[i]);
      return send(res, 200, { taken: [...new Set([...booked, ...closed])], closed, today: n.date, now: n.time }, { 'Set-Cookie': setDid });
    }
    if (p === '/api/book' && req.method === 'POST') {
      if (await limited('book:' + ip, 8, 600)) return send(res, 429, { error: 'تعداد تلاش‌های شما زیاد بود. چند دقیقه بعد دوباره امتحان کنید.' });
      const b = await body(req);
      const name = String(b.name || '').trim().replace(/\s+/g, ' ');
      const phone = fa2en(b.phone || '').replace(/\D/g, '');
      const fp = String(b.fp || '').slice(0, 64), lid = String(b.lid || '').slice(0, 64);
      if (name.length < 3 || name.length > 60) return send(res, 400, { error: 'نام و نام خانوادگی را کامل وارد کنید.' });
      if (!/^09\d{9}$/.test(phone)) return send(res, 400, { error: 'شماره موبایل باید مثل 09123456789 باشد.' });
      const cls = await loadClosures();
      const day = validDays(cls).find(d => d.date === b.date);
      if (!day || !day.open) return send(res, 400, { error: 'این روز برای رزرو در دسترس نیست.' });
      if (!slotsForDay().includes(b.time)) return send(res, 400, { error: 'ساعت انتخاب‌شده معتبر نیست.' });
      if (closureOf(cls, day.date).times.has(b.time)) return send(res, 400, { error: 'این ساعت در دسترس نیست (تعطیل).' });
      const tn = tehranNow();
      if (day.date === tn.date && b.time <= tn.time) return send(res, 400, { error: 'این ساعت گذشته است.' });
      const id = hex(5);
      if (!(await R('SET', slotKey(b.date, b.time), id, 'NX', 'EX', SLOT_TTL))) return send(res, 409, { error: 'این ساعت همین الان رزرو شد. لطفاً ساعت دیگری انتخاب کنید.' });
      // یک نوبت در روز برای هر کاربر: شماره، IP، کوکی دستگاه، اثرانگشت مرورگر و شناسه ذخیره‌شده (هر کدام یک کلید اتمیک)
      const t = todayKey();
      const lims = [['p', phone], ['i', ip], ['d', did], ['f', fp], ['l', lid]].filter(x => x[1]).map(([k, v]) => `lim:${t}:${k}:${v}`);
      const rs = await RP(lims.map(k => ['SET', k, id, 'NX', 'EX', 172800]));
      if (rs.some(x => x !== 'OK')) {
        const mine = lims.filter((k, i) => rs[i] === 'OK');
        await R('DEL', slotKey(b.date, b.time), ...mine);
        return send(res, 403, { error: 'شما امروز یک نوبت ثبت کرده‌اید. هر نفر در روز فقط یک نوبت می‌تواند بگیرد.' }, { 'Set-Cookie': setDid });
      }
      const rec = { id, name, phone, date: b.date, time: b.time, status: 'active', createdDay: t, createdAt: new Date().toISOString(), ip, did, fp, lid, lims };
      await R('HSET', 'bk', id, JSON.stringify(rec));
      return send(res, 200, { ok: true, date: rec.date, time: rec.time }, { 'Set-Cookie': setDid });
    }

    /* ---------- پنل ادمین ---------- */
    if (p === '/admin' || p === '/admin/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'private', 'admin.html')));
    }
    if (p === '/admin/api/login' && req.method === 'POST') {
      if (await limited('login:' + ip, 5, 900)) return send(res, 429, { error: 'تلاش بیش از حد. ۱۵ دقیقه بعد دوباره امتحان کنید.' });
      const b = await body(req);
      if (safeEq(b.user || '', ADMIN_USER) && safeEq(b.pass || '', ADMIN_PASS)) {
        const exp = String(Date.now() + 8 * 3600e3);
        return send(res, 200, { ok: true }, { 'Set-Cookie': `adm=${exp}.${sign(exp)}; Path=/admin; Max-Age=28800; HttpOnly${SEC}; SameSite=Strict` });
      }
      return send(res, 401, { error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
    if (p.startsWith('/admin/api/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      if (p === '/admin/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; Path=/admin; Max-Age=0' });

      if (p === '/admin/api/bookings' && req.method === 'GET') {
        const all = await loadBookings(), t = todayKey(), mk = jMonthKey(t);
        const done = all.filter(x => x.status === 'done' && x.doneDay);
        const sum = l => l.reduce((a, x) => a + (x.paid || 0), 0);
        return send(res, 200, {
          bookings: all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)), today: t,
          holidays: Object.fromEntries([...new Set(all.map(x => x.date))].map(d => [d, holidayOf(d)]).filter(x => x[1])),
          revenueToday: sum(done.filter(x => x.doneDay === t)), revenueMonth: sum(done.filter(x => jMonthKey(x.doneDay) === mk))
        });
      }
      if (p === '/admin/api/bookings' && req.method === 'POST') {   // نوبت حضوری
        const b = await body(req);
        const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'مشتری';
        const phone = fa2en(b.phone || '').replace(/\D/g, '');
        if (phone && !/^09\d{9}$/.test(phone)) return send(res, 400, { error: 'شماره موبایل معتبر نیست (یا آن را خالی بگذارید).' });
        if (!isDateKey(b.date) || b.date < todayKey()) return send(res, 400, { error: 'تاریخ معتبر نیست.' });
        if (!slotsForDay().includes(b.time)) return send(res, 400, { error: 'ساعت معتبر نیست.' });
        const id = hex(5);
        if (!(await R('SET', slotKey(b.date, b.time), id, 'NX', 'EX', SLOT_TTL))) return send(res, 409, { error: 'این ساعت قبلاً پر شده است.' });
        await R('HSET', 'bk', id, JSON.stringify({ id, name, phone, date: b.date, time: b.time, status: 'active', manual: true, createdDay: null, createdAt: new Date().toISOString(), ip: '', did: '', fp: '', lid: '', lims: [] }));
        return send(res, 200, { ok: true });
      }
      const m = p.match(/^\/admin\/api\/bookings\/([a-f0-9]+)$/);
      if (m) {
        const raw = await R('HGET', 'bk', m[1]); if (!raw) return send(res, 404, { error: 'not found' });
        const bk = JSON.parse(raw);
        if (req.method === 'DELETE') { if (bk.status !== 'canceled') await release(bk); await R('HDEL', 'bk', bk.id); return send(res, 200, { ok: true }); }
        if (req.method === 'PATCH') {
          const b = await body(req); if (!['active', 'done', 'canceled'].includes(b.status)) return send(res, 400, { error: 'bad status' });
          if (b.status === 'done') {
            const paid = parseInt(fa2en(b.paid == null ? '' : b.paid).replace(/\D/g, '') || '0', 10);
            if (paid > 1e10) return send(res, 400, { error: 'مبلغ معتبر نیست.' });
            bk.paid = paid; if (!bk.doneDay) bk.doneDay = todayKey();
          } else { delete bk.paid; delete bk.doneDay; }
          if (b.status === 'canceled' && bk.status !== 'canceled') await release(bk);
          if (b.status !== 'canceled' && bk.status === 'canceled') {
            if (!(await R('SET', slotKey(bk.date, bk.time), bk.id, 'NX', 'EX', SLOT_TTL))) return send(res, 409, { error: 'این ساعت دیگر خالی نیست.' });
            bk.lims = [];
          }
          bk.status = b.status; await R('HSET', 'bk', bk.id, JSON.stringify(bk));
          return send(res, 200, { ok: true });
        }
      }
      if (p === '/admin/api/closures' && req.method === 'GET') {
        const t = todayKey(), days = [], cls = await loadClosures();
        for (let i = 0; i < 120; i++) { const d = addDays(t, i); days.push({ date: d.date, weekly: CLOSED_WEEKDAYS.includes(d.wd), holiday: holidayOf(d.date) }); }
        return send(res, 200, { closures: cls.filter(c => c.date >= t).sort((a, b) => a.date.localeCompare(b.date)), days, slots: slotsForDay() });
      }
      if (p === '/admin/api/closures' && req.method === 'POST') {
        const b = await body(req), t = todayKey();
        if (!isDateKey(b.date) || b.date < t || b.date > addDays(t, 120).date) return send(res, 400, { error: 'تاریخ معتبر نیست.' });
        const all = !!b.all, valid = slotsForDay();
        const times = all ? [] : [...new Set((Array.isArray(b.times) ? b.times : []).filter(x => valid.includes(x)))];
        if (!all && !times.length) return send(res, 400, { error: 'کل روز یا حداقل یک ساعت را انتخاب کنید.' });
        const id = hex(5);
        await R('HSET', 'cl', id, JSON.stringify({ id, date: b.date, all, times, createdAt: new Date().toISOString() }));
        const bks = await loadBookings();
        const conflicts = bks.filter(x => x.date === b.date && x.status === 'active' && (all || times.includes(x.time))).map(x => ({ time: x.time, name: x.name, phone: x.phone }));
        return send(res, 200, { ok: true, conflicts });
      }
      const cm = p.match(/^\/admin\/api\/closures\/([a-f0-9]+)$/);
      if (cm && req.method === 'DELETE') { await R('HDEL', 'cl', cm[1]); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'not found' });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (e.message === 'REDIS_NOT_CONFIGURED') return send(res, 500, { error: 'دیتابیس (Upstash Redis) هنوز به پروژه وصل نشده است.' });
    return send(res, 500, { error: 'خطای سرور' });
  }
};
