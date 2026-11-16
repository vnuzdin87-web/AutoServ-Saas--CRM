import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../database.mjs';
import { startServer } from '../server.mjs';

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'autoservice-mvp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('миграция сохраняет заказ, смету, клиента и исходный файл со старой схемой', (t) => {
  const directory = temporaryDirectory(t);
  const legacy = join(directory, 'migrations');
  mkdirSync(legacy);
  copyFileSync(new URL('../migrations/001-initial.sql', import.meta.url), join(legacy, '001-initial.sql'));
  const filename = join(directory, 'crm.sqlite');
  const old = openDatabase(filename, pathToFileURL(legacy + sep));
  try {
    old.exec(`
      INSERT INTO customers (id, name) VALUES (2, 'Исходный клиент');
      INSERT INTO vehicles (id, customer_id, model) VALUES (3, 2, 'Lada Vesta');
      INSERT INTO service_orders (id, number, customer_id, vehicle_id, advisor_name, promised_at, created_at, status)
      VALUES (4, 10, 2, 3, 'Исходный мастер', '2026-11-17T16:00:00+03:00', '2026-11-16T09:00:00Z', 'ready');
      INSERT INTO order_items (service_order_id, kind, description, amount_kopecks) VALUES (4, 'labor', 'Работа', 32100);
    `);
  } finally { old.close(); }
  const migrated = openDatabase(filename);
  try {
    const master = migrated.prepare('SELECT name FROM masters JOIN service_orders o ON o.master_id = masters.id').get();
    assert.equal(master.name, 'Исходный мастер');
    assert.equal(migrated.prepare('SELECT imported FROM order_status_history').get().imported, 1);
    assert.equal(migrated.prepare('SELECT amount_kopecks FROM order_items').get().amount_kopecks, 32100);
    assert.equal(migrated.prepare('PRAGMA foreign_key_check').get(), undefined);
  } finally { migrated.close(); }
  const snapshot = readdirSync(directory).find((name) => name.includes('.before-migration-'));
  assert(snapshot);
  const backup = new DatabaseSync(join(directory, snapshot), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
    assert.equal(backup.prepare('SELECT number FROM service_orders').get().number, 10);
  } finally { backup.close(); }
});

test('20 000 ₽, два платежа, долг, завершение, резервная копия и повторный запуск', async (t) => {
  const directory = temporaryDirectory(t);
  const databasePath = join(directory, 'crm.sqlite');
  let server;
  const start = async () => { server = await startServer({ port: 0, databasePath }); };
  const close = () => new Promise((resolve) => server.close(resolve));
  const http = (path, method, body) => fetch('http://127.0.0.1:' + server.address().port + '/api/v1' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const request = async (path, method, body, status = 200) => {
    const response = await http(path, method, body);
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };

  try {
    await start();
    const client = await request('/customers', 'POST', { name: 'Пётр Тестов' }, 201);
    const vehicleInput = { customerId: client.id, make: 'Toyota', model: 'Camry', plate: 'А123ВС 77', vin: 'JTNB11HK103123456' };
    const vehicle = await request('/vehicles', 'POST', vehicleInput, 201);
    await request('/vehicles', 'POST', vehicleInput, 409);
    const changedVehicle = await request('/vehicles/' + vehicle.id, 'PATCH', { ...vehicleInput, plate: 'А124ВС 77' });
    assert.equal(changedVehicle.plate, 'А124ВС 77');
    for (const query of [vehicleInput.vin.toLowerCase(), 'toyota camry', 'а124вс77']) {
      assert.equal((await request('/vehicles?q=' + encodeURIComponent(query)))[0].id, vehicle.id);
    }
    const masterInput = { name: 'Антон Мастер', phone: '+7 900 000-01-02', specialty: 'Электрика', active: true };
    const master = await request('/masters', 'POST', masterInput, 201);
    const input = {
      customerId: client.id, vehicleId: vehicle.id, masterId: master.id, status: 'accepted', due: '2027-01-10T15:00',
      items: [{ kind: 'labor', description: 'Ремонт', amountKopecks: 2_000_000 }],
    };
    const order = await request('/orders', 'POST', input, 201);
    const path = '/orders/' + order.id;
    assert.equal(order.debt, 2_000_000);
    await request('/masters/' + master.id, 'PATCH', { ...masterInput, active: false });
    await request('/orders', 'POST', input, 400);

    const advance = { amountKopecks: 500_000, note: 'Предоплата', requestId: 'advance' };
    const paid = await request(path + '/payments', 'POST', advance, 201);
    assert.equal(paid.debt, 1_500_000);
    assert.equal((await request(path + '/payments', 'POST', advance, 201)).payments.length, 1);
    await request(path + '/payments', 'POST', { amountKopecks: 1_500_001 }, 409);
    await request(path, 'PATCH', { ...input, status: 'cancelled' }, 409);
    await request(path, 'PATCH', { ...input, items: [] }, 409);
    assert.equal((await request('/finance?debtors=1&q=' + encodeURIComponent('тестов'))).orders[0].debt, 1_500_000);
    assert.equal((await request('/dashboard')).totalDebt, 1_500_000);
    await request(path, 'PATCH', { ...input, status: 'in_progress' });
    await request(path, 'PATCH', { ...input, status: 'ready' });
    assert.equal((await request(path + '/payments', 'POST', { amountKopecks: 1_500_000, requestId: 'balance' }, 201)).debt, 0);
    const closed = await request(path, 'PATCH', { ...input, status: 'closed' });
    assert.deepEqual(closed.history.map((entry) => entry.toStatus), ['closed', 'ready', 'in_progress', 'accepted']);
    assert.equal((await request('/vehicles/' + vehicle.id)).orders[0].id, order.id);
    assert.equal((await request('/masters/' + master.id)).orders[0].id, order.id);
    await request('/masters/' + master.id, 'PATCH', masterInput);
    const second = await request('/orders', 'POST', input, 201);
    assert.equal((await request('/orders/' + second.id, 'PATCH', { ...input, status: 'cancelled' })).debt, 0);

    assert.equal((await request('/finance?debtors=1')).orders.length, 0);
    assert.equal((await request('/finance')).received, 2_000_000);
    assert.equal((await request('/dashboard')).receivedToday, 2_000_000);
    assert.equal((await request('/dashboard')).open, 0);
    await request('/settings', 'PATCH', { name: 'Тестовый сервис', phone: '+7 900 000-00-03', address: 'Москва' });
    const response = await http('/backup');
    assert.equal(response.headers.get('content-type'), 'application/vnd.sqlite3');
    const file = Buffer.from(await response.arrayBuffer()).toString('base64');
    await request('/backup/check', 'POST', { file: 'bm90LXNxbGl0ZQ==' }, 400);
    const check = await request('/backup/check', 'POST', { file });
    assert.equal(check.payments, 2);
    await request('/settings', 'PATCH', { name: 'После снимка' });
    await request('/backup/restore', 'POST', { file, token: 'wrong' }, 400);
    assert.equal((await request('/settings')).name, 'После снимка');
    assert.equal((await request('/backup/restore', 'POST', { file, token: check.token })).restored, true);
    assert(readdirSync(directory).some((name) => name.includes('.before-restore-')));
    await close();
    await start();
    assert.equal((await request('/settings')).name, 'Тестовый сервис');
    const restored = await request(path);
    assert.equal(restored.status, 'closed');
    assert.equal(restored.debt, 0);
    assert.equal(restored.payments.length, 2);
    assert.deepEqual(restored.history, closed.history);
  } finally {
    if (server?.listening) await close();
  }
});
