import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const tables = [
  'customers', 'vehicles', 'masters', 'service_orders', 'order_items',
  'order_status_history', 'payments', 'service_settings',
];

function temporaryFile(action) {
  const directory = mkdtempSync(join(tmpdir(), 'autoservice-backup-'));
  try {
    return action(join(directory, 'autoservice.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function makeBackup(db) {
  return temporaryFile((filename) => {
    db.prepare('VACUUM main INTO ?').run(filename);
    return readFileSync(filename);
  });
}

function schema(db) {
  return JSON.stringify(db.prepare(`
    SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all());
}

function versions(db) {
  return JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all());
}

export function withVerifiedBackup(db, encoded, action) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Выберите файл резервной копии SQLite.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_BACKUP_BYTES || bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') {
    throw new Error('Файл должен быть резервной копией SQLite размером до 16 МБ.');
  }
  return temporaryFile((filename) => {
    writeFileSync(filename, bytes);
    let copy;
    let summary;
    try {
      copy = new DatabaseSync(filename, { readOnly: true });
      copy.exec('PRAGMA trusted_schema = OFF');
      if (schema(copy) !== schema(db) || versions(copy) !== versions(db)
        || copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
        || copy.prepare('PRAGMA foreign_key_check').get()) {
        throw new Error('invalid');
      }
      const malformedOrder = copy.prepare(`
        SELECT 1 FROM service_orders o
        WHERE julianday(o.created_at) IS NULL OR julianday(o.promised_at) IS NULL
          OR o.status IS NOT (SELECT h.to_status FROM order_status_history h WHERE h.order_id = o.id ORDER BY h.id DESC LIMIT 1)
          OR (SELECT coalesce(sum(amount_kopecks), 0) FROM payments WHERE order_id = o.id) >
             (SELECT coalesce(sum(amount_kopecks), 0) FROM order_items WHERE service_order_id = o.id)
      `).get();
      if (malformedOrder || copy.prepare('SELECT 1 FROM payments WHERE julianday(paid_at) IS NULL').get()
        || copy.prepare('SELECT 1 FROM order_status_history WHERE julianday(changed_at) IS NULL').get()
        || copy.prepare('SELECT count(*) AS count FROM service_settings').get().count !== 1) {
        throw new Error('invalid');
      }
      summary = Object.fromEntries(['customers', 'vehicles', 'masters', 'service_orders', 'payments'].map((table) =>
        [table, copy.prepare('SELECT count(*) AS count FROM ' + table).get().count]));
    } catch {
      throw new Error('Копия повреждена или создана другой версией CRM.');
    } finally {
      copy?.close();
    }
    const token = createHash('sha256').update(bytes).digest('hex');
    return action(filename, { ...summary, token });
  });
}

export function restoreBackup(db, filename) {
  const livePath = db.location('main');
  const safetyCopy = livePath ? livePath + '.before-restore-' + randomUUID() + '.sqlite' : null;
  if (safetyCopy) db.prepare('VACUUM main INTO ?').run(safetyCopy);
  db.prepare('ATTACH DATABASE ? AS backup').run(filename);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of [...tables].reverse()) db.exec('DELETE FROM main.' + table);
      for (const table of tables) {
        if (table === 'order_status_history') db.exec('DELETE FROM main.order_status_history');
        db.exec('INSERT INTO main.' + table + ' SELECT * FROM backup.' + table);
      }
      if (db.prepare('PRAGMA main.foreign_key_check').get()) throw new Error('Нарушены связи в резервной копии.');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.exec('DETACH DATABASE backup');
  }
}
