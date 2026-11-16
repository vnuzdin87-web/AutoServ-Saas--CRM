import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboard } from '../api.mjs';
import { openDatabase } from '../database.mjs';
import { startServer } from '../server.mjs';

test('пустая главная возвращает нули и семь календарных дней через API', async (t) => {
  const server = await startServer({ port: 0, databasePath: ':memory:' });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/dashboard');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual([data.open, data.ready, data.overdue], [0, 0, 0]);
  assert.deepEqual([data.breakdown, data.upcoming, data.recent], [[], [], []]);
  assert.equal(data.intake.length, 7);
  assert.equal(data.intake.at(-1).day, data.today);
  assert(data.intake.every(({ count }) => count === 0));
});

test('главная учитывает московскую полночь, просрочку, статусы и порядок списков', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec(`
    INSERT INTO customers (id, name) VALUES (1, 'Кирилл Морозов');
    INSERT INTO vehicles (id, customer_id, model) VALUES (1, 1, 'Audi A4');
  `);
  const insert = db.prepare(`
    INSERT INTO service_orders (number, customer_id, vehicle_id, advisor_name, promised_at, created_at, status)
    VALUES (?, 1, 1, 'Денис Крылов', ?, ?, ?)
  `);
  insert.run(1, '2026-12-31T22:00:00+03:00', '2026-12-25T21:00:00Z', 'accepted');
  insert.run(2, '2027-01-01T02:00:00+03:00', '2026-12-31T21:00:00Z', 'ready');
  insert.run(3, '2027-01-01T01:30:00+03:00', '2026-12-31T20:59:59Z', 'in_progress');
  insert.run(4, '2026-12-31T20:00:00+03:00', '2026-12-25T20:59:59Z', 'closed');
  insert.run(5, '2027-01-01T01:00:00+03:00', '2026-12-31T21:25:00Z', 'closed');

  const data = dashboard(db, new Date('2026-12-31T21:30:00Z'));
  assert.equal(data.today, '2027-01-01');
  assert.deepEqual(data.intake.map(({ count }) => count), [1, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual([data.open, data.ready, data.overdue], [3, 1, 1]);
  assert.deepEqual(data.upcoming.map(({ number }) => number), [3, 2]);
  assert.deepEqual(data.recent.map(({ number }) => number), [5, 2, 3, 1, 4]);
  assert.equal(data.recent[0].master, 'Денис Крылов');
  assert.equal(data.upcoming[0].customer, 'Кирилл Морозов');
});
