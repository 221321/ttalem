// SKY MEAL v5 — многоскладовой учёт кухни бортпитания
// Node.js без внешних зависимостей. Запуск: node server.js [порт]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || process.argv[2] || 3050;
// секрет для машина-машина вызовов из 1С (как в Жайыке): 1С не логинится через PIN,
// а стучится сразу с этим ключом — используется только для payment-confirm ниже.
const SYNC_SECRET = process.env.SYNC_SECRET || 'skymeal_1c_2026';
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
// Торговый / экспедитор — не повар, но и не менеджер: продаёт, видит только своё, деньги/себестоимость не видит
const isAgent = role => role === 'agent';

// ---------- цеха (department) ----------
// Один физический склад на всё (совпадает с 1С — там тоже один склад).
// "Цех" — не отдельный запас, а просто метка на товаре: кто из поваров с ним работает.
const MAIN_SK = 'sk1';
const DEPARTMENTS = ['Кухня / Заготовки', 'Сэндвичи', 'Горячее', 'Хлеб и тесто', 'Кондитерка', 'Готовая продукция'];
const DEFAULT_DEPARTMENT = 'Кухня / Заготовки';
// какие цеха видит специализированная роль повара; если роли нет в списке — видит все цеха
const ROLE_DEPARTMENTS = {
  cook_prep:   ['Кухня / Заготовки'],
  cook_sand:   ['Сэндвичи'],
  cook_hot:    ['Горячее'],
  cook_baker:  ['Хлеб и тесто'],
  cook_pastry: ['Кондитерка'],
};
function canSeeDepartment(role, dept) {
  if (role === 'admin' || role === 'tech' || role === 'cook' || role === 'cook_head') return true;
  const allowed = ROLE_DEPARTMENTS[role];
  return !allowed || allowed.includes(dept);
}
function departmentForType(type) {
  if (type === 'dish') return 'Готовая продукция';
  if (type === 'bread') return 'Хлеб и тесто';
  return DEFAULT_DEPARTMENT;
}

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

  // ЕДИНЫЙ СКЛАД: если в базе ещё старые 6-7 складов — схлопываем их в один (MAIN_SK),
  // а прежнее разделение по складам переносим в поле "department" (цех) — оно нужно
  // только для того, чтобы повар видел свой участок, на физический остаток не влияет.
  if (db.sklads.length > 1) {
    changed = true;
    const nameById = {};
    db.sklads.forEach(sk => { nameById[sk.id] = sk.name; });
    const mainSkPrev = db.sklads.find(sk => sk.is1cMain) || db.sklads[0];

    db.products.forEach(p => {
      if (!p.department) {
        const name = nameById[p.skladId];
        p.department = (name && p.skladId !== mainSkPrev.id) ? name : departmentForType(p.type);
      }
      p.skladId = MAIN_SK;
    });

    // остатки: суммируем по товару все склады в один MAIN_SK
    Object.keys(db.stock).forEach(pid => {
      const bySkl = db.stock[pid] || {};
      let qty = 0, value = 0;
      Object.values(bySkl).forEach(s => { qty += (s.qty || 0); value += (s.value || 0); });
      db.stock[pid] = { [MAIN_SK]: { qty: Math.round(qty * 100) / 100, value: Math.round(value * 100) / 100 } };
    });

    db.sklads = [{ id: MAIN_SK, name: mainSkPrev.name || 'Основной склад', is1cMain: true, cookRoles: [] }];
  }
  // цех по умолчанию для товаров без него (новые базы / товары, добавленные после миграции)
  db.products.forEach(p => {
    if (!DEPARTMENTS.includes(p.department)) { p.department = departmentForType(p.type); changed = true; }
    if (p.skladId !== MAIN_SK) { p.skladId = MAIN_SK; changed = true; }
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

  // справочник контрагентов (клиентов) — раньше client был просто текстом на продаже,
  // из-за чего в 1С плодились дубли контрагентов по каждой опечатке в имени
  if (!Array.isArray(db.clients)) { db.clients = []; changed = true; }

  // сдачи наличности агентами/водителями (инкассация) — сколько и когда сдали
  if (!Array.isArray(db.cashHandovers)) { db.cashHandovers = []; changed = true; }

  // статусы документов в 1С (как в ГБ2: реестр "отправлено / создано в 1С / ошибка" по каждому Ид)
  if (!db.docStatus || typeof db.docStatus !== 'object') { db.docStatus = {}; changed = true; }

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
// продукты, доступные роли повара (через цех продукта)
function cookProducts(role) {
  return db.products.filter(p => canSeeDepartment(role, p.department));
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
// множитель на списание сырья с поправкой на % отхода при чистке/нарезке
// (например помидор с wastePct=10 — на каждые 100г "в блюде" спишется 111г сырого со склада)
function wasteMultiplier(c) {
  if (c && c.type === 'raw' && c.wastePct > 0 && c.wastePct < 100) {
    return 1 / (1 - c.wastePct / 100);
  }
  return 1;
}
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
    let factor = (c && (c.unit === 'кг' || c.unit === 'л')) ? it.qty / 1000 : it.qty;
    factor *= wasteMultiplier(c); // поправка на % отхода — считаем от сырого, а не от чистого веса
    const cost = r2(uc * factor);
    total += cost;
    return { productId: it.productId, name: c ? c.name : '?', qty: it.qty, unit: c ? c.unit : '', unitCost: r2(uc), cost, hasRecipe: !!(c && c.recipe && c.recipe.length), wastePct: (c && c.wastePct > 0) ? c.wastePct : 0 };
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
  const skId = MAIN_SK;
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
  const rawSkId = MAIN_SK;
  const semiSkId = MAIN_SK;
  const sr = stockOf(o.rawId, rawSkId);
  if (sr.qty + 0.001 < o.qtyBefore) throw new Error('Недостаточно «' + raw.name + '» на складе: есть ' + sr.qty + ', требуется ' + o.qtyBefore + '. Сначала сделайте приход.');
  const uc = unitCost(o.rawId);
  const moved = r2(uc * o.qtyBefore);
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
  // сначала считаем что потребуется и проверяем остатки — ничего не списываем, пока не убедимся что хватает всего
  const planned = p.recipe.map(it => {
    const c = product(it.productId);
    const uc = unitCost(it.productId);
    const baseFactor = (c && (c.unit === 'кг' || c.unit === 'л')) ? it.qty * o.count / 1000 : it.qty * o.count;
    const factor = baseFactor * wasteMultiplier(c); // спишем больше сырья, чем указано в рецепте, с поправкой на % отхода
    const skId = MAIN_SK;
    const s = stockOf(it.productId, skId);
    return { it, c, uc, baseFactor, factor, skId, s };
  });
  const insuff = planned.find(x => x.s.qty + 0.001 < x.factor);
  if (insuff) {
    throw new Error('Недостаточно «' + (insuff.c ? insuff.c.name : insuff.it.productId) + '» на складе: есть ' + r2(insuff.s.qty) + ', требуется ' + r2(insuff.factor) + '. Сначала сделайте обработку/приход.');
  }
  let total = 0;
  const writeoffs = planned.map(x => {
    const val = r2(x.uc * x.factor);
    x.s.qty = r2(x.s.qty - x.factor);
    x.s.value = r2(Math.max(0, x.s.value - val));
    total += val;
    const wasteQty = r2(x.factor - x.baseFactor);
    return { productId: x.it.productId, skladId: x.skId, qty: r2(x.factor), sum: val, baseQty: r2(x.baseFactor), wasteQty: wasteQty };
  });
  const outSkId = MAIN_SK;
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
    const s = stockOf(it.productId, MAIN_SK);
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
    const skId = MAIN_SK;
    const uc = unitCost(it.productId);
    const val = r2(uc * it.qty);
    const s = stockOf(it.productId, skId);
    s.qty = r2(s.qty - it.qty);
    s.value = r2(Math.max(0, s.value - val));
    return { productId: it.productId, skladId: skId, qty: it.qty, sum: val };
  });
  return { type: 'writeoff', reason: o.reason || 'списание', items: rows, sum: r2(rows.reduce((a, r) => a + r.sum, 0)) };
}
function opSale(o) {
  const p = product(o.productId);
  if (!p) throw new Error('Продукт не найден');
  if (!(o.qty > 0)) throw new Error('Количество должно быть больше нуля');
  const skId = MAIN_SK;
  const s = stockOf(o.productId, skId);
  if (s.qty + 0.001 < o.qty) throw new Error('Недостаточно «' + p.name + '» на складе: есть ' + r2(s.qty) + ', требуется ' + o.qty + '. Сначала сделайте выпуск.');
  const uc = unitCost(o.productId);
  const costSum = r2(uc * o.qty);
  const price = o.price != null && o.price !== '' ? +o.price : (p.salePrice || 0);
  const sum = r2(price * o.qty);
  s.qty = r2(s.qty - o.qty);
  s.value = r2(Math.max(0, s.value - costSum));

  // разбивка оплаты нал/QR/долг (для торговых/водителей на выезде); если её не прислали —
  // работает старый режим: paid=true/false целиком
  let paymentCash = 0, paymentQr = 0;
  if (o.paymentCash != null || o.paymentQr != null) {
    paymentCash = r2(Math.max(0, +o.paymentCash || 0));
    paymentQr = r2(Math.max(0, +o.paymentQr || 0));
  } else if (o.paid) {
    paymentCash = sum; // старое поведение: "оплачено" без разбивки — считаем наличными
  }
  const paidAmount = r2(Math.min(sum, paymentCash + paymentQr));
  const paymentDebt = r2(Math.max(0, sum - paidAmount));
  const paid = paidAmount >= sum - 0.001;

  // клиент: либо ссылка на справочник db.clients (clientId — предпочтительно, даёт code1c для 1С),
  // либо просто текст по старинке (тогда 1С будет искать/создавать контрагента по имени)
  let clientName = (o.client || '').trim();
  let clientId = o.clientId || null;
  if (clientId) {
    const c = db.clients.find(x => x.id === clientId);
    if (c) clientName = c.name; else clientId = null;
  }

  return {
    type: 'sale', productId: o.productId, skladId: skId, qty: o.qty, price, sum, costSum,
    profit: r2(sum - costSum), client: clientName, clientId,
    paymentCash, paymentQr, paymentDebt, paid, paidAmount
  };
}
// накладная — несколько позиций одним документом (как в Жайыке: клиент + адрес + список строк).
// Всё-или-ничего: сначала проверяем остатки по ВСЕМ строкам, потом списываем — чтобы не списать половину
// накладной и не упереться в нехватку на третьей позиции.
function opWaybill(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  if (!items.length) throw new Error('Добавьте хотя бы одну позицию');
  const planned = items.map(it => {
    const p = product(it.productId);
    if (!p) throw new Error('Продукт не найден: ' + it.productId);
    if (!(+it.qty > 0)) throw new Error('Количество должно быть больше нуля: ' + p.name);
    const skId = MAIN_SK;
    const s = stockOf(it.productId, skId);
    if (s.qty + 0.001 < +it.qty) throw new Error('Недостаточно «' + p.name + '» на складе: есть ' + r2(s.qty) + ', требуется ' + it.qty);
    const uc = unitCost(it.productId);
    const price = it.price != null && it.price !== '' ? +it.price : (p.salePrice || 0);
    const qty = +it.qty;
    return { p, s, skId, uc, price, qty, costSum: r2(uc * qty), sum: r2(price * qty) };
  });
  // всё в порядке — списываем
  const lines = planned.map(x => {
    x.s.qty = r2(x.s.qty - x.qty);
    x.s.value = r2(Math.max(0, x.s.value - x.costSum));
    return { productId: x.p.id, name: x.p.name, unit: x.p.unit, skladId: x.skId, qty: x.qty, price: x.price, sum: x.sum, costSum: x.costSum };
  });
  const sum = r2(lines.reduce((a, l) => a + l.sum, 0));
  const costSum = r2(lines.reduce((a, l) => a + l.costSum, 0));

  let paymentCash = 0, paymentQr = 0;
  if (o.paymentCash != null || o.paymentQr != null) {
    paymentCash = r2(Math.max(0, +o.paymentCash || 0));
    paymentQr = r2(Math.max(0, +o.paymentQr || 0));
  }
  const paidAmount = r2(Math.min(sum, paymentCash + paymentQr));
  const paymentDebt = r2(Math.max(0, sum - paidAmount));
  const paid = paidAmount >= sum - 0.001;

  let clientName = (o.client || '').trim();
  let clientId = o.clientId || null;
  let address = (o.address || '').trim();
  if (clientId) {
    const c = db.clients.find(x => x.id === clientId);
    if (c) { clientName = c.name; if (!address) address = c.address || ''; } else clientId = null;
  }

  return {
    type: 'waybill', items: lines, sum, costSum, profit: r2(sum - costSum),
    client: clientName, clientId, address,
    paymentCash, paymentQr, paymentDebt, paid, paidAmount
  };
}
const OPS = { receipt: opReceipt, processing: opProcessing, production: opProduction, inventory: opInventory, move: opMove, writeoff: opWriteoff, sale: opSale, waybill: opWaybill };

