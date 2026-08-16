#!/usr/bin/env node
/**
 * Тестовые данные через реальный API SKY MEAL — чтобы посмотреть, как выглядят экраны
 * "Продажи" / "Остатки" / "Ведомость по экспедитору" на реальных числах, а не на нулях.
 *
 * Идёт через настоящий /api/ops, поэтому остатки, себестоимость, деньги и все проверки
 * (checkDiff, стоп при нехватке склада и т.д.) считаются той же логикой, что и в бою —
 * никакого руками собранного JSON, который может разойтись с реальными полями.
 *
 * Что создаёт:
 *  - до 3 тестовых товаров типа "готовое блюдо" (если в каталоге и так есть dish/bread — берёт их)
 *  - остаток на складе по ним (через инвентаризацию)
 *  - тестового экспедитора "ТЕСТ Экспедитор" (если такого ещё нет)
 *  - 3 тестовых клиента ("ТЕСТ ...")
 *  - "взял с собой" — экспедитор берёт часть склада на борт
 *  - несколько продаж/накладных по разным клиентам (нал/QR/долг вперемешку)
 *  - один обмен по сроку годности (возврат)
 *  - частичную сдачу остатка — чтобы в "Ведомости" было видно расхождение
 *
 * Все тестовые сущности помечены префиксом "ТЕСТ" — их легко найти и удалить руками
 * (через "Доступы" -> удалить пользователя, через список клиентов, через отмену продаж).
 *
 * Запуск:
 *   BASE_URL=https://ttalem.probuh.asia ADMIN_PIN=1234 node seed-test-data.js
 *   (локально: BASE_URL=http://localhost:3000 ADMIN_PIN=1234 node seed-test-data.js)
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PIN = process.env.ADMIN_PIN;

if (!ADMIN_PIN) {
  console.error('Укажите PIN директора: ADMIN_PIN=1234 node seed-test-data.js');
  process.exit(1);
}

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers['x-token'] = token;
    const req = lib.request(url, { method, headers }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : {}; } catch (e) { parsed = { raw: chunks }; }
        if (res.statusCode >= 400) reject(new Error(method + ' ' + path + ' -> ' + res.statusCode + ': ' + (parsed.error || chunks)));
        else resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function pick(n) { return Math.round(Math.random() * n); }
function log(msg) { console.log('  ' + msg); }
function step(msg) { console.log('\n▶ ' + msg); }

async function main() {
  step('Логин директора');
  const adminLogin = await request('POST', '/api/login', { category: 'admin', pin: ADMIN_PIN });
  const adminToken = adminLogin.token;
  log('OK: ' + adminLogin.user.name);

  step('Ищу товары типа "готовое блюдо"/"хлеб" в каталоге');
  let boot = await request('GET', '/api/bootstrap', null, adminToken);
  let products = boot.products;
  let dishes = products.filter(p => (p.type === 'dish' || p.type === 'bread'));

  if (dishes.length < 2) {
    log('В каталоге мало готовой продукции — создаю пару тестовых позиций');
    const testNames = ['ТЕСТ Плов', 'ТЕСТ Лаваш', 'ТЕСТ Самса'];
    for (const name of testNames) {
      if (dishes.some(d => d.name === name)) continue;
      const np = await request('POST', '/api/products', { name, type: 'dish', unit: 'шт', recipe: [] }, adminToken);
      dishes.push(np);
      log('создан продукт: ' + name);
    }
  }
  dishes = dishes.slice(0, 3);
  log('Буду использовать: ' + dishes.map(d => d.name).join(', '));

  step('Ставлю остаток на складе (инвентаризация)');
  const qtyPlan = [80, 60, 40];
  const invItems = dishes.map((d, i) => ({ productId: d.id, skladId: null, factQty: qtyPlan[i] || 30 }));
  await request('POST', '/api/ops', { type: 'inventory', items: invItems }, adminToken);
  dishes.forEach((d, i) => log(d.name + ': ' + (qtyPlan[i] || 30) + ' ' + (d.unit || '')));

  step('Создаю тестовых клиентов (магазины)');
  const clientNames = ['ТЕСТ Aksatrade', 'ТЕСТ Coffee Point', 'ТЕСТ Продукты у дома'];
  const clients = [];
  for (const name of clientNames) {
    const c = await request('POST', '/api/clients', { name, address: 'г. Шымкент, тестовый адрес' }, adminToken);
    clients.push(c);
    log('клиент: ' + c.name);
  }

  step('Экспедитор для теста');
  let users = await request('GET', '/api/users', null, adminToken);
  let agentUser = users.find(u => u.name === 'ТЕСТ Экспедитор');
  let agentPin = '990011';
  if (!agentUser) {
    if (users.some(u => u.pin === agentPin)) agentPin = String(900000 + pick(99999));
    agentUser = await request('POST', '/api/users', { name: 'ТЕСТ Экспедитор', role: 'agent', pin: agentPin }, adminToken);
    log('создан агент: ' + agentUser.name + ' (PIN ' + agentPin + ')');
  } else {
    log('использую существующего: ' + agentUser.name + ' — PIN не знаю, узнайте в "Доступы" или пересоздайте с другим именем');
  }

  step('Логин экспедитора');
  const agentLogin = await request('POST', '/api/login', { category: 'agent', pin: agentPin });
  const agentToken = agentLogin.token;
  log('OK: ' + agentLogin.user.name);

  step('"Взял с собой" — экспедитор забирает часть склада на борт');
  const loadPlan = dishes.map((d, i) => ({ productId: d.id, qty: Math.round((qtyPlan[i] || 30) * 0.6) }));
  await request('POST', '/api/ops', { type: 'agent_issue', items: loadPlan }, agentToken);
  loadPlan.forEach((l, i) => log(dishes[i].name + ': взял ' + l.qty));

  step('Продажи по нескольким магазинам (нал / QR / долг вперемешку)');
  const salePlan = [
    { client: clients[0], product: dishes[0], qty: 5, price: 1500, cash: 7500, qr: 0 },     // полностью нал
    { client: clients[1], product: dishes[1] || dishes[0], qty: 8, price: 900, cash: 0, qr: 7200 }, // полностью QR
    { client: clients[2], product: dishes[0], qty: 4, price: 1500, cash: 3000, qr: 0 },     // частичный долг (2000 в долг)
    { client: clients[1], product: dishes[2] || dishes[0], qty: 3, price: 1200, cash: 3600, qr: 0 }, // полностью нал
    { client: clients[0], product: dishes[1] || dishes[0], qty: 6, price: 900, cash: 0, qr: 0 }      // полный долг
  ];
  for (const s of salePlan) {
    const rec = await request('POST', '/api/ops', {
      type: 'sale', productId: s.product.id, qty: s.qty, price: s.price,
      clientId: s.client.id, paymentCash: s.cash, paymentQr: s.qr
    }, agentToken);
    const total = s.qty * s.price, paid = s.cash + s.qr;
    log(s.client.name + ' — ' + s.product.name + ' × ' + s.qty + ' = ' + total + '₸' + (paid < total ? ' (долг ' + (total - paid) + '₸)' : ' (оплачено)'));
  }

  step('Накладная (несколько позиций одним документом)');
  if (dishes.length >= 2) {
    await request('POST', '/api/ops', {
      type: 'waybill', clientId: clients[2].id, address: clients[2].address,
      items: [
        { productId: dishes[0].id, qty: 2, price: 1500 },
        { productId: dishes[1].id, qty: 3, price: 900 }
      ],
      paymentCash: 5700, paymentQr: 0
    }, agentToken);
    log(clients[2].name + ' — накладная на 2 позиции, оплачено полностью');
  }

  step('Обмен по сроку годности (возврат на точке)');
  await request('POST', '/api/ops', {
    type: 'exchange', productId: dishes[0].id, qtyOut: 2, qtyBack: 2, client: clients[0].name
  }, agentToken);
  log(clients[0].name + ' — обменяли 2 ' + dishes[0].name + ' (просрочка вернулась, копится до списания)');

  step('Частичная сдача остатка (чтобы в ведомости было видно расхождение)');
  const myStock = await request('GET', '/api/agent/mystock', null, agentToken);
  if (myStock.length) {
    const returnItems = myStock.map(x => ({ productId: x.productId, factQty: r2f(x.qty * 0.5) }));
    await request('POST', '/api/ops', { type: 'agent_return', items: returnItems }, agentToken);
    log('сдал примерно половину остатка — вторая половина умышленно "потеряна" для наглядности расхождения');
  }

  console.log('\n✅ Готово. Смотрите:');
  console.log('   Продажи — там же фильтры "По клиентам" / "По товару"');
  console.log('   Остатки — три тестовых товара с новым количеством');
  console.log('   Продажи → Ведомость по экспедитору → "ТЕСТ Экспедитор" за сегодня');
  console.log('\nЧтобы убрать тестовые данные: удалите пользователя "ТЕСТ Экспедитор" в "Доступы",');
  console.log('отмените тестовые продажи в "Продажи" (кнопка ✕ у каждой), тестовых клиентов и товары можно оставить или удалить вручную.');
}

function r2f(x) { return Math.round((+x || 0) * 100) / 100; }

main().catch(e => {
  console.error('\n❌ Ошибка: ' + e.message);
  process.exit(1);
});
