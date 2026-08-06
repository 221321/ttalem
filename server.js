// SKY MEAL v5 — многоскладовой учёт кухни бортпитания
// Node.js без внешних зависимостей. Запуск: node server.js [порт]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || process.argv[2] || 3050;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');

let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

// Типы продуктов
const VALID_TYPES = ['raw', 'process', 'semi', 'bread', 'dish'];
// Единицы
const VALID_UNITS = ['кг', 'шт', 'л', 'мл', 'г'];

// Подроли поваров
const COOK_ROLES = {
  cook:        { name: 'Повар',            skladIds: [] }, // все склады кухни
  cook_prep:   { name: 'Повар заготовок',  skladIds: [] },
  cook_sand:   { name: 'Повар сэндвичей',  skladIds: [] },
  cook_hot:    { name: 'Повар горячего',   skladIds: [] },
  cook_baker:  { name: 'Пекарь',           skladIds: [] },
  cook_pastry: { name: 'Кондитер',         skladIds: [] },
  cook_head:   { name: 'Главный повар',    skladIds: [] }, // все склады
};
const isCook = role => role === 'cook' || role.startsWith('cook_');

// ---------- миграция ----------
(function migrate() {
  let changed = false;

  // настройки
  if (!db.settings) {
    db.settings = { diffThresholdPct: 5 };
    changed = true;
  }
  if (db.settings.skladMain || db.settings.skladKitchen) {
    // перенос старых строковых складов в справочник
    if (!db.sklads) db.sklads = [];
    changed = true;
    delete db.settings.skladMain;
    delete db.settings.skladKitchen;
    delete db.settings.skladDone;
  }

  // справочник складов
  if (!Array.isArray(db.sklads) || !db.sklads.length) {
    db.sklads = [
      { id: 'sk1', name: 'Основной склад',     is1cMain: true,  cookRoles: [] },
      { id: 'sk2', name: 'Кухня / Заготовки',  is1cMain: false, cookRoles: ['cook','cook_prep','cook_head'] },
      { id: 'sk3', name: 'Сэндвичи',           is1cMain: false, cookRoles: ['cook','cook_sand','cook_head'] },
      { id: 'sk4', name: 'Горячее',            is1cMain: false, cookRoles: ['cook','cook_hot','cook_head'] },
      { id: 'sk5', name: 'Хлеб и тесто',       is1cMain: false, cookRoles: ['cook','cook_baker','cook_head'] },
      { id: 'sk6', name: 'Кондитерка',         is1cMain: false, cookRoles: ['cook','cook_pastry','cook_head'] },
      { id: 'sk7', name: 'Готовая продукция',  is1cMain: false, cookRoles: [] },
    ];
    changed = true;
  }

  // продукты
  db.products.forEach(p => {
    if (!Array.isArray(p.recipe)) { p.recipe = []; changed = true; }
    if (!Array.isArray(p.recipeLog)) { p.recipeLog = []; changed = true; }
    if (p.recipe.length && !p.recipeStatus) { p.recipeStatus = 'draft'; changed = true; }
    // старые полуфабрикаты с sourceId → process
    if (p.type === 'semi' && p.sourceId) { p.type = 'process'; changed = true; }
    // склад по умолчанию
    if (!p.skladId) {
      if (p.type === 'dish') p.skladId = 'sk7';
      else if (p.type === 'bread') p.skladId = 'sk5';
      else p.skladId = 'sk2';
      changed = true;
    }
    // единицы
    if (!VALID_UNITS.includes(p.unit)) { p.unit = 'кг'; changed = true; }
  });

  if (Array.isArray(db.techcards) && db.techcards.length) {
    db.techcards.forEach(tc => {
      const dish = db.products.find(p => p.id === tc.dishId);
      if (dish && !dish.recipe.length) {
        dish.recipe = tc.items.map(it => ({ productId: it.productId, qty: it.qty, noteRaw: it.noteRaw || '', noteDone: it.noteDone || '' }));
        dish.recipeStatus = 'draft';
      }
    });
    delete db.techcards;
    changed = true;
  }

  // stock: переводим в многоскладовой формат {складId: {qty, value}}
  if (db.stock && Object.keys(db.stock).length) {
    const first = Object.values(db.stock)[0];
    if (first && typeof first.qty === 'number') {
      // плоский формат → многоскладовой
      const newStock = {};
      Object.entries(db.stock).forEach(([pid, s]) => {
        const p = db.products.find(x => x.id === pid);
        const skId = p ? p.skladId : 'sk2';
        newStock[pid] = { [skId]: { qty: s.qty, value: s.value } };
      });
      db.stock = newStock;
      changed = true;
    }
  }
  if (!db.stock) { db.stock = {}; changed = true; }

  // история инвентаризаций
  if (!Array.isArray(db.invHistory)) { db.invHistory = []; changed = true; }

  // уведомления
  if (!Array.isArray(db.alerts)) { db.alerts = []; changed = true; }
  if (!Array.isArray(db.orders)) { db.orders = []; changed = true; }

  // Чиним sourceId: продукт не может быть выработкой из самого себя
  db.products.forEach(p => {
    if (p.sourceId === p.id) { p.sourceId = null; changed = true; }
  });
  // Восстанавливаем sourceId у process-продуктов если потерялся
  db.products.forEach(p => {
    if (p.type === 'process' && !p.sourceId) {
      const match = db.products.find(r => r.id !== p.id && r.type === 'raw' && r.name.toLowerCase() !== p.name.toLowerCase() && p.name.toLowerCase().includes(r.name.toLowerCase()));
      if (match) { p.sourceId = match.id; changed = true; }
    }
  });
  // Убираем semi без рецепта и sourceId — они должны быть raw
  db.products.forEach(p => {
    if (typeof p.salePrice !== 'number') { p.salePrice = 0; changed = true; }
  });
  db.products.forEach(p => {
    if (p.type === 'semi' && !p.sourceId && (!p.recipe || !p.recipe.length)) {
      p.type = 'raw'; changed = true;
    }
  });
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
function today() { return new Date().toISOString().slice(0,10); }
const sessions = {};
const loginAttempts = {}; // ip -> { count, until }

// ---------- склады ----------
function sklad(id) { return db.sklads.find(s => s.id === id); }
// склады, доступные роли повара
function cookSklads(role) {
  if (role === 'admin' || role === 'tech') return db.sklads;
  if (role === 'cook_head' || role === 'cook') return db.sklads.filter(s => !s.is1cMain);
  return db.sklads.filter(s => s.cookRoles && s.cookRoles.includes(role));
}
// продукты, доступные роли повара (через склад продукта)
function cookProducts(role) {
  const skIds = cookSklads(role).map(s => s.id);
  return db.products.filter(p => skIds.includes(p.skladId));
}

// ---------- себестоимость ----------
function stockOf(pid, skId) {
  if (!db.stock[pid]) db.stock[pid] = {};
  if (!db.stock[pid][skId]) db.stock[pid][skId] = { qty: 0, value: 0 };
  return db.stock[pid][skId];
}
// общий остаток по продукту (все склады)
function totalStock(pid) {
  if (!db.stock[pid]) return { qty: 0, value: 0 };
  let qty = 0, value = 0;
  Object.values(db.stock[pid]).forEach(s => { qty = r2(qty + s.qty); value = r2(value + s.value); });
  return { qty, value };
}
function product(pid) { return db.products.find(p => p.id === pid); }
function unitCost(pid, seen) {
  seen = seen || {};
  if (seen[pid]) return 0;
  seen[pid] = true;
  const ts = totalStock(pid);
  if (ts.qty > 0.0001) return ts.value / ts.qty;
  const p = product(pid);
  if (!p) return 0;
  if (p.lastCost > 0) return p.lastCost;
  if (p.recipe && p.recipe.length) return recipeCost(p, seen).total;
  if (p.priceKg > 0) return p.priceKg;
  if (p.sourceId) return unitCost(p.sourceId, seen);
  return 0;
}
function recipeCost(p, seen) {
  let total = 0;
  const items = (p.recipe || []).map(it => {
    const c = product(it.productId);
    const uc = unitCost(it.productId, Object.assign({}, seen));
    // г→кг, мл→л, остальное (в т.ч. 'г' и 'мл' единицы хранения) как есть
    const factor = (c && (c.unit === 'кг' || c.unit === 'л')) ? it.qty / 1000 : it.qty;
    const cost = r2(uc * factor);
    total += cost;
    return { productId: it.productId, name: c ? c.name : '?', qty: it.qty, unit: c ? c.unit : '', unitCost: r2(uc), cost, hasRecipe: !!(c && c.recipe && c.recipe.length) };
  });
  return { total: r2(total), items };
}

// ---------- журнал рецептур ----------
function logRecipe(p, user, text) {
  p.recipeLog.push({ ts: new Date().toISOString(), user: user.name, text });
  if (p.recipeLog.length > 300) p.recipeLog = p.recipeLog.slice(-300);
}
function diffRecipe(p, user, newName, newRecipe) {
  const msgs = [];
  if (newName !== undefined && newName !== p.name) msgs.push('переименовал: «' + p.name + '» → «' + newName + '»');
  if (newRecipe !== undefined) {
    const oldMap = {}; (p.recipe || []).forEach(it => oldMap[it.productId] = it.qty);
    const newMap = {}; newRecipe.forEach(it => newMap[it.productId] = it.qty);
    Object.keys(newMap).forEach(pid => {
      const c = product(pid), nm = c ? c.name : pid;
      if (!(pid in oldMap)) msgs.push('добавил: ' + nm + ' ' + newMap[pid]);
      else if (oldMap[pid] !== newMap[pid]) msgs.push('изменил: ' + nm + ' ' + oldMap[pid] + ' → ' + newMap[pid]);
    });
    Object.keys(oldMap).forEach(pid => {
      if (!(pid in newMap)) { const c = product(pid); msgs.push('удалил: ' + (c ? c.name : pid)); }
    });
  }
  msgs.forEach(m => logRecipe(p, user, m));
}

// ---------- уведомления ----------
function addAlert(msg, level) {
  db.alerts.unshift({ id: nid('a'), ts: new Date().toISOString(), msg, level: level || 'warn', read: false });
  if (db.alerts.length > 100) db.alerts = db.alerts.slice(0, 100);
}
function checkDiff(pid, factQty, accountQty) {
  if (accountQty <= 0.0001) return;
  const diffPct = Math.abs(factQty - accountQty) / accountQty * 100;
  const threshold = (db.settings.diffThresholdPct || 5);
  if (diffPct > threshold) {
    const p = product(pid);
    addAlert('Расхождение остатков: «' + (p ? p.name : pid) + '» — учёт ' + r2(accountQty) + ', факт ' + r2(factQty) + ' (' + r2(diffPct) + '%)', 'warn');
  }
}

// ---------- операции ----------
function opReceipt(o) {
  const p = product(o.productId);
  if (!p) throw new Error('Продукт не найден');
  const skId = o.skladId || p.skladId || 'sk1';
  const s = stockOf(o.productId, skId);
  s.qty = r2(s.qty + o.qty);
  s.value = r2(s.value + o.qty * o.price);
  p.lastCost = o.price;
  if (p.type === 'raw') p.priceKg = o.price;
  return { type: 'receipt', productId: o.productId, skladId: skId, qty: o.qty, price: o.price, sum: r2(o.qty * o.price) };
}
function opProcessing(o) {
  const raw = product(o.rawId), semi = product(o.semiId);
  if (!raw || !semi) throw new Error('Продукт не найден');
  if (!(o.qtyBefore > 0) || !(o.qtyAfter > 0)) throw new Error('Вес должен быть больше нуля');
  if (o.qtyAfter > o.qtyBefore) throw new Error('Вес ПОСЛЕ больше веса ДО');
  const rawSkId = raw.skladId || 'sk2';
  const semiSkId = semi.skladId || 'sk2';
  const uc = unitCost(o.rawId);
  const moved = r2(uc * o.qtyBefore);
  const sr = stockOf(o.rawId, rawSkId);
  sr.qty = r2(sr.qty - o.qtyBefore);
  sr.value = r2(Math.max(0, sr.value - moved));
  const ss = stockOf(o.semiId, semiSkId);
  ss.qty = r2(ss.qty + o.qtyAfter);
  ss.value = r2(ss.value + moved);
  semi.lastCost = o.qtyAfter > 0 ? r2(moved / o.qtyAfter) : semi.lastCost;
  const lossPct = r2((1 - o.qtyAfter / o.qtyBefore) * 100);
  return { type: 'processing', rawId: o.rawId, semiId: o.semiId, rawSkId, semiSkId, qtyBefore: o.qtyBefore, qtyAfter: o.qtyAfter, lossPct, sum: moved };
}
function opProduction(o) {
  const p = product(o.productId);
  if (!p || !p.recipe || !p.recipe.length) throw new Error('У продукта нет рецептуры');
  if (p.recipeStatus !== 'approved') throw new Error('Рецептура «' + p.name + '» не утверждена');
  if (!(o.count > 0)) throw new Error('Количество должно быть больше нуля');
  let total = 0;
  const writeoffs = p.recipe.map(it => {
    const c = product(it.productId);
    const uc = unitCost(it.productId);
    const factor = (c && (c.unit === 'кг' || c.unit === 'л')) ? it.qty * o.count / 1000 : it.qty * o.count;
    const val = r2(uc * factor);
    const skId = c ? (c.skladId || 'sk2') : 'sk2';
    const s = stockOf(it.productId, skId);
    s.qty = r2(s.qty - factor);
    s.value = r2(Math.max(0, s.value - val));
    total += val;
    return { productId: it.productId, skladId: skId, qty: r2(factor), sum: val };
  });
  const outSkId = p.skladId || 'sk7';
  const sd = stockOf(o.productId, outSkId);
  sd.qty = r2(sd.qty + o.count);
  sd.value = r2(sd.value + total);
  p.lastCost = o.count > 0 ? r2(total / o.count) : p.lastCost;
  return { type: 'production', productId: o.productId, skladId: outSkId, count: o.count, writeoffs, sum: r2(total) };
}
function opInventory(o, user) {
  const rows = [];
  const diffs = [];
  o.items.forEach(it => {
    const s = stockOf(it.productId, it.skladId || product(it.productId)?.skladId || 'sk2');
    const accountQty = s.qty;
    const uc = unitCost(it.productId);
    const diff = r2(it.factQty - s.qty);
    const diffSum = r2(diff * uc);
    checkDiff(it.productId, it.factQty, accountQty);
    s.value = r2(Math.max(0, s.value + diffSum));
    s.qty = it.factQty;
    rows.push({ productId: it.productId, skladId: it.skladId, accountQty, factQty: it.factQty, diff, diffSum });
    if (Math.abs(diff) > 0.001) diffs.push({ productId: it.productId, diff, diffSum });
  });
  const total = r2(rows.reduce((a, r) => a + r.diffSum, 0));
  // сохраняем в историю
  db.invHistory.unshift({ id: nid('iv'), ts: new Date().toISOString(), user: user.name, rows, total });
  if (db.invHistory.length > 50) db.invHistory = db.invHistory.slice(0, 50);
  return { type: 'inventory', items: rows, sum: total };
}
function opMove(o) {
  // перемещение между складами
  const p = product(o.productId);
  if (!p) throw new Error('Продукт не найден');
  if (!(o.qty > 0)) throw new Error('Количество должно быть больше нуля');
  if (o.fromSkId === o.toSkId) throw new Error('Склад-источник и склад-получатель совпадают');
  const uc = unitCost(o.productId);
  const val = r2(uc * o.qty);
  const from = stockOf(o.productId, o.fromSkId);
  from.qty = r2(from.qty - o.qty);
  from.value = r2(Math.max(0, from.value - val));
  const to = stockOf(o.productId, o.toSkId);
  to.qty = r2(to.qty + o.qty);
  to.value = r2(to.value + val);
  return { type: 'move', productId: o.productId, fromSkId: o.fromSkId, toSkId: o.toSkId, qty: o.qty, sum: val };
}
function opWriteoff(o) {
  const rows = o.items.map(it => {
    const p = product(it.productId);
    if (!p) throw new Error('Продукт не найден: ' + it.productId);
    const skId = it.skladId || p.skladId || 'sk2';
    const uc = unitCost(it.productId);
    const val = r2(uc * it.qty);
    const s = stockOf(it.productId, skId);
    s.qty = r2(s.qty - it.qty);
    s.value = r2(Math.max(0, s.value - val));
    return { productId: it.productId, skladId: skId, qty: it.qty, sum: val };
  });
  return { type: 'writeoff', reason: o.reason || 'списание', items: rows, sum: r2(rows.reduce((a, r) => a + r.sum, 0)) };
}
const OPS = { receipt: opReceipt, processing: opProcessing, production: opProduction, inventory: opInventory, move: opMove, writeoff: opWriteoff };

// ---------- отчёты ----------
function reportCosting() {
  return db.products.filter(p => p.recipe && p.recipe.length).map(p => {
    const c = recipeCost(p, {});
    return { productId: p.id, name: p.name, type: p.type, unit: p.unit, status: p.recipeStatus || 'draft', total: c.total, items: c.items, salePrice: p.salePrice || 0 };
  });
}
function reportOutput(from, to, hideMoney) {
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
      raw: product(m.rawId) ? product(m.rawId).name : '?', semi: product(m.semiId) ? product(m.semiId).name : '?',
      unit: product(m.rawId) ? product(m.rawId).unit : '', operations: m.n, totalBefore: m.before, totalAfter: m.after,
      avgLossPct: m.before > 0 ? r2((1 - m.after / m.before) * 100) : 0, byUser: m.byUser
    })),
    production: Object.values(prod).map(m => {
      const row = { name: product(m.productId) ? product(m.productId).name : '?', unit: product(m.productId) ? product(m.productId).unit : '', count: m.count, byUser: m.byUser };
      if (!hideMoney) row.sum = m.sum;
      return row;
    })
  };
}
// остатки в разрезе продукт × склад
function reportStock(role) {
  const skIds = cookSklads(role).map(s => s.id);
  const showMoney = role === 'admin' || role === 'tech';
  const rows = [];
  db.products.forEach(p => {
    if (!skIds.includes(p.skladId) && role !== 'admin' && role !== 'tech') return;
    const bySkl = {};
    let total = 0;
    db.sklads.forEach(sk => {
      const s = db.stock[p.id] && db.stock[p.id][sk.id];
      const qty = s ? s.qty : 0;
      const val = s ? s.value : 0;
      if (qty !== 0) { bySkl[sk.id] = showMoney ? { qty, value: val } : { qty }; total = r2(total + qty); }
    });
    if (total !== 0 || Object.keys(bySkl).length) {
      rows.push({ productId: p.id, name: p.name, type: p.type, unit: p.unit, skladId: p.skladId, total, bySkl });
    }
  });
  return rows;
}

