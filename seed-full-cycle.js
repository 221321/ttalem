#!/usr/bin/env node
/**
 * ПОЛНЫЙ ЦИКЛ, не только продажи: сырьё (через синхронизацию с 1С) → приход → рецепт
 * с % отхода → утверждение рецептуры → выпуск (списывает сырьё, производит блюдо) →
 * порча/списание → продажа экспедитором → сверка отчётов.
 *
 * Цель — не просто "накидать цифр", а реально прогнать каждый шаг через настоящий API
 * и на каждом шаге проверить ответ: если где-то в цепочке 400/500 или расчёт не сходится,
 * скрипт остановится с понятной ошибкой и покажет, на каком именно шаге и почему.
 *
 * После прогона проверьте глазами:
 *   Отчёты → Выработка          — должна показать выпуск ТЕСТ Лепёшка и % отхода по муке
 *   Отчёты → Потери и списания  — должна показать списание (порча) и обработку
 *   Отчёты → Калькуляция        — себестоимость ТЕСТ Лепёшка посчитана по рецепту, не 0
 *   Остатки                     — сырьё (мука/масло) уменьшилось, лепёшка появилась
 *   Продажи                     — как в первом скрипте, плюс теперь один из товаров с реальной
 *                                  (не нулевой) себестоимостью — маржа в отчётах будет настоящей
 *
 * Запуск:
 *   BASE_URL=https://ttalem.probuh.asia ADMIN_PIN=1234 node seed-full-cycle.js
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PIN = process.env.ADMIN_PIN;

if (!ADMIN_PIN) {
  console.error('Укажите PIN директора: ADMIN_PIN=1234 node seed-full-cycle.js');
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

function log(msg) { console.log('  ' + msg); }
function step(msg) { console.log('\n▶ ' + msg); }
function assert(cond, msg) { if (!cond) throw new Error('ПРОВЕРКА НЕ ПРОШЛА: ' + msg); }

async function main() {
  step('Логин директора');
  const adminLogin = await request('POST', '/api/login', { category: 'admin', pin: ADMIN_PIN });
  const adminToken = adminLogin.token;
  log('OK: ' + adminLogin.user.name);

  step('Сырьё через синхронизацию с 1С (как реально заводится сырьё на сайте)');
  const rawCode1 = 'TEST-MUKA', rawCode2 = 'TEST-MASLO';
  const nom = await request('POST', '/api/1c/nomenclature-apply', {
    createMissing: true,
    items: [
      { code: rawCode1, name: 'ТЕСТ Мука', unit: 'кг' },
      { code: rawCode2, name: 'ТЕСТ Масло', unit: 'кг' }
    ]
  }, adminToken);
  log('создано новых: ' + nom.created + ', связано по имени: ' + nom.linked);
  const boot1 = await request('GET', '/api/bootstrap', null, adminToken);
  const muka = boot1.products.find(p => p.code1c === rawCode1) || boot1.products.find(p => p.name === 'ТЕСТ Мука');
  const maslo = boot1.products.find(p => p.code1c === rawCode2) || boot1.products.find(p => p.name === 'ТЕСТ Масло');
  assert(muka && maslo, 'сырьё не нашлось после синхронизации');
  log('ТЕСТ Мука id=' + muka.id + ', ТЕСТ Масло id=' + maslo.id);

  step('% отхода на муке (10% — реалистичный отход при просеивании)');
  await request('PUT', '/api/products/' + muka.id, { wastePct: 10 }, adminToken);
  log('ТЕСТ Мука: wastePct=10');

  step('Приход сырья на склад');
  await request('POST', '/api/ops', { type: 'receipt', productId: muka.id, qty: 50, price: 300 }, adminToken);
  await request('POST', '/api/ops', { type: 'receipt', productId: maslo.id, qty: 20, price: 1200 }, adminToken);
  log('ТЕСТ Мука: +50 кг по 300₸ = 15000₸');
  log('ТЕСТ Масло: +20 кг по 1200₸ = 24000₸');

  step('Проверяю остаток сырья на складе после прихода');
  const stockAfterReceipt = await request('GET', '/api/report/stock', null, adminToken);
  const mukaStock = stockAfterReceipt.find(x => x.productId === muka.id);
  assert(mukaStock && Math.abs(mukaStock.qty - 50) < 0.01, 'остаток муки после прихода не 50 кг, а ' + (mukaStock ? mukaStock.qty : 'не найден'));
  log('OK: мука на складе = ' + mukaStock.qty + ' кг, себестоимость ' + mukaStock.value + '₸');

  step('Рецептура: ТЕСТ Лепёшка (200г муки + 20г масла на штуку)');
  const dish = await request('POST', '/api/products', {
    name: 'ТЕСТ Лепёшка', type: 'dish', unit: 'шт',
    recipe: [{ productId: muka.id, qty: 200 }, { productId: maslo.id, qty: 20 }]
  }, adminToken);
  log('создан продукт: ' + dish.name + ' (id=' + dish.id + ', статус рецепта: ' + dish.recipeStatus + ')');

  step('Утверждение рецептуры (без этого выпуск невозможен)');
  await request('POST', '/api/recipes/' + dish.id + '/status', { action: 'approve' }, adminToken);
  log('рецептура утверждена');

  step('Выпуск: 50 штук ТЕСТ Лепёшка');
  const prodOp = await request('POST', '/api/ops', { type: 'production', productId: dish.id, count: 50 }, adminToken);
  log('выпущено 50 шт, списано сырья на ' + prodOp.sum + '₸, себестоимость штуки ~' + (prodOp.sum / 50).toFixed(2) + '₸');

  step('Проверяю остаток муки после выпуска — с учётом 10% отхода должно списаться больше, чем по рецепту');
  const stockAfterProd = await request('GET', '/api/report/stock', null, adminToken);
  const mukaAfter = stockAfterProd.find(x => x.productId === muka.id);
  const expectedByRecipe = 50 * 0.2; // 200г * 50 шт = 10 кг по рецепту
  const expectedWithWaste = expectedByRecipe / (1 - 0.10); // с поправкой на 10% отхода
  const mukaUsed = 50 - mukaAfter.qty;
  assert(Math.abs(mukaUsed - expectedWithWaste) < 0.05, 'списание муки с учётом отхода не сходится: списано ' + mukaUsed.toFixed(2) + ' кг, ожидалось ~' + expectedWithWaste.toFixed(2) + ' кг');
  log('OK: списано ' + mukaUsed.toFixed(2) + ' кг муки (по рецепту было бы ' + expectedByRecipe + ' кг — разница это и есть 10% отход)');
  const dishStock = stockAfterProd.find(x => x.productId === dish.id);
  assert(dishStock && Math.abs(dishStock.qty - 50) < 0.01, 'на складе не 50 шт лепёшки, а ' + (dishStock ? dishStock.qty : 'не найдено'));
  log('OK: на складе ' + dishStock.qty + ' шт ТЕСТ Лепёшка, себестоимость партии ' + dishStock.value + '₸');

  step('Списание (порча) части сырья — для отчёта "Потери и списания"');
  await request('POST', '/api/ops', { type: 'writeoff', reason: 'ТЕСТ порча при хранении', items: [{ productId: maslo.id, qty: 1 }] }, adminToken);
  log('списано 1 кг ТЕСТ Масло, причина "порча при хранении"');

  step('Проверяю отчёт "Выработка" — должен показать выпуск и % отхода');
  const outputReport = await request('GET', '/api/reports/run?type=output&from=2020-01-01&to=2030-01-01', null, adminToken);
  const wasteRow = outputReport.tables[0].rows.find(r => r[0] === 'ТЕСТ Мука');
  const prodRow = outputReport.tables[1].rows.find(r => r[0] === 'ТЕСТ Лепёшка');
  assert(wasteRow, 'в отчёте "Выработка" нет строки отхода по муке — ждали, что появится');
  assert(prodRow && prodRow[2] === 50, 'в отчёте "Выработка" не 50 шт лепёшки, а ' + (prodRow ? prodRow[2] : 'ничего'));
  log('OK: отход по муке — ' + wasteRow[3] + ' ' + wasteRow[1] + ' (' + wasteRow[4] + '%)');
  log('OK: выпуск лепёшки — ' + prodRow[2] + ' шт на сумму ' + prodRow[3] + '₸');

  step('Проверяю отчёт "Потери и списания"');
  const lossesReport = await request('GET', '/api/reports/run?type=losses&from=2020-01-01&to=2030-01-01', null, adminToken);
  const writeoffSum = lossesReport.totals.find(t => t.label === 'Списано на сумму').value;
  assert(writeoffSum >= 1200, 'сумма списаний меньше ожидаемой (масло 1кг по 1200₸): ' + writeoffSum);
  log('OK: списано на сумму ' + writeoffSum + '₸ (масло, порча)');

  step('Проверяю отчёт "Калькуляция себестоимости"');
  const costingReport = await request('GET', '/api/reports/run?type=costing', null, adminToken);
  const costRow = costingReport.tables[0].rows.find(r => r[0] === 'ТЕСТ Лепёшка');
  assert(costRow, 'ТЕСТ Лепёшка нет в калькуляции');
  assert(costRow[4] > 0, 'себестоимость ТЕСТ Лепёшка равна 0 — рецепт не посчитался');
  log('OK: себестоимость ТЕСТ Лепёшка = ' + costRow[4] + '₸/шт (не ноль — рецепт реально посчитан)');

  step('Клиент и экспедитор — довожу до продажи, чтобы проверить весь путь целиком');
  const client = await request('POST', '/api/clients', { name: 'ТЕСТ Full-Cycle Магазин' }, adminToken);
  let users = await request('GET', '/api/users', null, adminToken);
  let agentUser = users.find(u => u.name === 'ТЕСТ Экспедитор-2');
  const agentPin = '990022';
  if (!agentUser) {
    agentUser = await request('POST', '/api/users', { name: 'ТЕСТ Экспедитор-2', role: 'agent', pin: agentPin }, adminToken);
  }
  const agentLogin = await request('POST', '/api/login', { category: 'agent', pin: agentPin });
  const agentToken = agentLogin.token;
  await request('POST', '/api/ops', { type: 'agent_issue', items: [{ productId: dish.id, qty: 20 }] }, agentToken);
  const saleRec = await request('POST', '/api/ops', {
    type: 'sale', productId: dish.id, qty: 10, price: 400, clientId: client.id, paymentCash: 4000, paymentQr: 0
  }, agentToken);
  log('продано 10 шт по 400₸ (себестоимость экспедитору намеренно не показывается — это фича, не баг)');
  step('Проверяю себестоимость этой продажи в отчёте директора (там она обязана быть видна)');
  const salesReportCheck = await request('GET', '/api/report/sales?from=2020-01-01&to=2030-01-01', null, adminToken);
  const saleRow = salesReportCheck.rows.find(r => r.id === saleRec.id);
  assert(saleRow, 'продажа не нашлась в отчёте директора');
  assert(saleRow.costSum > 0, 'себестоимость в отчёте директора всё равно 0 — вот тут уже реальный разрыв в цепочке');
  log('OK: в отчёте директора себестоимость этой продажи = ' + saleRow.costSum + '₸, прибыль ' + saleRow.profit + '₸');

  step('Финальная сверка: остаток лепёшки должен быть 50 - 20 (взял экспедитор) = 30 на складе');
  const finalStock = await request('GET', '/api/report/stock', null, adminToken);
  const dishFinal = finalStock.find(x => x.productId === dish.id);
  assert(Math.abs(dishFinal.qty - 30) < 0.01, 'на складе не 30 шт лепёшки, а ' + dishFinal.qty);
  log('OK: на складе осталось ' + dishFinal.qty + ' шт (30 ожидалось)');

  console.log('\n✅ ВЕСЬ ЦИКЛ ПРОШЁЛ БЕЗ ОШИБОК: сырьё → приход → рецепт → выпуск → списание → продажа.');
  console.log('   Каждый шаг проверен по факту (не просто "запрос не упал", а что цифры сошлись).');
  console.log('   Смотрите глазами: Отчёты → Выработка / Потери и списания / Калькуляция, Остатки, Продажи.');
}

main().catch(e => {
  console.error('\n❌ ' + e.message);
  process.exit(1);
});
