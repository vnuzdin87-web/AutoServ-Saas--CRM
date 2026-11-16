import { randomUUID } from 'node:crypto';
import { MAX_BACKUP_BYTES, makeBackup, restoreBackup, withVerifiedBackup } from './backup.mjs';

const transitions = {
  accepted: ['in_progress', 'waiting_parts', 'cancelled'],
  in_progress: ['waiting_parts', 'ready', 'cancelled'],
  waiting_parts: ['in_progress', 'cancelled'],
  ready: ['in_progress', 'closed', 'cancelled'],
  closed: [],
  cancelled: [],
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function invalid(message) {
  throw new ApiError(400, message);
}

function string(value, label, max, required = false) {
  if (!required && value == null) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    invalid('Проверьте поле «' + label + '». Максимум символов: ' + max + '.');
  }
  return value.trim();
}

function id(value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid('Некорректный идентификатор.');
  return value;
}

function orderInput(body) {
  const local = body.due;
  if (typeof local !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)) {
    invalid('Укажите дату и время выдачи.');
  }
  const date = new Date(local + ':00Z');
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 16) !== local) {
    invalid('Проверьте дату и время выдачи.');
  }
  if (!Object.hasOwn(transitions, body.status)) invalid('Выберите допустимый статус.');
  if (!Array.isArray(body.items) || body.items.length > 100) invalid('В смете допустимо до 100 позиций.');
  const items = body.items.map((item) => {
    if (!item || !['labor', 'part'].includes(item.kind) || !Number.isSafeInteger(item.amountKopecks)
      || item.amountKopecks < 0 || item.amountKopecks > 100_000_000_00) {
      invalid('Проверьте вид позиции и сумму сметы.');
    }
    return { kind: item.kind, description: string(item.description, 'Описание позиции', 200, true), amountKopecks: item.amountKopecks };
  });
  const customerId = body.customerId == null ? null : id(body.customerId);
  const vehicleId = body.vehicleId == null ? null : id(body.vehicleId);
  if (vehicleId && !customerId) invalid('Выберите владельца автомобиля.');
  return {
    customerId, vehicleId, items,
    customer: customerId ? '' : string(body.customer, 'Клиент', 150, true),
    car: vehicleId ? '' : string(body.car, 'Автомобиль', 150, true),
    plate: string(body.plate, 'Госномер', 24),
    masterId: body.masterId == null ? null : id(body.masterId),
    master: body.masterId == null ? string(body.master, 'Мастер-приёмщик', 150, true) : '',
    complaint: string(body.complaint, 'Обращение клиента', 2000),
    due: local + ':00+03:00',
    status: body.status,
  };
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const orderProjection = `
  SELECT o.id, o.number, o.customer_id AS customerId, o.vehicle_id AS vehicleId,
    c.name AS customer, trim(v.make || ' ' || v.model) AS car, coalesce(v.plate, '') AS plate,
    o.master_id AS masterId, coalesce(m.name, o.advisor_name) AS master,
    o.promised_at AS due, o.status, coalesce(o.complaint, '') AS complaint,
    coalesce((SELECT sum(amount_kopecks) FROM order_items WHERE service_order_id = o.id), 0) AS total,
    coalesce((SELECT sum(amount_kopecks) FROM payments WHERE order_id = o.id), 0) AS paid
  FROM service_orders o JOIN customers c ON c.id = o.customer_id JOIN vehicles v ON v.id = o.vehicle_id
  LEFT JOIN masters m ON m.id = o.master_id
`;

function debt(order) {
  return order.status === 'cancelled' ? 0 : Math.max(0, order.total - order.paid);
}

