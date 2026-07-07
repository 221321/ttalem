// ТТ Алем — учёт кухни бортпитания (v2)
// Node.js без внешних зависимостей. Запуск: node server.js [порт]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || process.argv[2] || 3050;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');

let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

// ---------- миграция со старой версии ----------
(function migrate() {
  let changed = false;
  if (!db.settings) {
    db.settings = { skladMain: 'Основной склад', skladKitchen: 'Кухня', skladDone: 'Склад готовой продукции' };
    changed = true;
  }
  db.products.forEach(p => { if (!Array.isArray(p.recipe)) { p.recipe = []; changed = true; } });
  if (Array.isArray(db.techcards) && db.techcards.length) {
    db.techcards.forEach(tc => {
      const dish = db.products.find(p => p.id === tc.dishId);
      if (dish && !dish.recipe.length) {
        dish.recipe = tc.items.map(it => ({ productId: it.productId, qty: it.qty, noteRaw: it.noteRaw || '', noteDone: it.noteDone || '' }));
      }
    });
    delete db.techcards;
    changed = true;
  }
  if (changed) fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
})();

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
function r2(x) { return Math.round(x * 100) / 100; }

const sessions = {};

// ---------- себестоимость (рекурсивно по дереву рецептов) ----------
function stockOf(pid) {
  if (!db.stock[pid]) db.stock[pid] = { qty: 0, value: 0 };
  return db.stock[pid];
}
function product(pid) { return db.products.find(p => p.id === pid); }
function unitCost(pid, seen) {
  seen = seen || {};
  if (seen[pid]) return 0; // защита от циклов
  seen[pid] = true;
  const s = db.stock[pid];
  if (s && s.qty > 0.0001) return s.value / s.qty;
  const p = product(pid);
  if (!p) return 0;
  if (p.lastCost > 0) return p.lastCost;
  if (p.recipe && p.recipe.length) return recipeCost(p, seen).total;
  if (p.priceKg > 0) return p.priceKg;
  if (p.sourceId) return unitCost(p.sourceId, seen);
  return 0;
}
// себестоимость 1 единицы продукта по его рецепту
function recipeCost(p, seen) {
  let total = 0;
  const items = (p.recipe || []).map(it => {
    const c = product(it.productId);
    const uc = unitCost(it.productId, Object.assign({}, seen));
    const cost = c && c.unit === 'кг' ? uc * it.qty / 1000 : uc * it.qty;
    total += cost;
    return { productId: it.productId, name: c ? c.name : '?', qty: it.qty, unit: c ? c.unit : '', unitCost: r2(uc), cost: r2(cost), hasRecipe: !!(c && c.recipe && c.recipe.length) };
  });
  return { total: r2(total), items };
}

