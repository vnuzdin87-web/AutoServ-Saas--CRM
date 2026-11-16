import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from './database.mjs';
import { handleApi } from './api.mjs';

const prototypePath = new URL('./index.html', import.meta.url);
const defaultDatabase = fileURLToPath(new URL('./data/autoservice.sqlite', import.meta.url));

export async function startServer({ port = 4178, databasePath = defaultDatabase } = {}) {
  const prototype = await readFile(prototypePath, 'utf8');
  const script = await readFile(new URL('./crm.js', import.meta.url));
  const db = openDatabase(databasePath);

  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');

    if (request.url?.startsWith('/api/v1/')) {
      void handleApi(db, request, response, new URL('http://localhost' + request.url));
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    const pathname = request.url?.split('?')[0];
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(prototype);
      return;
    }

    if (pathname === '/crm.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(script);
      return;
    }

    if (pathname === '/health') {
      let healthy;
      try {
        db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
        healthy = true;
      } catch {
        healthy = false;
      }
      response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: healthy ? 'ok' : 'unavailable' }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Страница не найдена.');
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    db.close();
    throw error;
  }

  server.once('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startServer();
    console.log('АвтоСервис CRM доступна по адресу http://127.0.0.1:' + server.address().port);
  } catch (error) {
    console.error('Не удалось запустить АвтоСервис CRM.', error);
    process.exitCode = 1;
  }
}