function reportPlan() {
  const t = today();
  const active = db.orders.filter(o => o.dateFrom <= t && o.dateTo >= t);
  const byProduct = {};
  active.forEach(o => {
    if (!byProduct[o.productId]) byProduct[o.productId] = { productId: o.productId, planQty: 0, dateFrom: o.dateFrom, dateTo: o.dateTo };
    byProduct[o.productId].planQty = r2(byProduct[o.productId].planQty + o.qty);
    if (o.dateFrom < byProduct[o.productId].dateFrom) byProduct[o.productId].dateFrom = o.dateFrom;
    if (o.dateTo > byProduct[o.productId].dateTo) byProduct[o.productId].dateTo = o.dateTo;
  });
  return Object.values(byProduct).map(g => {
    const factOps = db.operations.filter(op => op.type === 'production' && op.productId === g.productId && op.ts.slice(0,10) >= g.dateFrom && op.ts.slice(0,10) <= g.dateTo);
    const factQty = r2(factOps.reduce((a, o) => a + o.count, 0));
    const p = product(g.productId);
    return { productId: g.productId, name: p ? p.name : '?', unit: p ? p.unit : '', planQty: g.planQty, factQty, dateFrom: g.dateFrom, dateTo: g.dateTo };
  });
}

// ---------- 1С экспорт: документы за дату (date === 'all' — за всё время) ----------
function export1c(date) {
  if (date === 'all') {
    const dates = Array.from(new Set(db.operations.map(o => o.ts.slice(0, 10)))).sort();
    let all = [];
    dates.forEach(d => { all = all.concat(export1c(d)); });
    return all;
  }
  const dayOps = db.operations.filter(op => op.ts.slice(0, 10) === date);
  const docs = [];
  let minute = 0;
  const t = () => { minute += 5; const h = 8 + Math.floor(minute / 60), m = minute % 60; return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2) + ':00'; };

  // перемещения (receipt: основной → склад продукта)
  const moved = {};
  dayOps.filter(o => o.type === 'receipt').forEach(o => {
    const key = (o.skladId || 'sk1');
    if (!moved[key]) moved[key] = {};
    if (!moved[key][o.productId]) moved[key][o.productId] = { qty: 0, sum: 0 };
    moved[key][o.productId].qty = r2(moved[key][o.productId].qty + o.qty);
    moved[key][o.productId].sum = r2(moved[key][o.productId].sum + o.sum);
  });

  // перемещение между складами (move ops)
  const moveOps = {};
  dayOps.filter(o => o.type === 'move').forEach(o => {
    const key = o.fromSkId + '→' + o.toSkId;
    if (!moveOps[key]) moveOps[key] = { fromSkId: o.fromSkId, toSkId: o.toSkId, items: {} };
    if (!moveOps[key].items[o.productId]) moveOps[key].items[o.productId] = { qty: 0, sum: 0 };
    moveOps[key].items[o.productId].qty = r2(moveOps[key].items[o.productId].qty + o.qty);
    moveOps[key].items[o.productId].sum = r2(moveOps[key].items[o.productId].sum + o.sum);
  });
  Object.values(moveOps).forEach(g => {
    const from = sklad(g.fromSkId), to = sklad(g.toSkId);
    docs.push({
      ВидДокумента: 'ПеремещениеТМЗ', Дата: date, Время: t(),
      СкладОтправитель: from ? from.name : g.fromSkId,
      СкладПолучатель: to ? to.name : g.toSkId,
      Комментарий: 'SKY MEAL: перемещение ' + (from ? from.name : '') + ' → ' + (to ? to.name : ''),
      Товары: Object.entries(g.items).map(([pid, v]) => { const p = product(pid); return { Наименование: p.name, Код: p.code1c || '', Количество: v.qty, Сумма: v.sum }; })
    });
  });

  // комплектации выработки
  const procMap = {};
  dayOps.filter(o => o.type === 'processing').forEach(o => {
    const k = o.rawId + '|' + o.semiId;
    if (!procMap[k]) procMap[k] = { rawId: o.rawId, semiId: o.semiId, rawSkId: o.rawSkId, semiSkId: o.semiSkId, qtyBefore: 0, qtyAfter: 0, sum: 0 };
    procMap[k].qtyBefore = r2(procMap[k].qtyBefore + o.qtyBefore);
    procMap[k].qtyAfter = r2(procMap[k].qtyAfter + o.qtyAfter);
    procMap[k].sum = r2(procMap[k].sum + o.sum);
  });
  Object.values(procMap).forEach(g => {
    const raw = product(g.rawId), semi = product(g.semiId);
    const sk = sklad(g.semiSkId);
    docs.push({
      ВидДокумента: 'КомплектацияНоменклатуры', Дата: date, Время: t(), Склад: sk ? sk.name : g.semiSkId,
      Комментарий: 'SKY MEAL: выработка ' + raw.name + ' → ' + semi.name,
      SkyMealТип: 'processing',
      Номенклатура: { Наименование: semi.name, Код: semi.code1c || '', Количество: g.qtyAfter, Сумма: g.sum },
      Комплектующие: [{ Наименование: raw.name, Код: raw.code1c || '', Количество: g.qtyBefore, Сумма: g.sum }]
    });
  });

  // комплектации выпуска
  const prodMap = {};
  dayOps.filter(o => o.type === 'production').forEach(o => {
    if (!prodMap[o.productId]) prodMap[o.productId] = { count: 0, sum: 0, skladId: o.skladId, wo: {} };
    prodMap[o.productId].count = r2(prodMap[o.productId].count + o.count);
    prodMap[o.productId].sum = r2(prodMap[o.productId].sum + o.sum);
    o.writeoffs.forEach(w => {
      if (!prodMap[o.productId].wo[w.productId]) prodMap[o.productId].wo[w.productId] = { qty: 0, sum: 0, skladId: w.skladId };
      prodMap[o.productId].wo[w.productId].qty = r2(prodMap[o.productId].wo[w.productId].qty + w.qty);
      prodMap[o.productId].wo[w.productId].sum = r2(prodMap[o.productId].wo[w.productId].sum + w.sum);
    });
  });
  Object.entries(prodMap).forEach(([pid, g]) => {
    const d = product(pid);
    const sk = sklad(g.skladId);
    docs.push({
      ВидДокумента: 'КомплектацияНоменклатуры', Дата: date, Время: t(),
      Склад: sk ? sk.name : g.skladId,
      Комментарий: 'SKY MEAL: выпуск ' + d.name,
      SkyMealТип: 'production',
      Номенклатура: { Наименование: d.name, Код: d.code1c || '', Количество: g.count, Сумма: g.sum },
      Комплектующие: Object.entries(g.wo).map(([cid, w]) => { const p = product(cid); const ws = sklad(w.skladId); return { Наименование: p.name, Код: p.code1c || '', Количество: w.qty, Сумма: w.sum, Склад: ws ? ws.name : w.skladId }; })
    });
  });

  // акты списания
  dayOps.filter(o => o.type === 'writeoff').forEach(o => {
    docs.push({
      ВидДокумента: 'СписаниеТМЗ', Дата: date, Время: t(),
      Комментарий: 'SKY MEAL: ' + o.reason,
      Товары: o.items.map(it => { const p = product(it.productId); const sk = sklad(it.skladId); return { Наименование: p.name, Код: p.code1c || '', Количество: it.qty, Сумма: it.sum, Склад: sk ? sk.name : it.skladId }; })
    });
  });

  return docs;
}

