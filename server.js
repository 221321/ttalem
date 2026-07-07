// ТТ Алем — учёт кухни бортпитания
// Node.js без внешних зависимостей. Запуск: node server.js [порт]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || process.argv[2] || 3050;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');

let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  }, 150);
}
function nid(prefix) { return prefix + (db.seq++).toString(36) + Date.now().toString(36).slice(-4); }

const sessions = {}; // token -> userId

// ---------- себестоимость ----------
function stockOf(pid) {
  if (!db.stock[pid]) db.stock[pid] = { qty: 0, value: 0 };
  return db.stock[pid];
}
function product(pid) { return db.products.find(p => p.id === pid); }
// цена за единицу (кг или шт)
function unitCost(pid) {
  const s = db.stock[pid];
  const p = product(pid);
  if (s && s.qty > 0.0001) return s.value / s.qty;
  if (p && p.lastCost > 0) return p.lastCost;
  if (p && p.priceKg > 0) return p.priceKg;
  // полуфабрикат без истории — берём цену сырья (без учёта потерь, до первой выработки)
  if (p && p.sourceId) return unitCost(p.sourceId);
  return 0;
}
// себестоимость блюда по техкарте (за 1 шт)
function dishCost(dishId) {
  const tc = db.techcards.find(t => t.dishId === dishId && t.active);
  if (!tc) return { total: 0, items: [] };
  let total = 0;
  const items = tc.items.map(it => {
    const p = product(it.productId);
    const uc = unitCost(it.productId);
    // qty: для кг храним граммы, для шт — штуки
    const cost = p && p.unit === 'кг' ? uc * it.qty / 1000 : uc * it.qty;
    total += cost;
    return { productId: it.productId, name: p ? p.name : '?', qty: it.qty, unit: p ? p.unit : '', unitCost: r2(uc), cost: r2(cost) };
  });
  return { total: r2(total), items };
}
function r2(x) { return Math.round(x * 100) / 100; }

// ---------- операции ----------
function opReceipt(o, userId) {
  const s = stockOf(o.productId);
  s.qty = r2(s.qty + o.qty);
  s.value = r2(s.value + o.qty * o.price);
  const p = product(o.productId);
  if (p) { p.lastCost = o.price; if (p.type === 'raw') p.priceKg = o.price; }
  return { type: 'receipt', productId: o.productId, qty: o.qty, price: o.price, sum: r2(o.qty * o.price) };
}
function opProcessing(o, userId) {
  // выработка: сырьё qtyBefore -> полуфабрикат qtyAfter, себестоимость переносится целиком
  const raw = product(o.rawId), semi = product(o.semiId);
  if (!raw || !semi) throw new Error('Продукт не найден');
  const uc = unitCost(o.rawId);
  const moved = r2(uc * o.qtyBefore);
  const sr = stockOf(o.rawId);
  sr.qty = r2(sr.qty - o.qtyBefore);
  sr.value = r2(sr.value - moved);
  if (sr.qty <= 0.0001) { sr.qty = Math.max(sr.qty, 0); sr.value = Math.max(sr.value, 0); }
  const ss = stockOf(o.semiId);
  ss.qty = r2(ss.qty + o.qtyAfter);
  ss.value = r2(ss.value + moved);
  semi.lastCost = o.qtyAfter > 0 ? r2(moved / o.qtyAfter) : semi.lastCost;
  const lossPct = o.qtyBefore > 0 ? r2((1 - o.qtyAfter / o.qtyBefore) * 100) : 0;
  return { type: 'processing', rawId: o.rawId, semiId: o.semiId, qtyBefore: o.qtyBefore, qtyAfter: o.qtyAfter, lossPct, sum: moved };
}
function opProduction(o, userId) {
  // выпуск блюд: списание по техкарте, оприходование готовых
  const tc = db.techcards.find(t => t.dishId === o.dishId && t.active);
  if (!tc) throw new Error('Нет техкарты');
  let total = 0;
  const writeoffs = tc.items.map(it => {
    const p = product(it.productId);
    const uc = unitCost(it.productId);
    const need = p.unit === 'кг' ? it.qty * o.count / 1000 : it.qty * o.count;
    const val = r2(uc * need);
    const s = stockOf(it.productId);
    s.qty = r2(s.qty - need);
    s.value = r2(s.value - val);
    total += val;
    return { productId: it.productId, qty: r2(need), sum: val };
  });
  const sd = stockOf(o.dishId);
  sd.qty = r2(sd.qty + o.count);
  sd.value = r2(sd.value + total);
  const dp = product(o.dishId);
  if (dp) dp.lastCost = o.count > 0 ? r2(total / o.count) : dp.lastCost;
  return { type: 'production', dishId: o.dishId, count: o.count, writeoffs, sum: r2(total) };
}
function opInventory(o, userId) {
  const rows = o.items.map(it => {
    const s = stockOf(it.productId);
    const uc = unitCost(it.productId);
    const diff = r2(it.factQty - s.qty);
    const diffSum = r2(diff * uc);
    s.value = r2(Math.max(0, s.value + diffSum));
    s.qty = it.factQty;
    return { productId: it.productId, factQty: it.factQty, diff, diffSum };
  });
  return { type: 'inventory', items: rows, sum: r2(rows.reduce((a, r) => a + r.diffSum, 0)) };
}
function opShipment(o, userId) {
  // отгрузка готовой продукции (в борт / заказчику)
  const s = stockOf(o.dishId);
  const uc = unitCost(o.dishId);
  const val = r2(uc * o.count);
  s.qty = r2(s.qty - o.count);
  s.value = r2(Math.max(0, s.value - val));
  return { type: 'shipment', dishId: o.dishId, count: o.count, sum: val, note: o.note || '' };
}

