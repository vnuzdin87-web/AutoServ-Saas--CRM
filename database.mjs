import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const migrationDirectory = new URL('./migrations/', import.meta.url);

export function openDatabase(filename, directory = migrationDirectory) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);

  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const filenames = readdirSync(directory).filter((name) => /^\d{3}-[a-z-]+\.sql$/.test(name)).sort();
    const existing = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'schema_migrations' AND type = 'table'").get();
    if (filename !== ':memory:' && existing) {
      const { count } = db.prepare('SELECT count(*) AS count FROM schema_migrations').get();
      if (count < filenames.length) db.prepare('VACUUM main INTO ?').run(filename + '.before-migration-' + randomUUID() + '.sqlite');
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          filename TEXT NOT NULL
        ) STRICT;
      `);
      const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY version').all();
      if (applied.some(({ filename }, index) => filename !== filenames[index])) {
        throw new Error('История миграций в базе отличается от файлов проекта.');
      }

      const record = db.prepare('INSERT INTO schema_migrations VALUES (?, ?)');
      for (const filename of filenames.slice(applied.length)) {
        db.exec(readFileSync(new URL(filename, directory), 'utf8'));
        record.run(filename.slice(0, 3), filename);
      }
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Нарушены связи в базе данных.');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