// ---------- 1С экспорт: спецификации номенклатуры (рецептуры) ----------
function exportSpecs1c() {
  return db.products
    .filter(p => p.recipeStatus === 'approved' && p.recipe && p.recipe.length)
    .map(p => ({
      Владелец: { Код: p.code1c || '', Наименование: p.name },
      ВыходКоличество: 1,
      Компоненты: p.recipe.map(it => {
        const c = product(it.productId);
        return {
          Код: c ? (c.code1c || '') : '',
          Наименование: c ? c.name : '?',
          Количество: it.qty,
          Единица: c ? c.unit : ''
        };
      })
    }));
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
function productOut(p, role) {
  if (role === 'admin') return p;
  const c = Object.assign({}, p);
  delete c.priceKg; delete c.lastCost;
  return c;
}

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
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const now = Date.now();
    const la = loginAttempts[ip];
    if (la && la.until > now) return json(res, 429, { error: 'Слишком много попыток. Подождите ' + Math.ceil((la.until - now) / 1000) + ' с.' });
    const cat = String(data.category || '');
    const catOk = u => cat === 'cook' ? isCook(u.role) : u.role === cat;
    const user = db.users.find(x => catOk(x) && x.pin === String(data.pin));
    if (!user) {
      const count = (la ? la.count : 0) + 1;
      loginAttempts[ip] = { count, until: count >= 5 ? now + 60000 : 0 };
      return json(res, 401, { error: 'Неверный PIN' });
    }
    delete loginAttempts[ip];
    const token = crypto.randomBytes(16).toString('hex');
    sessions[token] = user.id;
    return json(res, 200, { token, user: { id: user.id, name: user.name, role: user.role } });
  }
  const user = auth(req);
  if (!user) return json(res, 401, { error: 'Нужен вход' });
  const role = user.role;
  const isAdmin = role === 'admin';
  const isTech = role === 'tech';

  if (p === '/api/bootstrap' && req.method === 'GET') {
    const myProds = (isCook(role) && role !== 'cook_head') ? cookProducts(role) : db.products;
    const stock = {};
    myProds.forEach(prod => {
      const ts = totalStock(prod.id);
      stock[prod.id] = isAdmin || isTech
        ? { total: ts, bySklad: db.stock[prod.id] || {}, avg: ts.qty > 0.0001 ? r2(ts.value / ts.qty) : 0 }
        : { total: ts };
    });
    return json(res, 200, {
      products: myProds.map(x => productOut(x, role)),
      stock, sklads: db.sklads,
      settings: isAdmin ? db.settings : undefined,
      alerts: (isAdmin || isTech) ? db.alerts.filter(a => !a.read).slice(0, 10) : [],
      me: { id: user.id, name: user.name, role }
    });
  }

  // ---------- склады ----------
  if (p === '/api/sklads' && req.method === 'GET') return json(res, 200, db.sklads);
  if (p === '/api/sklads' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const ns = { id: nid('sk'), name: (data.name || '').trim(), is1cMain: false, cookRoles: data.cookRoles || [], code1c: data.code1c || '' };
    if (!ns.name) return json(res, 400, { error: 'Введите название' });
    db.sklads.push(ns); save();
    return json(res, 200, ns);
  }
  const mSk = p.match(/^\/api\/sklads\/([^/]+)$/);
  if (mSk && req.method === 'PUT') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const sk = sklad(mSk[1]);
    if (!sk) return json(res, 404, { error: 'Склад не найден' });
    if (data.name) sk.name = data.name;
    if (data.cookRoles !== undefined) sk.cookRoles = data.cookRoles;
    if (data.code1c !== undefined) sk.code1c = data.code1c;
    save();
    return json(res, 200, sk);
  }

  // ---------- продукты ----------
  if (p === '/api/products' && req.method === 'POST') {
    const type = data.type || 'raw';
    if (!VALID_TYPES.includes(type)) return json(res, 400, { error: 'Неверный тип' });
    // повар может добавлять любые продукты пока идёт наполнение базы
    const np = {
      id: nid('p'), name: (data.name || '').trim(), type, unit: VALID_UNITS.includes(data.unit) ? data.unit : 'кг',
      priceKg: 0, sourceId: data.sourceId || null, code1c: isCook(role) ? '' : (data.code1c || ''),
      skladId: data.skladId || (type === 'dish' ? 'sk7' : 'sk2'), salePrice: 0,
      recipe: (data.recipe || []).filter(it => it.qty > 0), recipeLog: [], lastCost: 0
    };
    if (!np.name) return json(res, 400, { error: 'Введите наименование' });
    if (np.recipe.length) { np.recipeStatus = 'draft'; logRecipe(np, user, 'создал рецептуру'); }
    db.products.push(np); save();
    return json(res, 200, productOut(np, role));
  }
  const mProd = p.match(/^\/api\/products\/([^/]+)$/);
  if (mProd && req.method === 'PUT') {
    const pr = product(mProd[1]);
    if (!pr) return json(res, 404, { error: 'Не найден' });
    const touchesRecipe = data.recipe !== undefined || (data.name !== undefined && pr.recipe.length);
    if (touchesRecipe && pr.recipe.length) {
      const st = pr.recipeStatus || 'draft';
      if (st === 'approved' && !isAdmin) return json(res, 403, { error: 'Рецептура утверждена. Изменения — только через директора' });
      if (st === 'submitted' && isCook(role)) return json(res, 403, { error: 'Рецептура передана менеджеру' });
    }
    const cleanRecipe = data.recipe !== undefined ? data.recipe.filter(it => it.qty > 0 && it.productId !== pr.id) : undefined;
    if (touchesRecipe) diffRecipe(pr, user, data.name, cleanRecipe);
    if (data.name !== undefined) pr.name = String(data.name).trim();
    if (data.type !== undefined && VALID_TYPES.includes(data.type)) pr.type = data.type;
    if (data.unit !== undefined && VALID_UNITS.includes(data.unit)) pr.unit = data.unit;
    if (data.sourceId !== undefined) pr.sourceId = (data.sourceId && data.sourceId !== pr.id) ? data.sourceId : null;
    if (data.code1c !== undefined) pr.code1c = data.code1c;
    if (data.salePrice !== undefined && !isCook(role)) pr.salePrice = +data.salePrice || 0;
    if (data.skladId !== undefined) pr.skladId = data.skladId;
    if (cleanRecipe !== undefined) pr.recipe = cleanRecipe;
    if (pr.recipe.length && !pr.recipeStatus) pr.recipeStatus = 'draft';
    save();
    return json(res, 200, productOut(pr, role));
  }

  // ---------- статусы рецептур ----------
  const mSt = p.match(/^\/api\/recipes\/([^/]+)\/status$/);
  if (mSt && req.method === 'POST') {
    const pr = product(mSt[1]);
    if (!pr || !pr.recipe.length) return json(res, 404, { error: 'Рецептура не найдена' });
    const st = pr.recipeStatus || 'draft';
    const a = data.action;
    if (a === 'submit') {
      if (st !== 'draft') return json(res, 400, { error: 'Уже передана' });
      pr.recipeStatus = 'submitted'; logRecipe(pr, user, 'передал менеджеру');
    } else if (a === 'approve') {
      if (isCook(role)) return json(res, 403, { error: 'Утверждает менеджер или директор' });
      if (st === 'approved') return json(res, 400, { error: 'Уже утверждена' });
      pr.recipeStatus = 'approved'; logRecipe(pr, user, 'УТВЕРДИЛ рецептуру');
    } else if (a === 'reopen') {
      if (!isAdmin) return json(res, 403, { error: 'Снять блок может только директор' });
      pr.recipeStatus = 'draft'; logRecipe(pr, user, 'вернул на доработку');
    } else return json(res, 400, { error: 'Неизвестное действие' });
    save();
    return json(res, 200, { status: pr.recipeStatus });
  }
  const mLog = p.match(/^\/api\/recipes\/([^/]+)\/log$/);
  if (mLog && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'История доступна директору' });
    const pr = product(mLog[1]);
    if (!pr) return json(res, 404, { error: 'Не найден' });
    return json(res, 200, pr.recipeLog || []);
  }

  // ---------- операции ----------
  if (p === '/api/ops' && req.method === 'POST') {
    if (data.type === 'receipt' && isCook(role)) return json(res, 403, { error: 'Нет прав' });
    if (data.type === 'inventory' && !isAdmin) return json(res, 403, { error: 'Инвентаризацию проводит директор' });
    if (data.type === 'writeoff' && isCook(role)) return json(res, 403, { error: 'Акт списания оформляет менеджер или директор' });
    if (data.type === 'move' && isCook(role) && role !== 'cook_head') return json(res, 403, { error: 'Перемещение делает менеджер' });
    const fn = OPS[data.type];
    if (!fn) return json(res, 400, { error: 'Неизвестная операция' });
    const rec = fn(data, user);
    rec.id = nid('o'); rec.ts = new Date().toISOString(); rec.userId = user.id;
    db.operations.push(rec); save();
    const out = Object.assign({}, rec);
    if (!isAdmin) { delete out.sum; delete out.price; delete out.writeoffs; }
    return json(res, 200, out);
  }