function getOrder(db, orderId) {
  const order = db.prepare(orderProjection + ' WHERE o.id = ?').get(orderId);
  if (!order) throw new ApiError(404, 'Заказ не найден.');
  order.items = db.prepare(`
    SELECT kind, description, amount_kopecks AS amountKopecks FROM order_items
    WHERE service_order_id = ? ORDER BY id
  `).all(orderId);
  order.payments = db.prepare('SELECT id, amount_kopecks AS amountKopecks, paid_at AS paidAt, note FROM payments WHERE order_id = ? ORDER BY id DESC').all(orderId);
  order.history = db.prepare(`
    SELECT from_status AS fromStatus, to_status AS toStatus, changed_at AS changedAt, imported
    FROM order_status_history WHERE order_id = ? ORDER BY id DESC
  `).all(orderId);
  order.debt = debt(order);
  return order;
}

function saveOrder(db, body, orderId) {
  const input = orderInput(body);
  return transaction(db, () => {
    const previous = orderId == null ? null : getOrder(db, orderId);
    if (!previous && input.status !== 'accepted') invalid('Новый заказ создаётся в статусе «Принят».');
    if (previous && previous.status !== input.status && !transitions[previous.status].includes(input.status)) {
      throw new ApiError(409, 'Этот переход статуса недоступен.');
    }
    if (previous?.paid && (input.status === 'cancelled' || input.items.reduce((sum, item) => sum + item.amountKopecks, 0) < previous.paid)) {
      throw new ApiError(409, 'Сумма заказа должна покрывать полученные платежи. Отмена оплаченного заказа требует возврата.');
    }

    let customerId = input.customerId;
    if (customerId) getCustomer(db, customerId);
    else customerId = db.prepare('INSERT INTO customers (name) VALUES (?)').run(input.customer).lastInsertRowid;

    let vehicleId = input.vehicleId;
    if (vehicleId) {
      if (!db.prepare('SELECT id FROM vehicles WHERE id = ? AND customer_id = ?').get(vehicleId, customerId)) {
        invalid('Автомобиль не принадлежит выбранному клиенту.');
      }
    } else {
      vehicleId = insertVehicle(db, customerId, input.car, input.plate);
    }

    let master;
    if (input.masterId) {
      master = getMaster(db, input.masterId);
      if (!master.active && master.id !== previous?.masterId) invalid('Выберите активного мастера.');
    } else {
      master = db.prepare('SELECT id, name, active FROM masters WHERE name = ? ORDER BY id LIMIT 1').get(input.master);
      if (!master) {
        master = { id: db.prepare('INSERT INTO masters (name) VALUES (?)').run(input.master).lastInsertRowid, name: input.master, active: 1 };
      }
      if (!master.active && master.id !== previous?.masterId) invalid('Выберите активного мастера.');
    }
    const values = [customerId, vehicleId, master.name, input.due, input.complaint, input.status, master.id];
    if (previous) {
      db.prepare(`
        UPDATE service_orders SET customer_id = ?, vehicle_id = ?, advisor_name = ?,
          promised_at = ?, complaint = ?, status = ?, master_id = ? WHERE id = ?
      `).run(...values, orderId);
      db.prepare('DELETE FROM order_items WHERE service_order_id = ?').run(orderId);
    } else {
      orderId = db.prepare(`
        INSERT INTO service_orders (number, customer_id, vehicle_id, advisor_name, promised_at, complaint, status, master_id, created_at)
        VALUES ((SELECT coalesce(max(number), 0) + 1 FROM service_orders), ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...values, new Date().toISOString()).lastInsertRowid;
    }

    const insert = db.prepare('INSERT INTO order_items (service_order_id, kind, description, amount_kopecks) VALUES (?, ?, ?, ?)');
    for (const item of input.items) insert.run(orderId, item.kind, item.description, item.amountKopecks);
    return getOrder(db, orderId);
  });
}

function getCustomer(db, customerId) {
  const customer = db.prepare('SELECT id, name, phone, email, contact_note AS contactNote FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw new ApiError(404, 'Клиент не найден.');
  return customer;
}

function customerCard(db, customerId) {
  const customer = getCustomer(db, customerId);
  customer.vehicles = db.prepare("SELECT id, trim(make || ' ' || model) AS model, plate, vin FROM vehicles WHERE customer_id = ? ORDER BY id DESC").all(customerId);
  customer.orders = db.prepare(orderProjection + ' WHERE o.customer_id = ? ORDER BY o.id DESC').all(customerId);
  return customer;
}

function contacts(body) {
  const email = string(body.email, 'Электронная почта', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Проверьте адрес электронной почты.');
  return [
    string(body.name, 'Имя', 150, true), string(body.phone, 'Телефон', 40),
    email, string(body.contactNote, 'Предпочтение по связи', 500),
  ];
}

function insertVehicle(db, customerId, model, plate, make = '', vin = null) {
  return db.prepare('INSERT INTO vehicles (customer_id, model, plate, make, vin) VALUES (?, ?, ?, ?, ?)').run(customerId, model, plate, make, vin).lastInsertRowid;
}

const vehicleProjection = `
  SELECT v.id, v.customer_id AS customerId, c.name AS customer, v.make, v.model, v.plate, v.vin
  FROM vehicles v JOIN customers c ON c.id = v.customer_id
`;

function getVehicle(db, vehicleId) {
  const vehicle = db.prepare(vehicleProjection + ' WHERE v.id = ?').get(vehicleId);
  if (!vehicle) throw new ApiError(404, 'Автомобиль не найден.');
  vehicle.orders = db.prepare(orderProjection + ' WHERE o.vehicle_id = ? ORDER BY o.id DESC').all(vehicleId);
  return vehicle;
}

function saveVehicle(db, body, vehicleId, ownerId = body.customerId) {
  const customerId = id(ownerId);
  getCustomer(db, customerId);
  const make = string(body.make, 'Марка', 80);
  const model = string(body.model, 'Модель', 150, true);
  const plate = string(body.plate, 'Госномер', 24);
  const vin = string(body.vin, 'VIN', 17).toUpperCase() || null;
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) invalid('VIN должен содержать 17 цифр и латинских букв без I, O и Q.');
  if (vin && db.prepare('SELECT id FROM vehicles WHERE vin = ? AND id <> ?').get(vin, vehicleId ?? 0)) {
    throw new ApiError(409, 'Автомобиль с таким VIN уже существует.');
  }
  if (vehicleId) {
    const previous = getVehicle(db, vehicleId);
    if (previous.customerId !== customerId && previous.orders.length) {
      throw new ApiError(409, 'У автомобиля есть заказ-наряды. Смена владельца затронет их историю.');
    }
    db.prepare('UPDATE vehicles SET customer_id = ?, make = ?, model = ?, plate = ?, vin = ? WHERE id = ?')
      .run(customerId, make, model, plate, vin, vehicleId);
  } else {
    vehicleId = insertVehicle(db, customerId, model, plate, make, vin);
  }
  return getVehicle(db, vehicleId);
}

function getMaster(db, masterId) {
  const master = db.prepare('SELECT id, name, phone, specialty, active FROM masters WHERE id = ?').get(masterId);
  if (!master) throw new ApiError(404, 'Мастер не найден.');
  return { ...master, active: Boolean(master.active) };
}

function masterCard(db, masterId) {
  return {
    ...getMaster(db, masterId),
    orders: db.prepare(orderProjection + ' WHERE o.master_id = ? ORDER BY o.id DESC').all(masterId),
  };
}

function saveMaster(db, body, masterId) {
  if (typeof body.active !== 'boolean') invalid('Укажите активность мастера.');
  const values = [
    string(body.name, 'Имя мастера', 150, true), string(body.phone, 'Телефон', 40),
    string(body.specialty, 'Специализация', 150), Number(body.active),
  ];
  if (masterId) {
    getMaster(db, masterId);
    db.prepare('UPDATE masters SET name = ?, phone = ?, specialty = ?, active = ? WHERE id = ?').run(...values, masterId);
  } else {
    masterId = db.prepare('INSERT INTO masters (name, phone, specialty, active) VALUES (?, ?, ?, ?)').run(...values).lastInsertRowid;
  }
  return masterCard(db, masterId);
}

function savePayment(db, orderId, body) {
  const amount = body.amountKopecks;
  if (!Number.isSafeInteger(amount) || amount < 1) invalid('Введите положительную сумму платежа.');
  const note = string(body.note, 'Комментарий', 300);
  const requestId = string(body.requestId, 'Идентификатор платежа', 80) || randomUUID();
  return transaction(db, () => {
    const order = getOrder(db, orderId);
    const previous = db.prepare('SELECT order_id AS orderId, amount_kopecks AS amount, note FROM payments WHERE request_id = ?').get(requestId);
    if (previous) {
      if (previous.orderId === orderId && previous.amount === amount && previous.note === note) return order;
      throw new ApiError(409, 'Этот идентификатор уже использован для другого платежа.');
    }
    if (amount > order.debt) throw new ApiError(409, 'Платёж превышает остаток задолженности.');
    db.prepare('INSERT INTO payments (order_id, amount_kopecks, paid_at, note, request_id) VALUES (?, ?, ?, ?, ?)')
      .run(orderId, amount, new Date().toISOString(), note, requestId);
    return getOrder(db, orderId);
  });
}

function finance(db, query, debtors) {
  const all = db.prepare(orderProjection + ' ORDER BY o.id DESC').all().map((order) => ({ ...order, debt: debt(order) }));
  const payments = db.prepare(`
    SELECT p.id, p.order_id AS orderId, o.number, c.name AS customer,
      p.amount_kopecks AS amountKopecks, p.paid_at AS paidAt, p.note
    FROM payments p JOIN service_orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
    ORDER BY p.id DESC
  `).all();
  return {
    received: all.reduce((sum, order) => sum + order.paid, 0),
    debt: all.reduce((sum, order) => sum + order.debt, 0),
    orders: all.filter((order) => (!debtors || order.debt > 0)
      && [order.customer, 'ЗН-' + order.number, order.car, order.plate].join(' ').toLocaleLowerCase('ru').includes(query)),
    payments,
  };
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Ожидаются данные в формате JSON.');
  }
  const origin = request.headers.origin;
  if (origin && origin !== 'http://' + request.headers.host) throw new ApiError(403, 'Источник запроса недоступен.');
  const chunks = [];
  let size = 0;
  const limit = request.url.startsWith('/api/v1/backup/') ? Math.ceil(MAX_BACKUP_BYTES / 3) * 4 + 1024 : 128 * 1024;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new ApiError(413, 'Запрос слишком большой.');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    invalid('Некорректные данные JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Ожидается объект JSON.');
  return body;
}

function route(db, method, url, body) {
  const { pathname, searchParams } = url;
  if (pathname === '/api/v1/dashboard' && method === 'GET') return [200, dashboard(db)];
  if (pathname === '/api/v1/vehicles') {
    if (method === 'POST') return [201, saveVehicle(db, body)];
    if (method === 'GET') {
      const query = string(searchParams.get('q'), 'Поиск', 150).toLocaleLowerCase('ru');
      const compact = query.replace(/\s+/g, '');
      return [200, db.prepare(vehicleProjection + ' ORDER BY v.id DESC').all().filter((vehicle) =>
        [vehicle.make, vehicle.model, vehicle.plate, vehicle.vin].join(' ').toLocaleLowerCase('ru').includes(query)
        || (vehicle.plate ?? '').replace(/\s+/g, '').toLocaleLowerCase('ru').includes(compact))];
    }
  }
  if (pathname === '/api/v1/masters') {
    if (method === 'GET') return [200, db.prepare('SELECT id, name, phone, specialty, active FROM masters ORDER BY active DESC, name, id').all()];
    if (method === 'POST') return [201, saveMaster(db, body)];
  }
  if (pathname === '/api/v1/finance' && method === 'GET') {
    return [200, finance(db, string(searchParams.get('q'), 'Поиск', 150).toLocaleLowerCase('ru'), searchParams.get('debtors') === '1')];
  }
  if (pathname === '/api/v1/settings') {
    if (method === 'PATCH') db.prepare('UPDATE service_settings SET name = ?, phone = ?, address = ? WHERE id = 1').run(
      string(body.name, 'Название автосервиса', 150, true), string(body.phone, 'Телефон', 40), string(body.address, 'Адрес', 300));
    if (method === 'GET' || method === 'PATCH') return [200, db.prepare('SELECT name, phone, address FROM service_settings WHERE id = 1').get()];
  }
  if (pathname === '/api/v1/backup' && method === 'GET') return [200, makeBackup(db)];
  if (method === 'POST' && ['/api/v1/backup/check', '/api/v1/backup/restore'].includes(pathname)) {
    let result;
    try {
      result = withVerifiedBackup(db, body.file, (filename, summary) => {
        if (pathname.endsWith('/check')) return summary;
        if (body.token !== summary.token) invalid('Подтвердите проверенную резервную копию.');
        restoreBackup(db, filename);
        return { restored: true };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, error.message);
    }
    return [200, result];
  }
  const detail = /^\/api\/v1\/(vehicles|masters)\/(\d+)$/.exec(pathname);
  if (detail) {
    const recordId = id(Number(detail[2]));
    if (detail[1] === 'vehicles') {
      if (method === 'GET') return [200, getVehicle(db, recordId)];
      if (method === 'PATCH') return [200, saveVehicle(db, body, recordId)];
    }
    if (detail[1] === 'masters') {
      if (method === 'GET') return [200, masterCard(db, recordId)];
      if (method === 'PATCH') return [200, saveMaster(db, body, recordId)];
    }
  }
  const payment = /^\/api\/v1\/orders\/(\d+)\/payments$/.exec(pathname);
  if (payment && method === 'POST') return [201, savePayment(db, id(Number(payment[1])), body)];
  if (pathname === '/api/v1/orders') {
    if (method === 'POST') return [201, saveOrder(db, body)];
    if (method === 'GET') {
      const status = searchParams.get('status');
      const query = string(searchParams.get('q'), 'Поиск', 150).toLocaleLowerCase('ru');
      if (status && !Object.hasOwn(transitions, status)) invalid('Неизвестный статус.');
      const rows = db.prepare(orderProjection + ' WHERE (? IS NULL OR o.status = ?) ORDER BY o.id DESC').all(status || null, status || null);
      return [200, rows.filter((row) => ['ЗН-' + row.number, row.customer, row.car, row.plate].join(' ').toLocaleLowerCase('ru').includes(query))];
    }
  }
  if (pathname === '/api/v1/customers') {
    if (method === 'GET') {
      const query = string(searchParams.get('q'), 'Поиск', 150).toLocaleLowerCase('ru');
      return [200, db.prepare('SELECT id, name, phone FROM customers ORDER BY id DESC').all()
        .filter((row) => [row.name, row.phone].join(' ').toLocaleLowerCase('ru').includes(query))];
    }
    if (method === 'POST') {
      const result = db.prepare('INSERT INTO customers (name, phone, email, contact_note) VALUES (?, ?, ?, ?)').run(...contacts(body));
      return [201, customerCard(db, result.lastInsertRowid)];
    }
  }

  const match = /^\/api\/v1\/(orders|customers)\/(\d+)(\/vehicles)?$/.exec(pathname);
  if (match) {
    const recordId = id(Number(match[2]));
    if (match[1] === 'orders' && !match[3]) {
      if (method === 'GET') return [200, getOrder(db, recordId)];
      if (method === 'PATCH') return [200, saveOrder(db, body, recordId)];
    }
    if (match[1] === 'customers') {
      if (match[3] && method === 'POST') {
        return [201, saveVehicle(db, body, null, recordId)];
      }
      if (!match[3] && method === 'GET') return [200, customerCard(db, recordId)];
      if (!match[3] && method === 'PATCH') {
        getCustomer(db, recordId);
        db.prepare('UPDATE customers SET name = ?, phone = ?, email = ?, contact_note = ? WHERE id = ?').run(...contacts(body), recordId);
        return [200, customerCard(db, recordId)];
      }
    }
  }
  throw new ApiError(404, 'Маршрут не найден.');
}

export function dashboard(db, now = new Date()) {
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const firstDay = new Date(today + 'T00:00:00Z');
  firstDay.setUTCDate(firstDay.getUTCDate() - 6);
  const start = firstDay.toISOString().slice(0, 10);
  const asOf = now.toISOString();

  db.exec('BEGIN');
  try {
    const breakdown = db.prepare(`
      SELECT status, count(*) AS count FROM service_orders WHERE status NOT IN ('closed', 'cancelled') GROUP BY status
    `).all();
    const overdue = db.prepare(`
      SELECT count(*) AS count FROM service_orders
      WHERE status NOT IN ('closed', 'cancelled') AND julianday(promised_at) < julianday(?)
    `).get(asOf).count;
    const booked = db.prepare(`
      SELECT date(created_at, '+03:00') AS day, count(*) AS count FROM service_orders
      WHERE date(created_at, '+03:00') BETWEEN ? AND ? GROUP BY day
    `).all(start, today);
    const counts = new Map(booked.map(({ day, count }) => [day, count]));
    const intake = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(firstDay);
      day.setUTCDate(day.getUTCDate() + index);
      const key = day.toISOString().slice(0, 10);
      return { day: key, count: counts.get(key) ?? 0 };
    });
    const upcoming = db.prepare(orderProjection + `
      WHERE o.status NOT IN ('closed', 'cancelled') AND julianday(o.promised_at) >= julianday(?)
      ORDER BY julianday(o.promised_at), o.id LIMIT 5
    `).all(asOf);
    const recent = db.prepare(orderProjection + ' ORDER BY julianday(o.created_at) DESC, o.id DESC LIMIT 5').all();
    const receivedToday = db.prepare("SELECT coalesce(sum(amount_kopecks), 0) AS total FROM payments WHERE date(paid_at, '+03:00') = ?").get(today).total;
    const totalDebt = db.prepare(orderProjection + " WHERE o.status <> 'cancelled'").all().reduce((sum, order) => sum + debt(order), 0);
    const settings = db.prepare('SELECT name, phone, address FROM service_settings WHERE id = 1').get();
    db.exec('COMMIT');
    return {
      today, intake, breakdown, overdue, upcoming, recent, receivedToday, totalDebt, settings,
      open: breakdown.reduce((sum, row) => sum + row.count, 0),
      ready: breakdown.find(({ status }) => status === 'ready')?.count ?? 0,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function handleApi(db, request, response, url) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const body = ['POST', 'PATCH'].includes(request.method) ? await readBody(request) : null;
    const [status, data] = route(db, request.method, url, body);
    if (Buffer.isBuffer(data)) {
      response.setHeader('Content-Type', 'application/vnd.sqlite3');
      response.setHeader('Content-Disposition', 'attachment; filename="autoservice-backup.sqlite"');
      response.writeHead(status);
      response.end(data);
      return;
    }
    response.writeHead(status);
    response.end(JSON.stringify(data));
  } catch (error) {
    if (!(error instanceof ApiError)) console.error(error);
    response.writeHead(error instanceof ApiError ? error.status : 500);
    response.end(JSON.stringify({ error: error instanceof ApiError ? error.message : 'Внутренняя ошибка приложения.' }));
  }
}