const OPS = { receipt: opReceipt, processing: opProcessing, production: opProduction, inventory: opInventory, shipment: opShipment };

// ---------- экспорт в 1С ----------
function export1c(date) {
  // date: YYYY-MM-DD. Агрегируем операции дня в документы для 1С.
  const dayOps = db.operations.filter(op => op.ts.slice(0, 10) === date);
  const docs = [];
  // Комплектации по выработке: группировка сырьё->ПФ
  const procMap = {};
  dayOps.filter(o => o.type === 'processing').forEach(o => {
    const k = o.rawId + '|' + o.semiId;
    if (!procMap[k]) procMap[k] = { rawId: o.rawId, semiId: o.semiId, qtyBefore: 0, qtyAfter: 0, sum: 0 };
    procMap[k].qtyBefore = r2(procMap[k].qtyBefore + o.qtyBefore);
    procMap[k].qtyAfter = r2(procMap[k].qtyAfter + o.qtyAfter);
    procMap[k].sum = r2(procMap[k].sum + o.sum);
  });
  Object.values(procMap).forEach(g => {
    const raw = product(g.rawId), semi = product(g.semiId);
    docs.push({
      ВидДокумента: 'КомплектацияНоменклатуры', Дата: date,
      Комментарий: 'ТТ Алем: выработка ' + raw.name + ' → ' + semi.name,
      Номенклатура: { Наименование: semi.name, Код: semi.code1c || '', Количество: g.qtyAfter, Сумма: g.sum },
      Комплектующие: [{ Наименование: raw.name, Код: raw.code1c || '', Количество: g.qtyBefore, Сумма: g.sum }]
    });
  });
  // Комплектации по выпуску блюд: группировка по блюду
  const prodMap = {};
  dayOps.filter(o => o.type === 'production').forEach(o => {
    if (!prodMap[o.dishId]) prodMap[o.dishId] = { count: 0, sum: 0, wo: {} };
    prodMap[o.dishId].count += o.count;
    prodMap[o.dishId].sum = r2(prodMap[o.dishId].sum + o.sum);
    o.writeoffs.forEach(w => {
      if (!prodMap[o.dishId].wo[w.productId]) prodMap[o.dishId].wo[w.productId] = { qty: 0, sum: 0 };
      prodMap[o.dishId].wo[w.productId].qty = r2(prodMap[o.dishId].wo[w.productId].qty + w.qty);
      prodMap[o.dishId].wo[w.productId].sum = r2(prodMap[o.dishId].wo[w.productId].sum + w.sum);
    });
  });
  Object.entries(prodMap).forEach(([dishId, g]) => {
    const d = product(dishId);
    docs.push({
      ВидДокумента: 'КомплектацияНоменклатуры', Дата: date,
      Комментарий: 'ТТ Алем: выпуск ' + d.name,
      Номенклатура: { Наименование: d.name, Код: d.code1c || '', Количество: g.count, Сумма: g.sum },
      Комплектующие: Object.entries(g.wo).map(([pid, w]) => {
        const p = product(pid);
        return { Наименование: p.name, Код: p.code1c || '', Количество: w.qty, Сумма: w.sum };
      })
    });
  });
  return docs;
}

