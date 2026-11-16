import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../server.mjs';

test('приёмка, смета, статусы, карточка клиента и сохранение после перезапуска', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'autoservice-orders-'));
  const databasePath = join(directory, 'orders.sqlite');
  let server;
  const start = async () => { server = await startServer({ port: 0, databasePath }); };
  const close = () => new Promise((resolve) => server.close(resolve));
  const request = async (path, method, body, status = 200) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const input = {
    customer: 'Кирилл Морозов', car: 'Audi A4', plate: 'М482СК 77',
    master: 'Денис Крылов', due: '2026-11-17T16:30', status: 'accepted',
    items: [{ kind: 'labor', description: 'Замена масла', amountKopecks: 290050 }],
  };
  try {
    await start();
    assert.deepEqual(await request('/orders'), []);
    await request('/orders', 'POST', { ...input, due: '2026-02-30T16:30' }, 400);
    await request('/orders', 'POST', { ...input, status: 'closed' }, 400);
    const created = await request('/orders', 'POST', input, 201);
    assert.equal(created.total, 290050);
    assert.equal(created.due, '2026-11-17T16:30:00+03:00');
    const path = '/orders/' + created.id;
    const assignment = { customerId: created.customerId, vehicleId: created.vehicleId };
    await request(path, 'PATCH', { ...input, ...assignment, status: 'closed' }, 409);
    const other = await request('/customers', 'POST', { name: 'Другой клиент' }, 201);
    await request(path, 'PATCH', { ...input, ...assignment, customerId: other.id }, 400);
    assert.deepEqual(await request(path), created);
    for (const status of ['waiting_parts', 'in_progress', 'ready', 'closed']) {
      const updated = await request(path, 'PATCH', { ...input, ...assignment, status });
      assert.equal(updated.status, status);
      assert.equal(updated.total, 290050);
    }
    await request(path, 'PATCH', { ...input, ...assignment, status: 'ready' }, 409);
    const filtered = await request('/orders?status=closed&q=' + encodeURIComponent('МОРОЗОВ'));
    assert.equal(filtered.length, 1);
    assert.deepEqual(await request('/orders?status=accepted'), []);
    const cardPath = '/customers/' + created.customerId;
    const card = await request(cardPath, 'PATCH', { name: input.customer, phone: '+7 900 000-00-00' });
    assert.equal(card.orders[0].status, 'closed');
    assert.equal(card.vehicles[0].id, created.vehicleId);
    await close();
    await start();
    assert.equal((await request(cardPath)).phone, '+7 900 000-00-00');
    assert.equal((await request(path)).items[0].amountKopecks, 290050);
  } finally {
    if (server?.listening) await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