if (p === '/api/ops' && req.method === 'GET') {
    let ops = db.operations;
    const date = u.searchParams.get('date');
    const from = u.searchParams.get('from');
    const to = u.searchParams.get('to');
    const type = u.searchParams.get('type');
    const mine = u.searchParams.get('mine');
    if (date) ops = ops.filter(o => o.ts.slice(0, 10) === date);
    if (from) ops = ops.filter(o => o.ts.slice(0, 10) >= from);
    if (to) ops = ops.filter(o => o.ts.slice(0, 10) <= to);
    if (type) ops = ops.filter(o => o.type === type);
    if (mine) ops = ops.filter(o => o.userId === user.id);
    ops = ops.slice(-500);
    if (!isAdmin) ops = ops.map(o => { const c = Object.assign({}, o); delete c.sum; delete c.price; delete c.writeoffs; return c; });
    return json(res, 200, ops);
  }

  // ---------- заказы (план на приготовление) ----------
  if (p === '/api/orders' && req.method === 'GET') {
    return json(res, 200, db.orders);
  }
  if (p === '/api/orders' && req.method === 'POST') {
    if (isCook(role)) return json(res, 403, { error: 'Заказы создаёт менеджер или директор' });
    const qty = +data.qty;
    if (!(qty > 0)) return json(res, 400, { error: 'Введите количество' });
    const dateFrom = data.dateFrom || today();
    const dateTo = data.dateTo || dateFrom;
    if (dateTo < dateFrom) return json(res, 400, { error: 'Срок раньше даты начала' });
    const pr = product(data.productId);
    if (!pr) return json(res, 400, { error: 'Продукт не найден' });
    const ord = { id: nid('ord'), productId: data.productId, qty, dateFrom, dateTo, ts: new Date().toISOString(), userId: user.id };
    db.orders.push(ord); save();
    return json(res, 200, ord);
  }
  const mOrd = p.match(/^\/api\/orders\/([^/]+)$/);
  if (mOrd && req.method === 'DELETE') {
    if (isCook(role)) return json(res, 403, { error: 'Только менеджер или директор' });
    db.orders = db.orders.filter(o => o.id !== mOrd[1]);
    save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/report/plan' && req.method === 'GET') {
    return json(res, 200, reportPlan());
  }

  // ---------- отчёты ----------
  if (p === '/api/report/costing') {
    if (!isAdmin) return json(res, 403, { error: 'Калькуляция доступна директору' });
    return json(res, 200, reportCosting());
  }
  if (p === '/api/report/output') {
    // все роли включая повара
    return json(res, 200, reportOutput(u.searchParams.get('from'), u.searchParams.get('to'), !isAdmin));
  }
  if (p === '/api/report/stock') {
    return json(res, 200, reportStock(role));
  }
  if (p === '/api/inv/history') {
    if (!isAdmin && !isTech) return json(res, 403, { error: 'Нет прав' });
    return json(res, 200, db.invHistory.slice(0, 20));
  }
  if (p === '/api/alerts/read' && req.method === 'POST') {
    db.alerts.forEach(a => { a.read = true; }); save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/settings' && req.method === 'PUT') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    if (data.diffThresholdPct !== undefined) db.settings.diffThresholdPct = +data.diffThresholdPct || 5;
    save();
    return json(res, 200, db.settings);
  }
  if (p === '/api/1c/export') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const date = u.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    return json(res, 200, { Дата: date, Документы: export1c(date) });
  }
  if (p === '/api/1c/specs') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, { Спецификации: exportSpecs1c() });
  }
  if (p === '/api/1c/nomenclature-diff' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const byCode = {};
    db.products.forEach(p => { if (p.code1c) byCode[p.code1c] = p; });
    const matched = [];
    const newInOneC = [];
    const missingInOneC = [];
    const seenCodes = new Set();
    incoming.forEach(item => {
      seenCodes.add(item.code);
      const existing = byCode[item.code];
      if (existing) {
        matched.push({ productId: existing.id, ourName: existing.name, theirName: item.name, code: item.code, nameChanged: existing.name !== item.name });
      } else {
        newInOneC.push(item);
      }
    });
    db.products.forEach(p => {
      if (p.code1c && !seenCodes.has(p.code1c)) {
        missingInOneC.push({ productId: p.id, name: p.name, code1c: p.code1c });
      }
    });
    const result = { matched: matched.length, matchedDetails: matched.filter(m => m.nameChanged), newInOneC, missingInOneC };
    db.lastNomenclatureDiff = Object.assign({ ts: new Date().toISOString(), totalIncoming: incoming.length }, result);
    save();
    return json(res, 200, result);
  }
  // директор смотрит последнюю сверку в интерфейсе, даже если её запускало 1С напрямую
  if (p === '/api/1c/nomenclature-diff' && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, db.lastNomenclatureDiff || null);
  }

  // ---------- сверка остатков: 1С присылает {items:[{code, qty}]}, сравниваем с нашим stock по code1c ----------
  if (p === '/api/1c/stock-diff' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const byCode = {};
    db.products.forEach(p => { if (p.code1c) byCode[p.code1c] = p; });
    const seenCodes = new Set();
    const mismatches = [];
    let matchedSame = 0;
    const notInSkyMeal = [];
    incoming.forEach(item => {
      const code = String(item.code || '').trim();
      if (!code) return;
      seenCodes.add(code);
      const pr = byCode[code];
      if (!pr) { notInSkyMeal.push({ code, qty1c: item.qty, name: item.name || '' }); return; }
      const ourQty = totalStock(pr.id).qty;
      const diff = r2((+item.qty || 0) - ourQty);
      if (Math.abs(diff) > 0.01) {
        mismatches.push({ productId: pr.id, name: pr.name, code, qty1c: item.qty, qtySkyMeal: ourQty, diff });
      } else {
        matchedSame++;
      }
    });
    const notIn1c = [];
    db.products.forEach(pr => {
      if (pr.code1c && !seenCodes.has(pr.code1c)) {
        const ourQty = totalStock(pr.id).qty;
        if (Math.abs(ourQty) > 0.01) notIn1c.push({ productId: pr.id, name: pr.name, code: pr.code1c, qtySkyMeal: ourQty });
      }
    });
    const result = { matchedSame, mismatches, notInSkyMeal, notIn1c };
    db.lastStockDiff = Object.assign({ ts: new Date().toISOString(), totalIncoming: incoming.length }, result);
    save();
    return json(res, 200, result);
  }
  if (p === '/api/1c/stock-diff' && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, db.lastStockDiff || null);
  }

  // ---------- применение сверки остатков: подтягиваем факт из 1С на основной склад (is1cMain) ----------
  if (p === '/api/1c/stock-apply' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const mainSk = db.sklads.find(s => s.is1cMain);
    if (!mainSk) return json(res, 400, { error: 'Не найден склад, помеченный как основной (is1cMain)' });
    const byCode = {};
    db.products.forEach(p => { if (p.code1c) byCode[p.code1c] = p; });
    const rows = [];
    incoming.forEach(item => {
      const code = String(item.code || '').trim();
      if (!code) return;
      const pr = byCode[code];
      if (!pr) return; // нет в SkyMeal — сначала сверка/создание номенклатуры
      const s = stockOf(pr.id, mainSk.id);
      const accountQty = s.qty;
      const uc = unitCost(pr.id);
      const factQty = +item.qty || 0;
      const diff = r2(factQty - accountQty);
      const diffSum = r2(diff * uc);
      checkDiff(pr.id, factQty, accountQty);
      s.value = r2(Math.max(0, s.value + diffSum));
      s.qty = factQty;
      rows.push({ productId: pr.id, skladId: mainSk.id, accountQty, factQty, diff, diffSum });
    });
    const total = r2(rows.reduce((a, r) => a + r.diffSum, 0));
    db.invHistory.unshift({ id: nid('iv'), ts: new Date().toISOString(), user: user.name, rows, total, source: '1С' });
    if (db.invHistory.length > 50) db.invHistory = db.invHistory.slice(0, 50);
    db.lastStockDiff = null;
    save();
    return json(res, 200, { applied: rows.length, total });
  }

  if (p === '/api/1c/nomenclature-apply' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const byCode = {};
    db.products.forEach(p => { if (p.code1c) byCode[p.code1c] = p; });
    let updated = 0, created = 0;
    incoming.forEach(item => {
      const existing = byCode[item.code];
      if (existing) {
        if (existing.name !== item.name) { existing.name = item.name; updated++; }
      } else if (data.createMissing) {
        const nid2 = 'p' + Math.random().toString(36).slice(2, 8);
        db.products.push({ id: nid2, name: item.name, type: 'raw', unit: item.unit || 'г', priceKg: 0, sourceId: null, code1c: item.code, recipe: [], recipeLog: [], lastCost: 0, skladId: 'sk2' });
        created++;
      }
    });
    db.lastNomenclatureDiff = null;
    save();
    return json(res, 200, { updated, created });
  }

  json(res, 404, { error: 'not found' });
}

server.listen(PORT, () => console.log('SKY MEAL v5 запущен: http://localhost:' + PORT));