// ---------- операции ----------
function opReceipt(o) {
  const s = stockOf(o.productId);
  s.qty = r2(s.qty + o.qty);
  s.value = r2(s.value + o.qty * o.price);
  const p = product(o.productId);
  if (p) { p.lastCost = o.price; if (p.type === 'raw') p.priceKg = o.price; }
  return { type: 'receipt', productId: o.productId, qty: o.qty, price: o.price, sum: r2(o.qty * o.price) };
}
function opProcessing(o) {
  const raw = product(o.rawId), semi = product(o.semiId);
  if (!raw || !semi) throw new Error('Продукт не найден');
  if (!(o.qtyBefore > 0) || !(o.qtyAfter > 0)) throw new Error('Вес должен быть больше нуля');
  if (o.qtyAfter > o.qtyBefore) throw new Error('Вес ПОСЛЕ больше веса ДО');
  const uc = unitCost(o.rawId);
  const moved = r2(uc * o.qtyBefore);
  const sr = stockOf(o.rawId);
  sr.qty = r2(sr.qty - o.qtyBefore);
  sr.value = r2(Math.max(0, sr.value - moved));
  const ss = stockOf(o.semiId);
  ss.qty = r2(ss.qty + o.qtyAfter);
  ss.value = r2(ss.value + moved);
  semi.lastCost = o.qtyAfter > 0 ? r2(moved / o.qtyAfter) : semi.lastCost;
  const lossPct = r2((1 - o.qtyAfter / o.qtyBefore) * 100);
  return { type: 'processing', rawId: o.rawId, semiId: o.semiId, qtyBefore: o.qtyBefore, qtyAfter: o.qtyAfter, lossPct, sum: moved };
}
// выпуск по рецепту — для блюда ИЛИ полуфабриката с рецептом (испекли булочки)
function opProduction(o) {
  const p = product(o.productId);
  if (!p || !p.recipe || !p.recipe.length) throw new Error('У продукта нет рецепта');
  if (!(o.count > 0)) throw new Error('Количество должно быть больше нуля');
  let total = 0;
  const writeoffs = p.recipe.map(it => {
    const c = product(it.productId);
    const uc = unitCost(it.productId);
    const need = c.unit === 'кг' ? it.qty * o.count / 1000 : it.qty * o.count;
    const val = r2(uc * need);
    const s = stockOf(it.productId);
    s.qty = r2(s.qty - need);
    s.value = r2(Math.max(0, s.value - val));
    total += val;
    return { productId: it.productId, qty: r2(need), sum: val };
  });
  const sd = stockOf(o.productId);
  sd.qty = r2(sd.qty + o.count);
  sd.value = r2(sd.value + total);
  p.lastCost = o.count > 0 ? r2(total / o.count) : p.lastCost;
  return { type: 'production', productId: o.productId, count: o.count, writeoffs, sum: r2(total) };
}
function opInventory(o) {
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
const OPS = { receipt: opReceipt, processing: opProcessing, production: opProduction, inventory: opInventory };

// ---------- отчёты ----------
function reportCosting() {
  return db.products.filter(p => p.recipe && p.recipe.length).map(p => {
    const c = recipeCost(p, {});
    return { productId: p.id, name: p.name, type: p.type, unit: p.unit, total: c.total, items: c.items };
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
    return { product: product(m.rawId) ? product(m.rawId).name : '?', user: u ? u.name : '?', operations: m.n,
      totalBefore: m.before, totalAfter: m.after,
      avgLossPct: m.before > 0 ? r2((1 - m.after / m.before) * 100) : 0 };
  });
}
// выработка за период: обработка + выпуск, по продуктам и поварам
function reportOutput(from, to) {
  const inRange = o => (!from || o.ts.slice(0, 10) >= from) && (!to || o.ts.slice(0, 10) <= to);
  const proc = {};
  db.operations.filter(o => o.type === 'processing' && inRange(o)).forEach(o => {
    const k = o.semiId;
    if (!proc[k]) proc[k] = { semiId: o.semiId, rawId: o.rawId, n: 0, before: 0, after: 0, byUser: {} };
    proc[k].n++; proc[k].before = r2(proc[k].before + o.qtyBefore); proc[k].after = r2(proc[k].after + o.qtyAfter);
    const u = db.users.find(u => u.id === o.userId);
    const un = u ? u.name : '?';
    if (!proc[k].byUser[un]) proc[k].byUser[un] = { before: 0, after: 0, n: 0 };
    proc[k].byUser[un].before = r2(proc[k].byUser[un].before + o.qtyBefore);
    proc[k].byUser[un].after = r2(proc[k].byUser[un].after + o.qtyAfter);
    proc[k].byUser[un].n++;
  });
  const prod = {};
  db.operations.filter(o => o.type === 'production' && inRange(o)).forEach(o => {
    const k = o.productId;
    if (!prod[k]) prod[k] = { productId: k, count: 0, sum: 0, byUser: {} };
    prod[k].count = r2(prod[k].count + o.count); prod[k].sum = r2(prod[k].sum + o.sum);
    const u = db.users.find(u => u.id === o.userId);
    const un = u ? u.name : '?';
    prod[k].byUser[un] = r2((prod[k].byUser[un] || 0) + o.count);
  });
  return {
    processing: Object.values(proc).map(m => ({
      raw: product(m.rawId) ? product(m.rawId).name : '?',
      semi: product(m.semiId) ? product(m.semiId).name : '?',
      unit: product(m.rawId) ? product(m.rawId).unit : '',
      operations: m.n, totalBefore: m.before, totalAfter: m.after,
      avgLossPct: m.before > 0 ? r2((1 - m.after / m.before) * 100) : 0,
      byUser: m.byUser
    })),
    production: Object.values(prod).map(m => ({
      name: product(m.productId) ? product(m.productId).name : '?',
      unit: product(m.productId) ? product(m.productId).unit : '',
      count: m.count, sum: m.sum, byUser: m.byUser
    }))
  };
}

// ---------- экспорт в 1С (со складами и хронологией) ----------
function export1c(date) {
  const S = db.settings;
  const dayOps = db.operations.filter(op => op.ts.slice(0, 10) === date);
  const docs = [];
  let minute = 0;
  const t = () => { minute += 5; const h = 8 + Math.floor(minute / 60), m = minute % 60; return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2) + ':00'; };

  // 1. Перемещение: всё сырьё, потреблённое за день, Основной склад -> Кухня
  const moved = {};
  dayOps.filter(o => o.type === 'processing').forEach(o => {
    if (!moved[o.rawId]) moved[o.rawId] = { qty: 0, sum: 0 };
    moved[o.rawId].qty = r2(moved[o.rawId].qty + o.qtyBefore);
    moved[o.rawId].sum = r2(moved[o.rawId].sum + o.sum);
  });
  dayOps.filter(o => o.type === 'production').forEach(o => {
    o.writeoffs.forEach(w => {
      const p = product(w.productId);
      if (p && p.type === 'raw') {
        if (!moved[w.productId]) moved[w.productId] = { qty: 0, sum: 0 };
        moved[w.productId].qty = r2(moved[w.productId].qty + w.qty);
        moved[w.productId].sum = r2(moved[w.productId].sum + w.sum);
      }
    });
  });
  const movedRows = Object.entries(moved).map(([pid, m]) => {
    const p = product(pid);
    return { Наименование: p.name, Код: p.code1c || '', Количество: m.qty, Сумма: m.sum };
  });
  if (movedRows.length) {
    docs.push({
      ВидДокумента: 'ПеремещениеТМЗ', Дата: date, Время: t(),
      СкладОтправитель: S.skladMain, СкладПолучатель: S.skladKitchen,
      Комментарий: 'ТТ Алем: продукты в работу за ' + date,
      Товары: movedRows
    });
  }

  // 2. Комплектации по выработке (внутри Кухни)
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
      ВидДокумента: 'КомплектацияНоменклатуры', Дата: date, Время: t(), Склад: S.skladKitchen,
      Комментарий: 'ТТ Алем: выработка ' + raw.name + ' → ' + semi.name,
      Номенклатура: { Наименование: semi.name, Код: semi.code1c || '', Количество: g.qtyAfter, Сумма: g.sum },
      Комплектующие: [{ Наименование: raw.name, Код: raw.code1c || '', Количество: g.qtyBefore, Сумма: g.sum }]
    });
  });

  // 3. Комплектации по выпуску: списание с Кухни, готовое на Склад ГП
  const prodMap = {};
  dayOps.filter(o => o.type === 'production').forEach(o => {
    if (!prodMap[o.productId]) prodMap[o.productId] = { count: 0, sum: 0, wo: {} };
    prodMap[o.productId].count = r2(prodMap[o.productId].count + o.count);
    prodMap[o.productId].sum = r2(prodMap[o.productId].sum + o.sum);
    o.writeoffs.forEach(w => {
      if (!prodMap[o.productId].wo[w.productId]) prodMap[o.productId].wo[w.productId] = { qty: 0, sum: 0 };
      prodMap[o.productId].wo[w.productId].qty = r2(prodMap[o.productId].wo[w.productId].qty + w.qty);
      prodMap[o.productId].wo[w.productId].sum = r2(prodMap[o.productId].wo[w.productId].sum + w.sum);
    });
  });
  Object.entries(prodMap).forEach(([pid, g]) => {
    const d = product(pid);
    docs.push({
      ВидДокумента: 'КомплектацияНоменклатуры', Дата: date, Время: t(),
      Склад: S.skladKitchen, СкладГотовойПродукции: d.type === 'dish' ? S.skladDone : S.skladKitchen,
      Комментарий: 'ТТ Алем: выпуск ' + d.name,
      Номенклатура: { Наименование: d.name, Код: d.code1c || '', Количество: g.count, Сумма: g.sum },
      Комплектующие: Object.entries(g.wo).map(([cid, w]) => {
        const p = product(cid);
        return { Наименование: p.name, Код: p.code1c || '', Количество: w.qty, Сумма: w.sum };
      })
    });
  });
  return docs;
}