// ---------- отчёты ----------
function reportCosting() {
  return db.products.filter(p => p.type === 'dish').map(p => {
    const c = dishCost(p.id);
    return { dishId: p.id, name: p.name, total: c.total, items: c.items };
  });
}
function reportLosses(from, to) {
  const ops = db.operations.filter(o => o.type === 'processing' && (!from || o.ts >= from) && (!to || o.ts <= to + 'z'));
  const map = {};
  ops.forEach(o => {
    const k = o.rawId + '|' + o.userId;
    if (!map[k]) map[k] = { rawId: o.rawId, userId: o.userId, n: 0, before: 0, after: 0 };
    map[k].n++; map[k].before = r2(map[k].before + o.qtyBefore); map[k].after = r2(map[k].after + o.qtyAfter);
  });
  return Object.values(map).map(m => {
    const u = db.users.find(u => u.id === m.userId);
    return { product: product(m.rawId).name, user: u ? u.name : '?', operations: m.n,
      totalBefore: m.before, totalAfter: m.after,
      avgLossPct: m.before > 0 ? r2((1 - m.after / m.before) * 100) : 0 };
  });
}

// ---------- http ----------
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function auth(req) {
  const t = req.headers['x-token'];
  return t && sessions[t] ? db.users.find(u => u.id === sessions[t]) : null;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', () => {
    try {
      let data = {};
      if (body) { try { data = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad json' }); } }
      route(req, res, u, data);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
});

function route(req, res, u, data) {
  const p = u.pathname;
  // --- статика ---
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    let f = p === '/' ? '/index.html' : p;
    f = path.join(PUB, path.normalize(f).replace(/^([.][.][\/\\])+/, ''));
    if (!f.startsWith(PUB)) return json(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(f)) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(f)] || 'text/plain') + '; charset=utf-8' });
    return res.end(fs.readFileSync(f));
  }
  // --- вход ---
  if (p === '/api/login' && req.method === 'POST') {
    const user = db.users.find(x => x.id === data.userId && x.pin === String(data.pin));
    if (!user) return json(res, 401, { error: 'Неверный PIN' });
    const token = crypto.randomBytes(16).toString('hex');
    sessions[token] = user.id;
    return json(res, 200, { token, user: { id: user.id, name: user.name, role: user.role } });
  }
  if (p === '/api/users' && req.method === 'GET') {
    return json(res, 200, db.users.map(x => ({ id: x.id, name: x.name, role: x.role })));
  }
  // --- всё остальное требует авторизации ---
  const user = auth(req);
  if (!user) return json(res, 401, { error: 'Нужен вход' });

  if (p === '/api/bootstrap' && req.method === 'GET') {
    const stock = {};
    Object.entries(db.stock).forEach(([pid, s]) => {
      stock[pid] = { qty: s.qty, value: s.value, avg: s.qty > 0.0001 ? r2(s.value / s.qty) : r2(unitCost(pid)) };
    });
    return json(res, 200, { products: db.products, techcards: db.techcards, stock, me: { id: user.id, name: user.name, role: user.role } });
  }
  // --- справочники (технолог/админ) ---
  if (p === '/api/products' && req.method === 'POST') {
    if (user.role === 'cook') return json(res, 403, { error: 'Нет прав' });
    const np = { id: nid('p'), name: data.name, type: data.type, unit: data.unit, priceKg: data.priceKg || 0, sourceId: data.sourceId || null, code1c: data.code1c || '', lastCost: 0 };
    db.products.push(np); save();
    return json(res, 200, np);
  }
  const mProd = p.match(/^\/api\/products\/(.+)$/);
  if (mProd && req.method === 'PUT') {
    if (user.role === 'cook') return json(res, 403, { error: 'Нет прав' });
    const pr = product(mProd[1]);
    if (!pr) return json(res, 404, { error: 'Не найден' });
    ['name', 'unit', 'priceKg', 'sourceId', 'code1c', 'lossMin', 'lossMax'].forEach(k => { if (data[k] !== undefined) pr[k] = data[k]; });
    save();
    return json(res, 200, pr);
  }
  const mTc = p.match(/^\/api\/techcards\/(.+)$/);
  if (mTc && req.method === 'PUT') {
    if (user.role === 'cook') return json(res, 403, { error: 'Нет прав' });
    const tc = db.techcards.find(t => t.id === mTc[1]);
    if (!tc) return json(res, 404, { error: 'Не найдена' });
    if (data.items) tc.items = data.items;
    if (data.active !== undefined) tc.active = data.active;
    save();
    return json(res, 200, tc);
  }
  if (p === '/api/techcards' && req.method === 'POST') {
    if (user.role === 'cook') return json(res, 403, { error: 'Нет прав' });
    const tc = { id: nid('t'), dishId: data.dishId, category: data.category || '', items: data.items || [], active: true };
    db.techcards.push(tc); save();
    return json(res, 200, tc);
  }
  // --- операции ---
  if (p === '/api/ops' && req.method === 'POST') {
    const fn = OPS[data.type];
    if (!fn) return json(res, 400, { error: 'Неизвестная операция' });
    const rec = fn(data, user.id);
    rec.id = nid('o');
    rec.ts = new Date().toISOString();
    rec.userId = user.id;
    db.operations.push(rec); save();
    return json(res, 200, rec);
  }
  if (p === '/api/ops' && req.method === 'GET') {
    let ops = db.operations;
    const date = u.searchParams.get('date');
    const type = u.searchParams.get('type');
    if (date) ops = ops.filter(o => o.ts.slice(0, 10) === date);
    if (type) ops = ops.filter(o => o.type === type);
    return json(res, 200, ops.slice(-500));
  }
  const mDel = p.match(/^\/api\/ops\/(.+)$/);
  if (mDel && req.method === 'DELETE') {
    if (user.role === 'cook') return json(res, 403, { error: 'Нет прав' });
    // сторно: обратная операция по остаткам
    const i = db.operations.findIndex(o => o.id === mDel[1]);
    if (i < 0) return json(res, 404, { error: 'Не найдена' });
    const o = db.operations[i];
    if (o.type === 'receipt') { const s = stockOf(o.productId); s.qty = r2(s.qty - o.qty); s.value = r2(s.value - o.sum); }
    if (o.type === 'processing') {
      const sr = stockOf(o.rawId), ss = stockOf(o.semiId);
      sr.qty = r2(sr.qty + o.qtyBefore); sr.value = r2(sr.value + o.sum);
      ss.qty = r2(ss.qty - o.qtyAfter); ss.value = r2(ss.value - o.sum);
    }
    if (o.type === 'production') {
      o.writeoffs.forEach(w => { const s = stockOf(w.productId); s.qty = r2(s.qty + w.qty); s.value = r2(s.value + w.sum); });
      const sd = stockOf(o.dishId); sd.qty = r2(sd.qty - o.count); sd.value = r2(sd.value - o.sum);
    }
    if (o.type === 'shipment') { const s = stockOf(o.dishId); s.qty = r2(s.qty + o.count); s.value = r2(s.value + o.sum); }
    db.operations.splice(i, 1); save();
    return json(res, 200, { ok: true });
  }
  // --- отчёты ---
  if (p === '/api/report/costing') return json(res, 200, reportCosting());
  if (p === '/api/report/losses') return json(res, 200, reportLosses(u.searchParams.get('from'), u.searchParams.get('to')));
  // --- 1С ---
  if (p === '/api/1c/export') {
    const date = u.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    return json(res, 200, { Дата: date, Документы: export1c(date) });
  }
  json(res, 404, { error: 'not found' });
}

server.listen(PORT, () => console.log('ТТ Алем запущен: http://localhost:' + PORT));