// ---------- отчёты ----------
// ---------- отчёт по реализации: выручка, себестоимость, прибыль, долги ----------
function reportSales(from, to) {
  let ops = db.operations.filter(o => o.type === 'sale' && !o.cancelled);
  if (from) ops = ops.filter(o => o.ts.slice(0, 10) >= from);
  if (to) ops = ops.filter(o => o.ts.slice(0, 10) <= to);

  const rows = ops.slice().sort((a, b) => a.ts < b.ts ? 1 : -1).map(o => {
    const p = product(o.productId);
    const seller = db.users.find(u => u.id === o.userId);
    return {
      id: o.id, ts: o.ts, name: p ? p.name : '?', unit: p ? p.unit : '',
      qty: o.qty, price: o.price, sum: o.sum, costSum: o.costSum, profit: o.profit,
      client: o.client, clientId: o.clientId || null, paid: o.paid, paidAmount: o.paidAmount, debt: r2((o.sum || 0) - (o.paidAmount || 0)),
      paymentCash: o.paymentCash || 0, paymentQr: o.paymentQr || 0,
      sellerId: o.userId, sellerName: seller ? seller.name : '?', source: o.source || 'сайт'
    };
  });

  const debts = rows.filter(r => !r.paid && r.debt > 0.001);

  // сколько числится за каждым продавцом (актуально для торговых/экспедиторов — кто на руках держит долг)
  const byAgent = {};
  rows.forEach(r => {
    if (!byAgent[r.sellerId]) byAgent[r.sellerId] = { sellerId: r.sellerId, sellerName: r.sellerName, revenue: 0, debt: 0, salesCount: 0 };
    byAgent[r.sellerId].revenue = r2(byAgent[r.sellerId].revenue + (r.sum || 0));
    byAgent[r.sellerId].salesCount++;
    if (!r.paid) byAgent[r.sellerId].debt = r2(byAgent[r.sellerId].debt + r.debt);
  });

  const totals = {
    revenue: r2(rows.reduce((a, r) => a + (r.sum || 0), 0)),
    cost: r2(rows.reduce((a, r) => a + (r.costSum || 0), 0)),
    profit: r2(rows.reduce((a, r) => a + (r.profit || 0), 0)),
    debt: r2(debts.reduce((a, r) => a + r.debt, 0))
  };

  return { rows, debts, byAgent: Object.values(byAgent), totals };
}
// ---------- отчёт по потерям: усушка при обработке, списания, недостачи по инвентаризации ----------
function reportLosses(from, to) {
  let ops = db.operations;
  if (from) ops = ops.filter(o => o.ts.slice(0, 10) >= from);
  if (to) ops = ops.filter(o => o.ts.slice(0, 10) <= to);

  const processing = ops.filter(o => o.type === 'processing').map(o => {
    const raw = product(o.rawId), semi = product(o.semiId);
    return {
      ts: o.ts, rawName: raw ? raw.name : '?', semiName: semi ? semi.name : '?',
      qtyBefore: o.qtyBefore, qtyAfter: o.qtyAfter, lossQty: r2(o.qtyBefore - o.qtyAfter), lossPct: o.lossPct
    };
  });

  const writeoffs = ops.filter(o => o.type === 'writeoff').map(o => ({
    ts: o.ts, reason: o.reason,
    items: (o.items || []).map(it => { const p = product(it.productId); return { name: p ? p.name : '?', qty: it.qty, sum: it.sum }; }),
    sum: o.sum
  }));

  const shortages = [];
  ops.filter(o => o.type === 'inventory').forEach(o => {
    (o.items || []).forEach(r => {
      if (r.diff < -0.001) {
        const p = product(r.productId);
        shortages.push({ ts: o.ts, name: p ? p.name : '?', diff: r.diff, diffSum: r.diffSum });
      }
    });
  });

  return {
    processing, writeoffs, shortages,
    totals: {
      writeoffSum: r2(writeoffs.reduce((a, w) => a + (w.sum || 0), 0)),
      shortageSum: r2(shortages.reduce((a, s) => a + Math.abs(s.diffSum || 0), 0))
    }
  };
}
function reportCosting() {
  return db.products.filter(p => p.recipe && p.recipe.length).map(p => {
    const c = recipeCost(p, {});
    return { productId: p.id, name: p.name, type: p.type, unit: p.unit, status: p.recipeStatus || 'draft', total: c.total, items: c.items, salePrice: p.salePrice || 0 };
  });
}
function reportOutput(from, to, hideMoney) {
  const inRange = o => (!from || o.ts.slice(0, 10) >= from) && (!to || o.ts.slice(0, 10) <= to);
  const waste = {};
  db.operations.filter(o => o.type === 'production' && inRange(o)).forEach(o => {
    (o.writeoffs || []).forEach(w => {
      if (!(w.wasteQty > 0.0001)) return; // ингредиент без % отхода — не показываем
      const k = w.productId;
      if (!waste[k]) waste[k] = { productId: k, baseQty: 0, wasteQty: 0, wasteSum: 0, n: 0 };
      waste[k].baseQty = r2(waste[k].baseQty + w.baseQty);
      waste[k].wasteQty = r2(waste[k].wasteQty + w.wasteQty);
      waste[k].wasteSum = r2(waste[k].wasteSum + r2((w.sum / w.qty) * w.wasteQty || 0));
      waste[k].n++;
    });
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
    waste: Object.values(waste).map(m => {
      const c = product(m.productId);
      const row = { name: c ? c.name : '?', unit: c ? c.unit : '', baseQty: m.baseQty, wasteQty: m.wasteQty,
        wastePct: c && c.wastePct ? c.wastePct : (m.baseQty > 0 ? r2(m.wasteQty / m.baseQty * 100) : 0) };
      if (!hideMoney) row.wasteSum = m.wasteSum;
      return row;
    }),
    production: Object.values(prod).map(m => {
      const row = { name: product(m.productId) ? product(m.productId).name : '?', unit: product(m.productId) ? product(m.productId).unit : '', count: m.count, byUser: m.byUser };
      if (!hideMoney) row.sum = m.sum;
      return row;
    })
  };
}
// остатки по товару (один физический склад — MAIN_SK)
function reportStock(role) {
  const showMoney = role === 'admin' || role === 'tech';
  const rows = [];
  db.products.forEach(p => {
    if (!canSeeDepartment(role, p.department)) return;
    const s = db.stock[p.id] && db.stock[p.id][MAIN_SK];
    const qty = s ? s.qty : 0;
    const value = s ? s.value : 0;
    if (qty === 0) return;
    rows.push({ productId: p.id, name: p.name, type: p.type, unit: p.unit, department: p.department, qty, value: showMoney ? value : undefined });
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

// ============================================================
// ---------- ОТЧЁТЫ ДИРЕКТОРУ: единый экран выбора отчёта ----------
// Каждый builder превращает уже существующие report*-функции (или новую логику)
// в одинаковый вид { title, totals:[{label,value}], tables:[{title,headers,rows}] } —
// из этого бесплатно получаются и таблицы на экране, и CSV, и печать в PDF.
// ============================================================
const REPORTS = {
  sales:   { name: 'Продажи и прибыль', period: true },
  debts:   { name: 'Долги по клиентам', period: false },
  byagent: { name: 'По торговым/агентам', period: true },
  cash:    { name: 'Касса и инкассация', period: true },
  stock:   { name: 'Остатки на складах', period: false },
  losses:  { name: 'Потери и списания', period: true },
  output:  { name: 'Выработка', period: true },
  costing: { name: 'Калькуляция себестоимости', period: false }
};

function money2(v) { return r2(v || 0); }

function buildReportSales(from, to) {
  const r = reportSales(from, to);
  return {
    title: 'Продажи и прибыль' + (from || to ? ' (' + (from || '…') + ' — ' + (to || '…') + ')' : ' (за всё время)'),
    totals: [
      { label: 'Выручка', value: r.totals.revenue, money: true },
      { label: 'Себестоимость', value: r.totals.cost, money: true },
      { label: 'Прибыль', value: r.totals.profit, money: true },
      { label: 'Долг', value: r.totals.debt, money: true }
    ],
    tables: [
      {
        title: 'Продажи', headers: ['Дата', 'Блюдо', 'Кол-во', 'Сумма', 'Продавец', 'Клиент', 'Нал', 'QR', 'Долг'],
        rows: r.rows.map(x => [x.ts.slice(0, 16).replace('T', ' '), x.name, x.qty, x.sum, x.sellerName, x.client || '', x.paymentCash, x.paymentQr, x.debt])
      },
      {
        title: 'Долги по этим продажам', headers: ['Дата', 'Блюдо', 'Клиент', 'Продавец', 'Долг'],
        rows: r.debts.map(x => [x.ts.slice(0, 16).replace('T', ' '), x.name, x.client || '', x.sellerName, x.debt])
      },
      {
        title: 'По продавцам', headers: ['Продавец', 'Выручка', 'Продаж', 'Долг на нём'],
        rows: r.byAgent.map(x => [x.sellerName, x.revenue, x.salesCount, x.debt])
      }
    ]
  };
}

function buildReportDebts() {
  const r = reportSales(null, null); // долги считаем за всё время, не за период
  const byClient = {};
  r.debts.forEach(d => {
    const key = d.clientId || ('name:' + (d.client || '(без клиента)'));
    if (!byClient[key]) byClient[key] = { client: d.client || '(без клиента)', clientId: d.clientId || null, debt: 0, count: 0, lastTs: d.ts };
    byClient[key].debt = money2(byClient[key].debt + d.debt);
    byClient[key].count++;
    if (d.ts > byClient[key].lastTs) byClient[key].lastTs = d.ts;
  });
  const debts1c = db.debts1c;
  const rows = Object.values(byClient).map(x => {
    let debt1c = null;
    if (debts1c && x.clientId) {
      const c = db.clients.find(cl => cl.id === x.clientId);
      if (c && c.code1c && debts1c.byCode[c.code1c]) debt1c = debts1c.byCode[c.code1c].balance;
    }
    return Object.assign(x, { debt1c, diff: debt1c != null ? money2(x.debt - debt1c) : null });
  });
  // клиенты, по которым 1С прислала реальный долг, но на сайте долга нет вообще (продажа отмечена
  // оплаченной, а по бухгалтерии реально не оплачена, или оплата шла мимо сайта) — иначе расхождение
  // молча терялось: отчёт брал клиентов только из тех, у кого есть неоплаченная продажа на сайте.
  if (debts1c) {
    const seenClientIds = new Set(rows.map(x => x.clientId).filter(Boolean));
    Object.keys(debts1c.byCode).forEach(code => {
      const c = db.clients.find(cl => cl.code1c === code);
      if (c && seenClientIds.has(c.id)) return; // уже учтён выше
      const balance = debts1c.byCode[code].balance;
      if (Math.abs(balance) < 0.01) return;
      rows.push({
        client: (c ? c.name : debts1c.byCode[code].name) + ' (нет долга на сайте)',
        clientId: c ? c.id : null, debt: 0, count: 0, lastTs: debts1c.ts,
        debt1c: balance, diff: money2(0 - balance)
      });
    });
  }
  rows.sort((a, b) => b.debt - a.debt);
  const note = debts1c ? 'Долг по 1С сверен: ' + new Date(debts1c.ts).toLocaleString('ru-RU') : 'Долг по 1С ещё не синхронизирован — нажмите в 1С «Отправить долги контрагентов»';
  return {
    title: 'Долги по клиентам (текущие, за всё время)',
    totals: [{ label: 'Всего долгов (сайт)', value: money2(rows.reduce((a, x) => a + x.debt, 0)), money: true }, { label: 'Клиентов с долгом', value: rows.length }],
    tables: [{
      title: 'Долги по клиентам · ' + note, headers: ['Клиент', 'Долг (сайт)', 'Долг (1С)', 'Расхождение', 'Продаж с долгом', 'Последняя продажа'],
      rows: rows.map(x => [x.client, x.debt, x.debt1c != null ? x.debt1c : '—', x.diff != null ? x.diff : '—', x.count, x.lastTs.slice(0, 10)])
    }]
  };
}

function buildReportByAgent(from, to) {
  const r = reportSales(from, to);
  return {
    title: 'По торговым/агентам' + (from || to ? ' (' + (from || '…') + ' — ' + (to || '…') + ')' : ' (за всё время)'),
    totals: [{ label: 'Выручка всего', value: r.totals.revenue, money: true }, { label: 'Долг всего', value: r.totals.debt, money: true }],
    tables: [{
      title: 'По продавцам', headers: ['Продавец', 'Выручка', 'Продаж', 'Долг на нём'],
      rows: r.byAgent.slice().sort((a, b) => b.revenue - a.revenue).map(x => [x.sellerName, x.revenue, x.salesCount, x.debt])
    }]
  };
}

function buildReportCash(from, to) {
  const inRange = ts => (!from || ts.slice(0, 10) >= from) && (!to || ts.slice(0, 10) <= to);
  const byUser = {};
  db.operations.filter(o => o.type === 'sale' && !o.cancelled && inRange(o.ts)).forEach(o => {
    if (!byUser[o.userId]) byUser[o.userId] = { userId: o.userId, cash: 0, qr: 0, count: 0 };
    byUser[o.userId].cash = money2(byUser[o.userId].cash + (o.paymentCash || 0));
    byUser[o.userId].qr = money2(byUser[o.userId].qr + (o.paymentQr || 0));
    byUser[o.userId].count++;
  });
  const handovers = db.cashHandovers.filter(h => inRange(h.ts || h.date || ''));
  handovers.forEach(h => {
    if (!byUser[h.userId]) byUser[h.userId] = { userId: h.userId, cash: 0, qr: 0, count: 0 };
    byUser[h.userId].handed = money2((byUser[h.userId].handed || 0) + h.amount);
  });
  const rows = Object.values(byUser).map(x => {
    const u = db.users.find(u => u.id === x.userId);
    return { name: u ? u.name : '?', cash: x.cash, qr: x.qr, handed: x.handed || 0, onHand: money2(x.cash - (x.handed || 0)), count: x.count };
  });
  return {
    title: 'Касса и инкассация' + (from || to ? ' (' + (from || '…') + ' — ' + (to || '…') + ')' : ' (за всё время)'),
    totals: [
      { label: 'Собрано наличными', value: money2(rows.reduce((a, x) => a + x.cash, 0)), money: true },
      { label: 'Собрано QR', value: money2(rows.reduce((a, x) => a + x.qr, 0)), money: true },
      { label: 'Сдано в кассу', value: money2(rows.reduce((a, x) => a + x.handed, 0)), money: true }
    ],
    tables: [
      { title: 'По сотрудникам', headers: ['Сотрудник', 'Нал собрано', 'QR собрано', 'Сдано', 'Не сдано (за период)', 'Продаж'], rows: rows.map(x => [x.name, x.cash, x.qr, x.handed, x.onHand, x.count]) },
      { title: 'История инкассаций', headers: ['Дата', 'Сотрудник', 'Сумма'], rows: handovers.map(h => { const u = db.users.find(u => u.id === h.userId); return [(h.ts || h.date || '').slice(0, 16).replace('T', ' '), u ? u.name : '?', h.amount]; }) }
    ]
  };
}

function buildReportStock(role) {
  const rows = reportStock(role);
  const flat = rows.map(p => [p.name, p.type, p.unit, p.department, p.qty, p.value != null ? p.value : '']);
  return {
    title: 'Остатки на складе',
    totals: [{ label: 'Позиций с остатком', value: rows.length }],
    tables: [{ title: 'Остатки', headers: ['Товар', 'Тип', 'Ед', 'Цех', 'Кол-во', 'Сумма'], rows: flat }]
  };
}

function buildReportLosses(from, to) {
  const r = reportLosses(from, to);
  return {
    title: 'Потери и списания' + (from || to ? ' (' + (from || '…') + ' — ' + (to || '…') + ')' : ' (за всё время)'),
    totals: [{ label: 'Списано на сумму', value: r.totals.writeoffSum, money: true }, { label: 'Недостача на сумму', value: r.totals.shortageSum, money: true }],
    tables: [
      { title: 'Усушка при обработке', headers: ['Дата', 'Сырьё', 'П/ф', 'До', 'После', 'Потеря', '%'], rows: r.processing.map(x => [x.ts.slice(0, 10), x.rawName, x.semiName, x.qtyBefore, x.qtyAfter, x.lossQty, x.lossPct]) },
      { title: 'Списания', headers: ['Дата', 'Причина', 'Состав', 'Сумма'], rows: r.writeoffs.map(x => [x.ts.slice(0, 10), x.reason || '', x.items.map(i => i.name + ' ×' + i.qty).join(', '), x.sum]) },
      { title: 'Недостачи по инвентаризации', headers: ['Дата', 'Товар', 'Расхождение', 'Сумма'], rows: r.shortages.map(x => [x.ts.slice(0, 10), x.name, x.diff, x.diffSum]) }
    ]
  };
}

function buildReportOutput(from, to) {
  const r = reportOutput(from, to);
  return {
    title: 'Выработка' + (from || to ? ' (' + (from || '…') + ' — ' + (to || '…') + ')' : ' (за всё время)'),
    totals: [],
    tables: [
      { title: 'Обработка (усушка)', headers: ['Сырьё', 'П/ф', 'Ед', 'Операций', 'До', 'После', 'Потеря %'], rows: r.processing.map(x => [x.raw, x.semi, x.unit, x.operations, x.totalBefore, x.totalAfter, x.avgLossPct]) },
      { title: 'Выпуск готовой продукции', headers: ['Блюдо', 'Ед', 'Кол-во', 'Сумма'], rows: r.production.map(x => [x.name, x.unit, x.count, x.sum != null ? x.sum : '']) }
    ]
  };
}

function buildReportCosting() {
  const r = reportCosting();
  return {
    title: 'Калькуляция себестоимости',
    totals: [{ label: 'Позиций с рецептом', value: r.length }],
    tables: [{
      title: 'Калькуляция', headers: ['Блюдо', 'Тип', 'Ед', 'Статус', 'Себестоимость', 'Цена продажи', 'Маржа'],
      rows: r.map(x => [x.name, x.type, x.unit, x.status, x.total, x.salePrice, money2(x.salePrice - x.total)])
    }]
  };
}

const REPORT_BUILDERS = {
  sales: (from, to) => buildReportSales(from, to),
  debts: () => buildReportDebts(),
  byagent: (from, to) => buildReportByAgent(from, to),
  cash: (from, to) => buildReportCash(from, to),
  stock: (from, to, role) => buildReportStock(role),
  losses: (from, to) => buildReportLosses(from, to),
  output: (from, to) => buildReportOutput(from, to),
  costing: () => buildReportCosting()
};

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function reportToCsv(report) {
  const lines = ['\uFEFF' + csvCell(report.title)];
  if (report.totals && report.totals.length) {
    lines.push('');
    report.totals.forEach(t => lines.push(csvCell(t.label) + ';' + csvCell(t.value)));
  }
  report.tables.forEach(t => {
    lines.push('');
    lines.push(csvCell(t.title));
    lines.push(t.headers.map(csvCell).join(';'));
    t.rows.forEach(row => lines.push(row.map(csvCell).join(';')));
  });
  return lines.join('\r\n');
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
    const key = MAIN_SK;
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
  Object.entries(moveOps).forEach(([key, g]) => {
    const from = sklad(g.fromSkId), to = sklad(g.toSkId);
    docs.push({
      Ид: 'move|' + date + '|' + key,
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
  Object.entries(procMap).forEach(([key, g]) => {
    const raw = product(g.rawId), semi = product(g.semiId);
    const sk = sklad(g.semiSkId);
    docs.push({
      Ид: 'proc|' + date + '|' + key,
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
      Ид: 'prod|' + date + '|' + pid,
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
      Ид: 'wo|' + o.id,
      ВидДокумента: 'СписаниеТМЗ', Дата: date, Время: t(),
      Комментарий: 'SKY MEAL: ' + o.reason,
      Товары: o.items.map(it => { const p = product(it.productId); const sk = sklad(it.skladId); return { Наименование: p.name, Код: p.code1c || '', Количество: it.qty, Сумма: it.sum, Склад: sk ? sk.name : it.skladId }; })
    });
  });

  // реализация (продажи клиентам)
  dayOps.filter(o => o.type === 'sale' && !o.cancelled).forEach(o => {
    const p = product(o.productId);
    const sk = sklad(o.skladId);
    const cl = o.clientId ? db.clients.find(c => c.id === o.clientId) : null;
    const seller = db.users.find(u => u.id === o.userId);
    docs.push({
      Ид: 'sale|' + o.id,
      ВидДокумента: 'РеализацияТМЗ', Дата: date, Время: t(),
      Комментарий: 'SKY MEAL: продажа ' + p.name + (o.client ? ' — ' + o.client : ''),
      Клиент: o.client || '',
      КлиентИд: o.clientId || '',        // внутренний id клиента SkyMeal — вернуть через clients-resolve
      КлиентКод1С: cl ? (cl.code1c || '') : '', // если уже сматчен раньше — 1С ищет контрагента сразу по коду, без создания дублей
      Оплачено: !!o.paid,
      ОплаченоНал: o.paymentCash || 0,   // сколько именно наличными — для разноски по кассе
      ОплаченоQR: o.paymentQr || 0,      // сколько именно QR/картой — для разноски по эквайрингу
      Долг: o.paymentDebt || 0,
      Продавец: seller ? seller.name : '',
      Склад: sk ? sk.name : o.skladId,
      Товары: [{ Наименование: p.name, Код: p.code1c || '', Количество: o.qty, Цена: o.price, Сумма: o.sum }]
    });
  });

  // накладные (многострочные продажи с адресом — оформление как в Жайыке: клиент + адрес + список строк)
  dayOps.filter(o => o.type === 'waybill').forEach(o => {
    const cl = o.clientId ? db.clients.find(c => c.id === o.clientId) : null;
    const seller = db.users.find(u => u.id === o.userId);
    docs.push({
      Ид: 'waybill|' + o.id,
      ВидДокумента: 'РеализацияТМЗ', Дата: date, Время: t(),
      Комментарий: 'SKY MEAL: накладная' + (o.client ? ' — ' + o.client : '') + ' (' + o.items.length + ' поз.)',
      Клиент: o.client || '',
      КлиентИд: o.clientId || '',
      КлиентКод1С: cl ? (cl.code1c || '') : '',
      АдресДоставки: o.address || '',
      Оплачено: !!o.paid,
      ОплаченоНал: o.paymentCash || 0,
      ОплаченоQR: o.paymentQr || 0,
      Долг: o.paymentDebt || 0,
      Продавец: seller ? seller.name : '',
      Товары: o.items.map(it => { const p = product(it.productId); return { Наименование: it.name, Код: p ? (p.code1c || '') : '', Количество: it.qty, Цена: it.price, Сумма: it.sum }; })
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

// ---------- 1С импорт: спецификации ОБРАТНО (если состав поправили в 1С) ----------
// Ожидаемый формат входа: { items: [ { ownerCode, ownerName, components: [ {code, name, qty} ] } ] }
// ownerCode/code — это code1c соответствующего блюда/ингредиента на стороне SkyMeal.
// qty — то же самое число, что SkyMeal отдаёт в exportSpecs1c() (Количество) — то есть
// в граммах/мл-эквиваленте, если единица получателя кг/л (см. recipeCost: факт деления
// на 1000 идёт по единице ЦЕЛЕВОГО товара, не по тому, что прислала 1С).
function specsDiff(incoming) {
  const byCode = {};
  db.products.forEach(p => { if (p.code1c) byCode[p.code1c] = p; });
  const ownerNotFound = [];
  const changed = [];
  incoming.forEach(spec => {
    const ownerCode = String(spec.ownerCode || '').trim();
    const dish = byCode[ownerCode];
    if (!dish) { ownerNotFound.push({ code: ownerCode, name: spec.ownerName || '' }); return; }
    const curByProdId = {};
    (dish.recipe || []).forEach(it => { curByProdId[it.productId] = it; });
    const seenProdIds = new Set();
    const rowChanges = [];
    (spec.components || []).forEach(comp => {
      const code = String(comp.code || '').trim();
      const raw = code ? byCode[code] : null;
      if (!raw) { rowChanges.push({ type: 'componentNotFound', name: comp.name || '', code }); return; }
      seenProdIds.add(raw.id);
      const cur = curByProdId[raw.id];
      const newQty = +comp.qty || 0;
      if (!cur) rowChanges.push({ type: 'add', productId: raw.id, name: raw.name, qty: newQty });
      else if (Math.abs(cur.qty - newQty) > 0.001) rowChanges.push({ type: 'qty', productId: raw.id, name: raw.name, oldQty: cur.qty, newQty });
    });
    (dish.recipe || []).forEach(it => {
      if (!seenProdIds.has(it.productId)) {
        const p2 = product(it.productId);
        rowChanges.push({ type: 'removedIn1c', productId: it.productId, name: p2 ? p2.name : '?', qty: it.qty });
      }
    });
    if (rowChanges.length) changed.push({ dishId: dish.id, dishName: dish.name, dishCode: ownerCode, changes: rowChanges });
  });
  return { ownerNotFound, changed };
}
// применяет qty-изменения и добавления из последней (или явно переданной) сверки специф.
// НИЧЕГО не удаляет из рецепта автоматически — "removedIn1c" только показывается, но
// не применяется, чтобы правка в 1С по ошибке не срезала ингредиент молча.
function specsApply(diffData, user) {
  let dishesTouched = 0, qtyChanged = 0, added = 0, skippedRemovals = 0;
  (diffData.changed || []).forEach(row => {
    const dish = product(row.dishId);
    if (!dish) return;
    let touched = false;
    row.changes.forEach(ch => {
      if (ch.type === 'qty') {
        const it = dish.recipe.find(x => x.productId === ch.productId);
        if (it) { it.qty = ch.newQty; qtyChanged++; touched = true; }
      } else if (ch.type === 'add') {
        dish.recipe.push({ productId: ch.productId, qty: ch.qty, noteRaw: '', noteDone: '' });
        added++; touched = true;
      } else if (ch.type === 'removedIn1c') {
        skippedRemovals++;
      }
    });
    if (touched) {
      dishesTouched++;
      logRecipe(dish, user, 'обновлено из 1С (сверка спецификаций)');
    }
  });
  return { dishesTouched, qtyChanged, added, skippedRemovals };
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
    } catch (e) { console.error('[500]', req.method, u.pathname, e); json(res, 500, { error: e.message }); }
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

  // ---------- реалтайм-подтверждение оплаты из 1С (как в Жайыке): без логина, просто секрет ----------
  // 1С вызывает это СРАЗУ после того, как реально зарегистрировала оплату (провела кассовый/банковский документ) —
  // а не по кнопке "синхронизировать" раз в день. ref — это ИдSkyMeal вида "sale|o1cbei".
  if (p === '/api/1c/payment-confirm' && req.method === 'POST') {
    if (data.secret !== SYNC_SECRET) return json(res, 403, { error: 'Нет доступа' });
    const id = String(data.ref || '').replace(/^sale\|/, '');
    const rec = db.operations.find(o => o.id === id && o.type === 'sale');
    if (!rec) return json(res, 404, { error: 'Продажа не найдена: ' + data.ref });
    rec.paidAmount = r2(Math.min(rec.sum, +data.paidAmount || 0));
    rec.paid = !!data.paid || rec.paidAmount >= rec.sum - 0.001;
    rec.paymentDebt = r2(Math.max(0, rec.sum - rec.paidAmount));
    // 1С не разбивает нал/QR, поэтому фактическую сумму относим в нал, чтобы паритет с продажами сходился
    rec.paymentCash = r2(Math.max(rec.paymentCash || 0, rec.paidAmount - (rec.paymentQr || 0)));
    save();
    return json(res, 200, { id: rec.id, paidAmount: rec.paidAmount, paid: rec.paid });
  }

  // ---------- реалтайм: 1С сообщает, каким кодом контрагента она сматчила/создала клиента при проведении продажи —
  // без этого шага повторные продажи тому же клиенту снова уходили бы в 1С без кода и создавали дубль ----------
  if (p === '/api/1c/clients-resolve' && req.method === 'POST') {
    if (data.secret !== SYNC_SECRET) return json(res, 403, { error: 'Нет доступа' });
    const clientId = String(data.clientId || '');
    const code1c = String(data.code1c || '').trim();
    if (!clientId || !code1c) return json(res, 400, { error: 'Нужны clientId и code1c' });
    const c = db.clients.find(x => x.id === clientId);
    if (!c) return json(res, 404, { error: 'Клиент не найден: ' + clientId });
    c.code1c = code1c;
    save();
    return json(res, 200, { id: c.id, code1c: c.code1c });
  }

  // ---------- сверка документов с 1С (как в ГБ2): 1С отчитывается по каждому документу —
  // создан ли он реально, под каким номером, или была ошибка. Без этого сайт никогда не узнаёт,
  // дошёл ли конкретный документ до 1С или потерялся/не смог провестись. ----------
  if (p === '/api/1c/doc-status' && req.method === 'POST') {
    if (data.secret !== SYNC_SECRET) return json(res, 403, { error: 'Нет доступа' });
    const items = Array.isArray(data.items) ? data.items : (data.ref ? [data] : []);
    let updated = 0;
    items.forEach(it => {
      const ref = String(it.ref || '');
      if (!ref) return;
      db.docStatus[ref] = {
        status: it.status === 'created' ? 'created' : 'error', // 'created' | 'error'
        docNumber: it.docNumber || '',
        message: it.message || '',
        ts: new Date().toISOString()
      };
      updated++;
    });
    save();
    return json(res, 200, { updated });
  }

  // ---------- приём продаж из 1С (если пробивают сразу в 1С, минуя сайт) ----------
  // Перенесено на SYNC_SECRET (было на сессии isAdmin): вызывается автоматикой 1С,
  // а не человеком из браузера, поэтому не может зависеть от x-token — сессии живут
  // только в памяти и обнуляются при каждом pm2 restart.
  if (p === '/api/1c/sales-import' && req.method === 'POST') {
    if (data.secret !== SYNC_SECRET) return json(res, 403, { error: 'Нет доступа' });
    const sysUser = db.users.find(u => u.role === 'admin') || db.users[0];
    const incoming = data.items || [];
    const byCode = {};
    db.products.forEach(pr => { if (pr.code1c) byCode[pr.code1c] = pr; });
    const already = new Set(db.operations.filter(o => o.type === 'sale' && o.ref1c).map(o => o.ref1c));
    const created = [], skipped = [], notFound = [];
    incoming.forEach(item => {
      const ref = String(item.docNumber || '').trim();
      if (ref && already.has(ref)) { skipped.push(ref); return; }
      const code = String(item.code || '').trim();
      const pr = byCode[code];
      if (!pr) { notFound.push(code); return; }
      try {
        const rec = opSale({ productId: pr.id, qty: +item.qty || 0, price: item.price, client: item.client, paid: item.paid !== false });
        rec.id = nid('o'); rec.ts = new Date().toISOString(); rec.userId = sysUser ? sysUser.id : 'system'; rec.source = '1С'; rec.ref1c = ref || undefined;
        db.operations.push(rec);
        created.push(rec.id);
        if (ref) already.add(ref);
      } catch (e) {
        notFound.push(code + ' (' + e.message + ')');
      }
    });
    save();
    return json(res, 200, { created: created.length, skipped: skipped.length, errors: notFound });
  }

  // ---------- фактический долг контрагентов по 1С (счёт 1210) — для сравнения с тем, что считает сайт ----------
  // Тоже переведено на SYNC_SECRET по той же причине, что и sales-import выше.
  if (p === '/api/1c/debts-sync' && req.method === 'POST') {
    if (data.secret !== SYNC_SECRET) return json(res, 403, { error: 'Нет доступа' });
    const items = data.items || [];
    const byCode = {};
    items.forEach(it => { if (it.code) byCode[String(it.code).trim()] = { name: it.name || '', balance: r2(+it.balance || 0) }; });
    db.debts1c = { ts: new Date().toISOString(), byCode };
    save();
    return json(res, 200, { received: items.length });
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
      docStatus: isAdmin ? db.docStatus : undefined,
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

  // ---------- пользователи (PIN-коды) ----------
  const VALID_USER_ROLES = ['admin', 'tech', 'agent', 'cook', 'cook_prep', 'cook_sand', 'cook_hot', 'cook_baker', 'cook_pastry', 'cook_head'];
  if (p === '/api/users' && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, db.users.map(x => ({ id: x.id, name: x.name, role: x.role })));
  }
  if (p === '/api/users' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const name = String(data.name || '').trim();
    const newRole = String(data.role || '');
    const newPin = String(data.pin || '').trim();
    if (!name) return json(res, 400, { error: 'Введите имя' });
    if (!VALID_USER_ROLES.includes(newRole)) return json(res, 400, { error: 'Неверная роль' });
    if (!/^\d{4,8}$/.test(newPin)) return json(res, 400, { error: 'PIN — от 4 до 8 цифр' });
    if (db.users.some(u => u.pin === newPin)) return json(res, 400, { error: 'Такой PIN уже занят другим сотрудником' });
    const nu = { id: nid('u'), name, role: newRole, pin: newPin };
    db.users.push(nu); save();
    return json(res, 200, { id: nu.id, name: nu.name, role: nu.role });
  }
  const mUserPin = p.match(/^\/api\/users\/([^/]+)\/pin$/);
  if (mUserPin && req.method === 'PUT') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const target = db.users.find(x => x.id === mUserPin[1]);
    if (!target) return json(res, 404, { error: 'Не найден' });
    const newPin = String(data.pin || '').trim();
    if (!/^\d{4,8}$/.test(newPin)) return json(res, 400, { error: 'PIN — от 4 до 8 цифр' });
    target.pin = newPin;
    save();
    return json(res, 200, { ok: true });
  }

  // ---------- продукты ----------
  if (p === '/api/products' && req.method === 'POST') {
    const type = data.type || 'raw';
    if (!VALID_TYPES.includes(type)) return json(res, 400, { error: 'Неверный тип' });
    // Новую номенклатуру (сырьё) с сайта больше не заводим — только через 1С (сверка номенклатуры).
    // На сайте можно создавать только рецептуры (готовые блюда) из уже существующего сырья.
    if (type !== 'dish') {
      return json(res, 400, { error: 'Новое сырьё заводится только через 1С — сделайте сверку номенклатуры. На сайте можно создавать только рецептуры готовых блюд.' });
    }
    const np = {
      id: nid('p'), name: (data.name || '').trim(), type, unit: VALID_UNITS.includes(data.unit) ? data.unit : 'кг',
      priceKg: 0, sourceId: data.sourceId || null, code1c: isCook(role) ? '' : (data.code1c || ''),
      skladId: MAIN_SK, department: DEPARTMENTS.includes(data.department) ? data.department : departmentForType(type), salePrice: 0,
      recipe: (data.recipe || []).filter(it => it.qty > 0), recipeLog: [], lastCost: 0,
      wastePct: (type === 'raw' && +data.wastePct > 0 && +data.wastePct < 100) ? +data.wastePct : 0
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
    if (data.department !== undefined && DEPARTMENTS.includes(data.department)) pr.department = data.department;
    if (data.wastePct !== undefined) pr.wastePct = (pr.type === 'raw' && +data.wastePct > 0 && +data.wastePct < 100) ? +data.wastePct : 0;
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
    if (isAgent(role) && !['sale', 'waybill'].includes(data.type)) return json(res, 403, { error: 'Торговый/экспедитор может только оформлять продажу' });
    if (data.type === 'receipt' && isCook(role)) return json(res, 403, { error: 'Нет прав' });
    if (data.type === 'inventory' && !isAdmin) return json(res, 403, { error: 'Инвентаризацию проводит директор' });
    if (data.type === 'writeoff' && isCook(role)) return json(res, 403, { error: 'Акт списания оформляет менеджер или директор' });
    if (data.type === 'move') return json(res, 400, { error: 'Перемещение между складами отключено — теперь один физический склад' });
    if (data.type === 'sale' && isCook(role)) return json(res, 403, { error: 'Продажу оформляет менеджер или директор' });
    const fn = OPS[data.type];
    if (!fn) return json(res, 400, { error: 'Неизвестная операция' });
    const rec = fn(data, user);
    rec.id = nid('o'); rec.ts = new Date().toISOString(); rec.userId = user.id;
    db.operations.push(rec); save();
    const out = Object.assign({}, rec);
    if (!isAdmin) {
      delete out.writeoffs; delete out.costSum; delete out.profit;
      if (out.items && out.type === 'waybill') out.items = out.items.map(it => { const i2 = Object.assign({}, it); delete i2.costSum; if (!isAgent(role)) { delete i2.sum; delete i2.price; } return i2; });
      if (!isAgent(role)) { delete out.sum; delete out.price; }
    }
    return json(res, 200, out);
  }
  // ---------- отмена продажи/накладной: возвращает товар на склад, убирает из выручки/кассы/сверок с 1С.
  // Не удаляет запись — помечает cancelled, чтобы осталась в истории и не потерялся id для дедупа. ----------
  const mSaleCancel = p.match(/^\/api\/sales\/([^/]+)\/cancel$/);
  if (mSaleCancel && req.method === 'POST') {
    if (!isAdmin && role !== 'tech') return json(res, 403, { error: 'Отменить продажу может только директор/менеджер' });
    const rec = db.operations.find(o => o.id === mSaleCancel[1] && (o.type === 'sale' || o.type === 'waybill'));
    if (!rec) return json(res, 404, { error: 'Продажа не найдена' });
    if (rec.cancelled) return json(res, 400, { error: 'Уже отменена' });
    // вернуть товар на склад
    if (rec.type === 'sale') {
      const s = stockOf(rec.productId, rec.skladId);
      s.qty = r2(s.qty + rec.qty);
      s.value = r2(s.value + rec.costSum);
    } else if (rec.type === 'waybill' && Array.isArray(rec.items)) {
      rec.items.forEach(it => {
        const s = stockOf(it.productId, it.skladId);
        s.qty = r2(s.qty + it.qty);
        s.value = r2(s.value + it.costSum);
      });
    }
    rec.cancelled = true;
    rec.cancelledAt = new Date().toISOString();
    rec.cancelledBy = user.id;
    const ref = rec.type + '|' + rec.id;
    const already1c = db.docStatus[ref];
    save();
    return json(res, 200, { id: rec.id, cancelled: true, already1c: already1c || null });
  }
  const mSalePay = p.match(/^\/api\/sales\/([^/]+)\/pay$/);
  if (mSalePay && req.method === 'POST') {
    if (isCook(role)) return json(res, 403, { error: 'Нет прав' });
    const rec = db.operations.find(o => o.id === mSalePay[1] && o.type === 'sale');
    if (!rec) return json(res, 404, { error: 'Продажа не найдена' });
    if (rec.cancelled) return json(res, 400, { error: 'Продажа отменена' });
    if (isAgent(role) && rec.userId !== user.id) return json(res, 403, { error: 'Можно отмечать оплату только по своим продажам' });
    const add = r2(+data.amount || 0);
    if (!(add > 0)) return json(res, 400, { error: 'Сумма должна быть больше нуля' });
    const method = data.method === 'qr' ? 'qr' : 'cash'; // куда зачислить погашение долга
    const room = r2(rec.sum - rec.paidAmount); // сколько ещё можно принять
    const applied = r2(Math.min(add, room));
    if (method === 'qr') rec.paymentQr = r2((rec.paymentQr || 0) + applied);
    else rec.paymentCash = r2((rec.paymentCash || 0) + applied);
    rec.paidAmount = r2(Math.min(rec.sum, (rec.paidAmount || 0) + applied));
    rec.paymentDebt = r2(Math.max(0, rec.sum - rec.paidAmount));
    rec.paid = rec.paidAmount >= rec.sum - 0.001;
    save();
    return json(res, 200, { id: rec.id, paidAmount: rec.paidAmount, paid: rec.paid, paymentDebt: rec.paymentDebt });
  }
if (p === '/api/ops' && req.method === 'GET') {
    let ops = db.operations;
    const date = u.searchParams.get('date');
    const from = u.searchParams.get('from');
    const to = u.searchParams.get('to');
    const type = u.searchParams.get('type');
    const mine = isAgent(role) ? true : u.searchParams.get('mine'); // агент всегда видит только своё
    if (date) ops = ops.filter(o => o.ts.slice(0, 10) === date);
    if (from) ops = ops.filter(o => o.ts.slice(0, 10) >= from);
    if (to) ops = ops.filter(o => o.ts.slice(0, 10) <= to);
    if (type) ops = ops.filter(o => o.type === type);
    if (mine) ops = ops.filter(o => o.userId === user.id);
    ops = ops.slice(-500);
    // подмешиваем статус документа в 1С (если продажа/накладная уже была отправлена и 1С отчиталась)
    ops = ops.map(o => {
      if (o.type === 'sale' || o.type === 'waybill') {
        const ds = db.docStatus[o.type + '|' + o.id];
        return ds ? Object.assign({}, o, { docStatus: ds }) : o;
      }
      if (o.type === 'production') {
        const ref = 'prod|' + o.ts.slice(0, 10) + '|' + o.productId;
        const ds = db.docStatus[ref];
        return ds ? Object.assign({}, o, { docStatus: ds }) : o;
      }
      return o;
    });
    if (!isAdmin) ops = ops.map(o => {
      const c = Object.assign({}, o);
      delete c.writeoffs; delete c.costSum; delete c.profit; // себестоимость/прибыль — только директору
      if (c.items && c.type === 'waybill') c.items = c.items.map(it => { const i2 = Object.assign({}, it); delete i2.costSum; if (!isAgent(role)) { delete i2.sum; delete i2.price; } return i2; });
      if (!isAgent(role)) { delete c.sum; delete c.price; } // агенту сумма/цена нужны — это то, что он собирает с клиента
      return c;
    });
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

  // ---------- отчёты директору: единый экран выбора отчёта ----------
  if (p === '/api/reports/list' && req.method === 'GET') {
    if (!isAdmin && role !== 'tech') return json(res, 403, { error: 'Отчёты доступны директору' });
    // технологу — только производственная зона (остатки/потери/выработка/себестоимость),
    // продажи/долги/касса/по агентам — зона директора и агентов, технологу не нужна
    const TECH_REPORTS = ['stock', 'losses', 'output', 'costing'];
    const ids = isAdmin ? Object.keys(REPORTS) : TECH_REPORTS;
    return json(res, 200, ids.map(id => Object.assign({ id }, REPORTS[id])));
  }
  if (p === '/api/reports/run' && req.method === 'GET') {
    if (!isAdmin && role !== 'tech') return json(res, 403, { error: 'Отчёты доступны директору' });
    const type = u.searchParams.get('type');
    if (!isAdmin && !['stock', 'losses', 'output', 'costing'].includes(type)) {
      return json(res, 403, { error: 'Этот отчёт доступен только директору' });
    }
    const builder = REPORT_BUILDERS[type];
    if (!builder) return json(res, 400, { error: 'Неизвестный отчёт' });
    const from = u.searchParams.get('from') || null;
    const to = u.searchParams.get('to') || null;
    let report;
    try { report = builder(from, to, role); }
    catch (e) { return json(res, 500, { error: 'Ошибка построения отчёта: ' + e.message }); }
    if (u.searchParams.get('format') === 'csv') {
      const csv = reportToCsv(report);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + type + (from ? '_' + from : '') + (to ? '_' + to : '') + '.csv"'
      });
      return res.end(csv);
    }
    return json(res, 200, report);
  }

  // ---------- отчёты ----------
  if (p === '/api/report/costing') {
    if (!isAdmin) return json(res, 403, { error: 'Калькуляция доступна директору' });
    return json(res, 200, reportCosting());
  }
  if (p === '/api/report/losses') {
    if (!isAdmin) return json(res, 403, { error: 'Отчёт по потерям доступен директору' });
    return json(res, 200, reportLosses(u.searchParams.get('from'), u.searchParams.get('to')));
  }
  if (p === '/api/report/sales') {
    if (isCook(role) || isAgent(role)) return json(res, 403, { error: 'Отчёт по реализации недоступен' });
    return json(res, 200, reportSales(u.searchParams.get('from'), u.searchParams.get('to')));
  }
  // лёгкая аналитика "только моё" — для торгового/водителя, без доступа к общему отчёту компании
  if (p === '/api/report/my-sales') {
    const from = u.searchParams.get('from') || today();
    const to = u.searchParams.get('to') || today();
    const mine = db.operations.filter(o => o.type === 'sale' && !o.cancelled && o.userId === user.id && o.ts.slice(0, 10) >= from && o.ts.slice(0, 10) <= to);
    const totals = mine.reduce((a, o) => {
      a.revenue = r2(a.revenue + (o.sum || 0));
      a.cash = r2(a.cash + (o.paymentCash || 0));
      a.qr = r2(a.qr + (o.paymentQr || 0));
      a.debt = r2(a.debt + (o.paymentDebt || 0));
      a.count++;
      return a;
    }, { revenue: 0, cash: 0, qr: 0, debt: 0, count: 0 });
    return json(res, 200, { from, to, totals });
  }

  // ---------- нал на руках у агента + сдача выручки (инкассация) ----------
  function cashOnHand(userId) {
    const collected = db.operations
      .filter(o => o.type === 'sale' && !o.cancelled && o.userId === userId)
      .reduce((a, o) => a + (o.paymentCash || 0), 0);
    const handed = db.cashHandovers
      .filter(h => h.userId === userId)
      .reduce((a, h) => a + h.amount, 0);
    return r2(collected - handed);
  }
  if (p === '/api/cash/status' && req.method === 'GET') {
    if (isCook(role)) return json(res, 403, { error: 'Нет прав' });
    if (isAgent(role)) {
      return json(res, 200, { onHand: cashOnHand(user.id), history: db.cashHandovers.filter(h => h.userId === user.id).slice(-20).reverse() });
    }
    // директор/менеджер — сводка по всем, у кого есть продажи с наличными
    if (!isAdmin && role !== 'tech') return json(res, 403, { error: 'Нет прав' });
    const sellerIds = new Set(db.operations.filter(o => o.type === 'sale' && !o.cancelled && (o.paymentCash || 0) > 0).map(o => o.userId));
    const rows = Array.from(sellerIds).map(uid => {
      const u2 = db.users.find(x => x.id === uid);
      return { userId: uid, name: u2 ? u2.name : '?', onHand: cashOnHand(uid) };
    }).filter(r => Math.abs(r.onHand) > 0.01);
    return json(res, 200, { rows, history: db.cashHandovers.slice(-50).reverse() });
  }
  if (p === '/api/cash/handover' && req.method === 'POST') {
    if (isCook(role)) return json(res, 403, { error: 'Нет прав' });
    // агент сдаёт свою наличность; директор/менеджер может зафиксировать сдачу от чужого имени (userId в теле)
    const targetUserId = (isAdmin || role === 'tech') && data.userId ? data.userId : user.id;
    if (isAgent(role) && targetUserId !== user.id) return json(res, 403, { error: 'Можно сдавать только свою наличность' });
    const amount = r2(+data.amount || 0);
    if (!(amount > 0)) return json(res, 400, { error: 'Сумма должна быть больше нуля' });
    const onHand = cashOnHand(targetUserId);
    if (amount > onHand + 0.01) return json(res, 400, { error: 'На руках всего ' + onHand + ' ₸ — нельзя сдать больше' });
    const rec = { id: nid('ch'), userId: targetUserId, amount, note: (data.note || '').trim(), ts: new Date().toISOString(), by: user.name };
    db.cashHandovers.push(rec);
    save();
    return json(res, 200, { onHand: cashOnHand(targetUserId), record: rec });
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
  if (p === '/api/1c/specs-diff' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const result = specsDiff(incoming);
    db.lastSpecsDiff = Object.assign({ ts: new Date().toISOString(), totalIncoming: incoming.length }, result);
    save();
    return json(res, 200, result);
  }
  if (p === '/api/1c/specs-diff' && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, db.lastSpecsDiff || null);
  }
  if (p === '/api/1c/specs-apply' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const src = data.diff || db.lastSpecsDiff;
    if (!src) return json(res, 400, { error: 'Нет данных сверки — сначала запусти specs-diff' });
    const result = specsApply(src, user);
    db.lastSpecsDiff = null;
    save();
    return json(res, 200, result);
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
    // ---- подозрительная перепривязка по имени ----
    // Раньше nomenclature-apply тихо переписывал code1c товару, чей текущий код не встретился
    // в этой выгрузке 1С, если находил точное совпадение по имени с каким-то входящим товаром.
    // Это может молча привязать код НЕ ТОГО товара (человеческая ошибка/совпадение имён в 1С),
    // поэтому теперь такие случаи только показываются — применяются исключительно вручную,
    // через отдельное подтверждение (/api/1c/nomenclature-relink).
    const incomingByName = {};
    incoming.forEach(item => { incomingByName[String(item.name || '').trim().toLowerCase()] = item; });
    const staleCodeSuggestions = [];
    missingInOneC.forEach(m => {
      const cand = incomingByName[m.name.trim().toLowerCase()];
      if (cand) {
        staleCodeSuggestions.push({ productId: m.productId, ourName: m.name, oldCode: m.code1c, suggestedCode: cand.code, suggestedName: cand.name });
      }
    });
    const result = { matched: matched.length, matchedDetails: matched.filter(m => m.nameChanged), newInOneC, missingInOneC, staleCodeSuggestions };
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
    // allItems — полный список признанных позиций (code/qty/cost) для каждой из incoming,
    // которая нашлась в SkyMeal по коду. Нужен отдельно от mismatches: если количество уже
    // совпало (например, применили раньше без цены), позиция уйдёт в matchedSame и никогда
    // не попадёт в mismatches — а значит "Применить сверку" никогда не подтянет для неё цену,
    // если брать items только из mismatches. Поэтому "Применить сверку" применяет allItems целиком.
    const allItems = [];
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
      const cost1c = item.cost != null ? +item.cost || 0 : null;
      allItems.push({ code, qty: item.qty, cost: cost1c });
      if (Math.abs(diff) > 0.01) {
        mismatches.push({ productId: pr.id, name: pr.name, code, qty1c: item.qty, qtySkyMeal: ourQty, diff, cost: cost1c });
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
    const result = { matchedSame, mismatches, notInSkyMeal, notIn1c, allItems };
    db.lastStockDiff = Object.assign({ ts: new Date().toISOString(), totalIncoming: incoming.length }, result);
    save();
    return json(res, 200, result);
  }
  if (p === '/api/1c/stock-diff' && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, db.lastStockDiff || null);
  }

  // ---------- сверка реализации: 1С присылает {items:[{ref, docNumber, posted}]} по всем документам
  // РеализацияТоваровУслуг с заполненным ИдSkyMeal — сравниваем с тем, что должно быть по продажам/накладным.
  // Заодно самовосстанавливаем docStatus, если он завис "не подтверждено" (например, сайт был недоступен
  // в момент, когда 1С отправляла doc-status при создании) ----------
  if (p === '/api/1c/sales-diff' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const byRef = {};
    incoming.forEach(item => { if (item.ref) byRef[item.ref] = item; });
    const seenRefs = new Set();
    const matched = [];
    const notPosted = [];
    db.operations.filter(o => o.type === 'sale' || o.type === 'waybill').forEach(o => {
      const ref = o.type + '|' + o.id;
      const inc = byRef[ref];
      if (!inc) return; // разберём отдельно ниже как missingIn1c
      seenRefs.add(ref);
      db.docStatus[ref] = { status: 'created', docNumber: inc.docNumber || '', message: '', ts: new Date().toISOString() };
      const row = { ref, docNumber: inc.docNumber || '', sum: o.sum, client: o.client || '', ts: o.ts };
      if (inc.posted === false) notPosted.push(row); else matched.push(row);
    });
    const missingIn1c = [];
    db.operations.filter(o => (o.type === 'sale' || o.type === 'waybill') && !o.cancelled).forEach(o => {
      const ref = o.type + '|' + o.id;
      if (!byRef[ref]) missingIn1c.push({ ref, sum: o.sum, client: o.client || '', ts: o.ts, docStatus: db.docStatus[ref] || null });
    });
    const notInSkyMeal = incoming.filter(item => !seenRefs.has(item.ref) && !db.operations.some(o => (o.type + '|' + o.id) === item.ref));
    const result = { matched: matched.length, notPosted, missingIn1c, notInSkyMeal };
    db.lastSalesDiff = Object.assign({ ts: new Date().toISOString(), totalIncoming: incoming.length }, result);
    save();
    return json(res, 200, result);
  }
  if (p === '/api/1c/sales-diff' && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, db.lastSalesDiff || null);
  }

  // ---------- применение сверки остатков: подтягиваем факт из 1С на основной склад (is1cMain) ----------
  // Количество и учётную цену берём из 1С напрямую (item.cost) — не пытаемся высчитать цену
  // из уже имеющегося на сайте остатка: для товара, у которого на сайте остаток был 0,
  // unitCost() тоже вернёт 0, и сумма навсегда останется нулевой, даже если qty подтянулось.
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
      const factQty = +item.qty || 0;
      // цена из 1С, если прислана; иначе (старые вызовы БСЛ без cost) — как раньше, от текущего unitCost
      const cost1c = item.cost != null ? +item.cost || 0 : null;
      const uc = cost1c != null ? cost1c : unitCost(pr.id);
      const diff = r2(factQty - accountQty);
      const diffSum = r2(diff * uc);
      checkDiff(pr.id, factQty, accountQty);
      s.qty = factQty;
      s.value = cost1c != null ? r2(factQty * cost1c) : r2(Math.max(0, s.value + diffSum));
      if (cost1c != null && cost1c > 0) pr.lastCost = cost1c;
      rows.push({ productId: pr.id, skladId: mainSk.id, accountQty, factQty, diff, diffSum });
    });
    const total = r2(rows.reduce((a, r) => a + r.diffSum, 0));
    db.invHistory.unshift({ id: nid('iv'), ts: new Date().toISOString(), user: user.name, rows, total, source: '1С' });
    if (db.invHistory.length > 50) db.invHistory = db.invHistory.slice(0, 50);
    db.lastStockDiff = null;
    save();
    return json(res, 200, { applied: rows.length, total });
  }

  // ---------- сверка оплат: 1С присылает {items:[{ref, paid, paidAmount}]}, ref = ИдSkyMeal вида "sale|o1cbei" ----------
  // Деньги подтверждает касса/банк в 1С — это источник правды по факту оплаты.
  function findSaleByRef(ref) {
    const id = String(ref || '').replace(/^sale\|/, '');
    return db.operations.find(o => o.id === id && o.type === 'sale');
  }
  if (p === '/api/1c/payment-diff' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const mismatches = [];
    const notFound = [];
    let matchedSame = 0;
    incoming.forEach(item => {
      const rec = findSaleByRef(item.ref);
      if (!rec) { notFound.push({ ref: item.ref }); return; }
      const oursPaid = !!rec.paid;
      const oursAmount = r2(rec.paidAmount || 0);
      const theirsPaid = !!item.paid;
      const theirsAmount = r2(+item.paidAmount || 0);
      if (oursPaid === theirsPaid && Math.abs(oursAmount - theirsAmount) < 0.01) {
        matchedSame++;
      } else {
        const p2 = product(rec.productId);
        mismatches.push({
          ref: item.ref, saleId: rec.id, name: p2 ? p2.name : '?', client: rec.client, sum: rec.sum,
          skyMealPaid: oursPaid, skyMealAmount: oursAmount, oneCPaid: theirsPaid, oneCAmount: theirsAmount
        });
      }
    });
    const result = { matchedSame, mismatches, notFound };
    db.lastPaymentDiff = Object.assign({ ts: new Date().toISOString(), totalIncoming: incoming.length }, result);
    save();
    return json(res, 200, result);
  }
  if (p === '/api/1c/payment-diff' && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, db.lastPaymentDiff || null);
  }
  // применение сверки: подтягиваем факт оплаты из 1С (только по расхождениям из последней сверки, либо явным списком)
  if (p === '/api/1c/payment-apply' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || (db.lastPaymentDiff ? db.lastPaymentDiff.mismatches.map(m => ({ ref: m.ref, paid: m.oneCPaid, paidAmount: m.oneCAmount })) : []);
    let applied = 0;
    const errors = [];
    incoming.forEach(item => {
      const rec = findSaleByRef(item.ref);
      if (!rec) { errors.push(item.ref); return; }
      rec.paidAmount = r2(Math.min(rec.sum, +item.paidAmount || 0));
      rec.paid = !!item.paid || rec.paidAmount >= rec.sum - 0.001;
      applied++;
    });
    db.lastPaymentDiff = null;
    save();
    return json(res, 200, { applied, errors });
  }

  if (p === '/api/1c/nomenclature-apply' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const byCode = {};
    db.products.forEach(p => { if (p.code1c) byCode[p.code1c] = p; });
    // безопасное автосвязывание по имени — ТОЛЬКО для товаров, у которых кода вообще нет.
    // Перезаписывать уже существующий (пусть и устаревший) код по совпадению имени больше
    // не делаем автоматически — это может тихо привязать код НЕ ТОГО товара (см. staleCodeSuggestions
    // в /api/1c/nomenclature-diff и отдельный /api/1c/nomenclature-relink для ручного подтверждения).
    const byNameEmptyCode = {};
    db.products.forEach(p => {
      if (!p.code1c) byNameEmptyCode[p.name.trim().toLowerCase()] = p;
    });
    let updated = 0, created = 0, linked = 0;
    incoming.forEach(item => {
      const existing = byCode[item.code];
      if (existing) {
        if (existing.name !== item.name) { existing.name = item.name; updated++; }
        return;
      }
      const byName = byNameEmptyCode[String(item.name || '').trim().toLowerCase()];
      if (byName) { byName.code1c = item.code; linked++; return; }
      if (data.createMissing) {
        const nid2 = nid('p');
        db.products.push({ id: nid2, name: item.name, type: 'raw', unit: item.unit || 'г', priceKg: 0, sourceId: null, code1c: item.code, recipe: [], recipeLog: [], lastCost: 0, skladId: MAIN_SK, department: DEFAULT_DEPARTMENT });
        created++;
      }
    });
    db.lastNomenclatureDiff = null;
    save();
    return json(res, 200, { updated, created, linked });
  }

  // ---------- ручное подтверждение перепривязки кода (заменяет старую тихую авто-перепривязку) ----------
  // Директор явно видел staleCodeSuggestions на экране и подтвердил конкретные пары —
  // только тогда код меняется. items: [{productId, code}]
  if (p === '/api/1c/nomenclature-relink' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const items = data.items || [];
    let relinked = 0;
    const errors = [];
    items.forEach(it => {
      const pr = product(it.productId);
      if (!pr) { errors.push('Товар не найден: ' + it.productId); return; }
      pr.code1c = String(it.code || '').trim();
      relinked++;
    });
    db.lastNomenclatureDiff = null;
    save();
    return json(res, 200, { relinked, errors });
  }

  // ---------- клиенты (контрагенты): справочник + сверка с 1С, по тому же принципу что и номенклатура ----------
  if (p === '/api/clients' && req.method === 'GET') {
    if (isCook(role)) return json(res, 403, { error: 'Нет прав' });
    return json(res, 200, db.clients);
  }
  if (p === '/api/clients' && req.method === 'POST') {
    if (isCook(role)) return json(res, 403, { error: 'Нет прав' });
    const name = String(data.name || '').trim();
    if (!name) return json(res, 400, { error: 'Введите имя клиента' });
    // не плодим дубли и на своей стороне — если такое имя уже есть, отдаём существующего
    const existing = db.clients.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (data.address && !existing.address) { existing.address = String(data.address).trim(); save(); }
      return json(res, 200, existing);
    }
    const nc = { id: nid('cl'), name, code1c: '', address: (data.address || '').trim(), phone: (data.phone || '').trim() };
    db.clients.push(nc); save();
    return json(res, 200, nc);
  }
  const mClient = p.match(/^\/api\/clients\/([^/]+)$/);
  if (mClient && req.method === 'PUT') {
    if (isCook(role)) return json(res, 403, { error: 'Нет прав' });
    const c = db.clients.find(x => x.id === mClient[1]);
    if (!c) return json(res, 404, { error: 'Клиент не найден' });
    if (data.name !== undefined) c.name = String(data.name).trim();
    if (data.address !== undefined) c.address = String(data.address).trim();
    if (data.phone !== undefined) c.phone = String(data.phone).trim();
    save();
    return json(res, 200, c);
  }

  if (p === '/api/1c/clients-diff' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const byCode = {};
    db.clients.forEach(c => { if (c.code1c) byCode[c.code1c] = c; });
    const matched = [];
    const newInOneC = [];
    const missingInOneC = [];
    const seenCodes = new Set();
    incoming.forEach(item => {
      seenCodes.add(item.code);
      const existing = byCode[item.code];
      if (existing) {
        matched.push({ clientId: existing.id, ourName: existing.name, theirName: item.name, code: item.code, nameChanged: existing.name !== item.name });
      } else {
        newInOneC.push(item);
      }
    });
    db.clients.forEach(c => {
      if (c.code1c && !seenCodes.has(c.code1c)) {
        missingInOneC.push({ clientId: c.id, name: c.name, code1c: c.code1c });
      }
    });
    const result = { matched: matched.length, matchedDetails: matched.filter(m => m.nameChanged), newInOneC, missingInOneC };
    db.lastClientsDiff = Object.assign({ ts: new Date().toISOString(), totalIncoming: incoming.length }, result);
    save();
    return json(res, 200, result);
  }
  if (p === '/api/1c/clients-diff' && req.method === 'GET') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    return json(res, 200, db.lastClientsDiff || null);
  }

  if (p === '/api/1c/debts-sync' && req.method === 'GET') {
    if (!isAdmin && role !== 'tech') return json(res, 403, { error: 'Нет прав' });
    return json(res, 200, db.debts1c || null);
  }

  if (p === '/api/1c/clients-apply' && req.method === 'POST') {
    if (!isAdmin) return json(res, 403, { error: 'Только директор' });
    const incoming = data.items || [];
    const byCode = {};
    db.clients.forEach(c => { if (c.code1c) byCode[c.code1c] = c; });
    // также сматчим оставшиеся клиенты по точному имени — и без code1c, и с ЧУЖИМ/устаревшим
    // (например, от старой тестовой базы 1С), который не встречается в этой сверке.
    const incomingCodes = new Set(incoming.map(item => String(item.code || '')));
    const byNameNoCode = {};
    db.clients.forEach(c => {
      if (!c.code1c || !incomingCodes.has(c.code1c)) byNameNoCode[c.name.toLowerCase()] = c;
    });
    let updated = 0, created = 0, linked = 0;
    incoming.forEach(item => {
      const existing = byCode[item.code];
      if (existing) {
        if (existing.name !== item.name) { existing.name = item.name; updated++; }
        return;
      }
      const byName = byNameNoCode[String(item.name || '').trim().toLowerCase()];
      if (byName) { byName.code1c = item.code; linked++; return; }
      if (data.createMissing) {
        db.clients.push({ id: nid('cl'), name: item.name, code1c: item.code });
        created++;
      }
    });
    db.lastClientsDiff = null;
    save();
    return json(res, 200, { updated, created, linked });
  }

  json(res, 404, { error: 'not found' });
}

server.listen(PORT, () => console.log('SKY MEAL v5 запущен: http://localhost:' + PORT));