// ---------- http ----------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function auth(req) {
  const t = req.headers['x-token'];
  return t && sessions[t] ? db.users.find(u => u.id === sessions[t]) : null;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', () => {
    try {
      let data = {};
      if (body) { try { data = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad json' }); } }
      route(req, res, u, data);
    } catch (e) { json(res, 500, { error: e.message }); }
  });
});

function route(req, res, u, data) {
  const p = u.pathname;
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    let f = p === '/' ? '/index.html' : p;
    f = path.join(PUB, path.normalize(f).replace(/^([.][.][\/\\])+/, ''));
    if (!f.startsWith(PUB)) return json(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(f)) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(f)] || 'text/plain') + '; charset=utf-8' });
    return res.end(fs.readFileSync(f));
  }
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
  const user = auth(req);
  if (!user) return json(res, 401, { error: 'Нужен вход' });
  const canEdit = user.role !== 'cook';

  if (p === '/api/bootstrap' && req.method === 'GET') {
    const stock = {};
    Object.entries(db.stock).forEach(([pid, s]) => {
      stock[pid] = { qty: s.qty, value: s.value, avg: s.qty > 0.0001 ? r2(s.value / s.qty) : r2(unitCost(pid)) };
    });
    return json(res, 200, { products: db.products, stock, settings: db.settings, me: { id: user.id, name: user.name, role: user.role } });
  }
  if (p === '/api/settings' && req.method === 'PUT') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Только директор' });
    ['skladMain', 'skladKitchen', 'skladDone'].forEach(k => { if (data[k]) db.settings[k] = data[k]; });
    save();
    return json(res, 200, db.settings);
  }
  if (p === '/api/products' && req.method === 'POST') {
    if (!canEdit) return json(res, 403, { error: 'Нет прав' });
    const np = { id: nid('p'), name: (data.name || '').trim(), type: data.type || 'raw', unit: data.unit || 'кг',
      priceKg: 0, sourceId: data.sourceId || null, code1c: data.code1c || '', recipe: data.recipe || [], lastCost: 0 };
    if (!np.name) return json(res, 400, { error: 'Введите наименование' });
    if (np.recipe.length && np.type === 'raw') np.type = 'semi';
    db.products.push(np); save();
    return json(res, 200, np);
  }
  const mProd = p.match(/^\/api\/products\/([^/]+)$/);
  if (mProd && req.method === 'PUT') {
    if (!canEdit) return json(res, 403, { error: 'Нет прав' });
    const pr = product(mProd[1]);
    if (!pr) return json(res, 404, { error: 'Не найден' });
    ['name', 'type', 'unit', 'sourceId', 'code1c'].forEach(k => { if (data[k] !== undefined) pr[k] = data[k]; });
    if (data.recipe !== undefined) {
      pr.recipe = (data.recipe || []).filter(it => it.productId !== pr.id);
      // автопереезд между вкладками: появился рецепт у продукта -> полуфабрикат, пропал -> продукт
      if (pr.recipe.length && pr.type === 'raw') pr.type = 'semi';
      if (!pr.recipe.length && pr.type === 'semi' && !pr.sourceId) pr.type = 'raw';
    }
    save();
    return json(res, 200, pr);
  }
  if (p === '/api/ops' && req.method === 'POST') {
    if (data.type === 'receipt' && !canEdit) return json(res, 403, { error: 'Приход вносит директор или технолог' });
    const fn = OPS[data.type];
    if (!fn) return json(res, 400, { error: 'Неизвестная операция' });
    const rec = fn(data);
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
    const mine = u.searchParams.get('mine');
    if (date) ops = ops.filter(o => o.ts.slice(0, 10) === date);
    if (type) ops = ops.filter(o => o.type === type);
    if (mine) ops = ops.filter(o => o.userId === user.id);
    return json(res, 200, ops.slice(-500));
  }
  const mDel = p.match(/^\/api\/ops\/([^/]+)$/);
  if (mDel && req.method === 'DELETE') {
    if (!canEdit) return json(res, 403, { error: 'Нет прав' });
    const i = db.operations.findIndex(o => o.id === mDel[1]);
    if (i < 0) return json(res, 404, { error: 'Не найдена' });
    const o = db.operations[i];
    if (o.type === 'receipt') { const s = stockOf(o.productId); s.qty = r2(s.qty - o.qty); s.value = r2(s.value - o.sum); }
    if (o.type === 'processing') {
      const sr = stockOf(o.rawId), ss = stockOf(o.semiId);
      sr.qty = r2(sr.qty + o.qtyBefore); sr.value = r2(sr.value + o.sum);
      ss.qty = r2(ss.qty - o.qtyAfter); ss.value = r2(Math.max(0, ss.value - o.sum));
    }
    if (o.type === 'production') {
      o.writeoffs.forEach(w => { const s = stockOf(w.productId); s.qty = r2(s.qty + w.qty); s.value = r2(s.value + w.sum); });
      const sd = stockOf(o.productId); sd.qty = r2(sd.qty - o.count); sd.value = r2(Math.max(0, sd.value - o.sum));
    }
    db.operations.splice(i, 1); save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/report/costing') return json(res, 200, reportCosting());
  if (p === '/api/report/losses') return json(res, 200, reportLosses(u.searchParams.get('from'), u.searchParams.get('to')));
  if (p === '/api/report/output') return json(res, 200, reportOutput(u.searchParams.get('from'), u.searchParams.get('to')));
  if (p === '/api/1c/export') {
    const date = u.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    return json(res, 200, { Дата: date, Склады: db.settings, Документы: export1c(date) });
  }
  json(res, 404, { error: 'not found' });
}

server.listen(PORT, () => console.log('ТТ Алем v2 запущен: http://localhost:' + PORT));
