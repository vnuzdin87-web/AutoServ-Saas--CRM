import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../database.mjs';
import { startServer } from '../server.mjs';

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'autoservice-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('пустая база создаётся с нуля, повторный запуск сохраняет данные', (t) => {
  const filename = join(temporaryDirectory(t), 'db.sqlite');
  const db = openDatabase(filename);
  try {
    for (const table of ['customers', 'vehicles', 'service_orders', 'order_items']) {
      assert.equal(db.prepare('SELECT count(*) AS count FROM ' + table).get().count, 0);
    }
    db.prepare('INSERT INTO customers (name) VALUES (?)').run('Кирилл Морозов');
  } finally {
    db.close();
  }

  const reopened = openDatabase(filename);
  try {
    assert.equal(reopened.prepare('SELECT name FROM customers').get().name, 'Кирилл Морозов');
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 2);
  } finally {
    reopened.close();
  }
});

test('наряд связан с автомобилем клиента, суммы и статусы ограничены схемой', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec(`
      INSERT INTO customers (id, name) VALUES (1, 'Кирилл Морозов'), (2, 'Елена Соколова');
      INSERT INTO vehicles (id, customer_id, model) VALUES (1, 1, 'Audi A4');
    `);
    const order = db.prepare(`
      INSERT INTO service_orders (id, number, customer_id, vehicle_id, advisor_name, promised_at, created_at)
      VALUES (1, 248, ?, 1, 'Денис Крылов', '2026-11-15T16:30:00+03:00', '2026-11-15T10:00:00Z')
    `);
    assert.throws(() => order.run(2), /FOREIGN KEY/);
    order.run(1);
    assert.throws(() => db.exec("UPDATE service_orders SET status = 'unknown'"), /CHECK/);

    const item = db.prepare("INSERT INTO order_items (service_order_id, kind, description, amount_kopecks) VALUES (1, 'labor', 'Диагностика', ?)");
    assert.throws(() => item.run(-1), /CHECK/);
    assert.throws(() => item.run(1.5), /INTEGER column/);
    item.run(180000);
    assert.equal(db.prepare('SELECT amount_kopecks FROM order_items').get().amount_kopecks, 180000);
  } finally {
    db.close();
  }
});

test('ошибка в миграции откатывает изменения и позволяет повторить запуск', (t) => {
  const directory = temporaryDirectory(t);
  const migrationFolder = join(directory, 'migrations');
  mkdirSync(migrationFolder);
  const migrationPath = pathToFileURL(migrationFolder + sep);
  copyFileSync(new URL('../migrations/001-initial.sql', import.meta.url), join(migrationFolder, '001-initial.sql'));
  const broken = join(migrationFolder, '002-extra.sql');
  const filename = join(directory, 'db.sqlite');
  openDatabase(filename, migrationPath).close();

  writeFileSync(broken, 'CREATE TABLE extra (id INTEGER); INVALID SQL;');
  assert.throws(() => openDatabase(filename, migrationPath), /syntax error/);

  const raw = new DatabaseSync(filename);
  try {
    assert.equal(raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'extra'").get(), undefined);
    assert.equal(raw.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
  } finally {
    raw.close();
  }

  writeFileSync(broken, 'CREATE TABLE extra (id INTEGER);');
  const recovered = openDatabase(filename, migrationPath);
  try {
    assert.equal(recovered.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 2);
  } finally {
    recovered.close();
  }
});

test('локальный сервер отдаёт утверждённые макеты и статус, файлы базы недоступны по HTTP', async (t) => {
  const server = await startServer({ port: 0, databasePath: ':memory:' });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  const origin = 'http://' + address + ':' + port;
  const [home, health, database, write] = await Promise.all([
    fetch(origin + '/'),
    fetch(origin + '/health'),
    fetch(origin + '/data/autoservice.sqlite'),
    fetch(origin + '/health', { method: 'POST' }),
  ]);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<title>АвтоСервис CRM<\/title>/);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(database.status, 404);
  assert.equal(write.status, 405);
});
