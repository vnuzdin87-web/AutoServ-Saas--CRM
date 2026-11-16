const app = document.getElementById('autoservice');
const find = (selector) => app.querySelector(selector);
const form = find('[data-order-form]');
const fields = form.elements;
const contactForm = find('[data-contact-form]');
const names = {
  home: 'Главная', orders: 'Заказы', form: 'Заказ-наряд', client: 'Карточка клиента',
  vehicles: 'Автомобили', masters: 'Мастера', finance: 'Финансы', settings: 'Настройки',
};
const statuses = {
  accepted: ['Принят', 'new', 'in_progress', 'waiting_parts', 'cancelled'],
  in_progress: ['В работе', 'work', 'waiting_parts', 'ready', 'cancelled'],
  waiting_parts: ['Ожидает запчасти', 'wait', 'in_progress', 'cancelled'],
  ready: ['Готов к выдаче', 'ready', 'in_progress', 'closed', 'cancelled'],
  closed: ['Закрыт', 'closed'],
  cancelled: ['Отменён', 'cancelled'],
};
let screen = 'home';
let order = null;
let customer = null;
let dirty = false;
let busy = false;
let listVersion = 0;
let searchTimer;
let retry;
let editingContact = null;
let paymentRequestId;
let checkedBackup;

const date = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
});
const deliveryDate = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
});
const dashboardDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeZone: 'UTC' });
const periodDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const chartDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
const statusColors = { in_progress: '#4679c9', ready: '#17856b', waiting_parts: '#b97724', accepted: '#8059b6' };
const money = (kopecks) => new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: kopecks % 100 ? 2 : 0, maximumFractionDigits: 2,
}).format(kopecks / 100) + ' ₽';
const clean = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const formData = (element) => Object.fromEntries(new FormData(element));

async function api(path, method = 'GET', payload) {
  let response;
  try {
    response = await fetch('/api/v1' + path, {
      method, headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch {
    throw new Error('Нет связи с локальным сервером.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function notice(text = '', error = false, action) {
  const message = find('[data-notice]');
  message.textContent = text;
  message.hidden = !text;
  message.classList.toggle('error', error);
  retry = action;
  find('[data-retry]').hidden = !action;
}

async function perform(action, { loading = true, canRetry = true } = {}) {
  if (busy) return;
  busy = true;
  if (loading) notice('Загрузка…');
  try {
    await action();
  } catch (error) {
    notice(error.message, true, canRetry ? () => perform(action, { loading, canRetry }) : undefined);
  } finally {
    busy = false;
  }
}

function show(next, focus = true) {
  screen = next;
  find('[data-title]').textContent = names[next];
  for (const section of app.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== next;
  for (const link of app.querySelectorAll('nav [data-screen]')) {
    if (link.dataset.screen === next) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (focus) {
    const heading = find('[data-view="' + next + '"] h1');
    heading.tabIndex = -1;
    heading.focus();
  }
}

function table(container, rows, emptyText) {
  const upcoming = container === 'home';
  const recent = container === 'recent';
  const detail = upcoming ? 'Выдача' : recent ? 'Мастер' : 'Сумма';
  find('[data-table="' + container + '"]').innerHTML = rows.length ? `
    <table aria-label="Заказ-наряды"><thead><tr>
      <th scope="col">Наряд</th><th scope="col">Автомобиль</th><th scope="col">Клиент</th>
      <th scope="col">Статус</th><th scope="col" class="dashboard-detail">${detail}</th>
    </tr></thead><tbody>${rows.map((row) => {
      const [label, tone] = statuses[row.status];
      const value = upcoming ? deliveryDate.format(new Date(row.due)) : recent ? clean(row.master) : money(row.total);
      return `<tr>
        <td><button type="button" class="text-link" data-order="${row.id}" aria-label="Открыть заказ ЗН-${row.number}">ЗН-${row.number}</button>${upcoming || recent ? '' : '<small>' + date.format(new Date(row.due)) + '</small>'}</td>
        <td><strong>${clean(row.car)}</strong><small>${clean(row.plate) || 'Госномер не указан'}</small></td>
        <td><button type="button" class="text-link" data-customer="${row.customerId}">${clean(row.customer)}</button></td>
        <td><span class="status ${tone}">${label}</span></td>
        <td class="${upcoming || recent ? 'dashboard-detail' : 'sum'}">${upcoming || recent ? '<span class="mobile-detail">' + detail + ' · </span>' : ''}<strong>${value}</strong></td>
      </tr>`;
    }).join('')}</tbody></table>` : '<p class="result">' + clean(emptyText) + '</p>';
}

function options(select, entries, selected) {
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  select.value = selected ?? '';
}

async function renderOrders(propagateError = false) {
  const version = ++listVersion;
  const q = find('[data-search]').value.trim();
  const status = find('[data-filter]').value;
  try {
    const rows = await api('/orders?' + new URLSearchParams({ q, status }));
    if (version !== listVersion || screen !== 'orders') return;
    table('orders', rows, q || status ? 'Заказы не найдены. Измените параметры поиска.' : 'Заказов пока нет. Создайте первый заказ-наряд.');
    find('[data-count]').textContent = 'Найдено заказов: ' + rows.length;
    notice();
  } catch (error) {
    if (version !== listVersion || screen !== 'orders') return;
    if (propagateError) throw error;
    notice(error.message, true, () => renderOrders());
  }
}

async function renderHome() {
  const data = await api('/dashboard');
  renderShop(data.settings);
  find('[data-dashboard-date]').textContent = dashboardDate.format(new Date(data.today));
  find('[data-today-intake]').textContent = 'Новых заказов сегодня: ' + data.intake.at(-1).count;
  for (const key of ['open', 'ready', 'overdue']) find('[data-kpi="' + key + '"]').textContent = data[key];
  for (const key of ['receivedToday', 'totalDebt']) find('[data-kpi="' + key + '"]').textContent = money(data[key]);
  find('[data-kpi="overdue"]').classList.toggle('warn', data.overdue > 0);
  const counts = new Map(data.breakdown.map(({ status, count }) => [status, count]));
  find('[data-kpi-work]').textContent = 'В работе: ' + (counts.get('in_progress') ?? 0);
  find('[data-breakdown-total]').textContent = data.open ? 'Всего открыто: ' + data.open : 'Открытых заказов пока нет.';
  find('[data-breakdown]').innerHTML = data.open ? Object.entries(statusColors).map(([status, color]) => {
    const count = counts.get(status) ?? 0;
    return `<div><span>${statuses[status][0]}</span><span class="track" aria-hidden="true"><i style="--p:${100 * count / data.open}%;--tone:${color}"></i></span><strong>${count}</strong></div>`;
  }).join('') : '';

  const first = new Date(data.intake[0].day);
  const last = new Date(data.intake.at(-1).day);
  find('[data-intake-period]').textContent = 'Новые заказы · ' + periodDate.formatRange(first, last);
  const max = Math.max(...data.intake.map(({ count }) => count));
  const chart = find('[data-intake-chart]');
  chart.hidden = !max;
  find('[data-intake-empty]').hidden = Boolean(max);
  if (max) {
    const bars = data.intake.map(({ day, count }) => [chartDay.format(new Date(day)), count]);
    chart.setAttribute('aria-label', 'Новые заказы по дням. ' + bars.map(([label, count]) => label + ': ' + count).join(', '));
    chart.innerHTML = bars.map(([label, count]) =>
      `<div class="day"><strong>${count}</strong><span class="bar" style="--n:${count / max}"></span>${label}</div>`).join('');
  }
  table('home', data.upcoming, 'Запланированных выдач пока нет.');
  table('recent', data.recent, 'Заказов пока нет. Создайте первый заказ-наряд.');
}

function toggleNewVehicle() {
  const existing = Boolean(fields.vehicleId.value);
  find('[data-new-car]').hidden = existing;
  find('[data-new-plate]').hidden = existing;
  fields.car.required = !existing;
}

async function loadVehicles(customerId, vehicleId) {
  const card = customerId ? await api('/customers/' + customerId) : null;
  const vehicles = card?.vehicles ?? [];
  options(fields.vehicleId, [['', 'Новый автомобиль'], ...vehicles.map(({ id, model, plate }) => [id, [model, plate].filter(Boolean).join(' · ')])], vehicleId);
  find('[data-existing-car]').hidden = !vehicles.length;
  toggleNewVehicle();
}

function parseKopecks(value) {
  const match = /^(\d{1,9})(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

function itemRows() {
  return Array.from(find('[data-lines]').querySelectorAll('.item-row'));
}

function estimate() {
  const sums = { labor: 0, part: 0 };
  for (const row of itemRows()) {
    sums[row.querySelector('[data-kind]').value] += parseKopecks(row.querySelector('[data-amount]').value) ?? 0;
  }
  find('[data-labor]').textContent = money(sums.labor);
  find('[data-parts]').textContent = money(sums.part);
  find('[data-total]').textContent = money(sums.labor + sums.part);
}

function addItem(item = {}, focus = false) {
  const lines = find('[data-lines]');
  lines.querySelector('[data-empty-items]')?.remove();
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <label>Вид<select data-kind><option value="labor">Работа</option><option value="part">Запчасть</option></select></label>
    <label>Наименование<input data-description required maxlength="200"></label>
    <label>Сумма, ₽<input data-amount inputmode="decimal" required maxlength="12"></label>
    <button type="button" class="action" data-remove-item>Удалить</button>`;
  row.querySelector('[data-kind]').value = item.kind ?? 'labor';
  row.querySelector('[data-description]').value = item.description ?? '';
  row.querySelector('[data-amount]').value = item.amountKopecks == null ? '' : (item.amountKopecks / 100).toFixed(2).replace('.', ',');
  lines.append(row);
  if (focus) row.querySelector('[data-description]').focus();
}

function emptyItems() {
  if (!itemRows().length) find('[data-lines]').innerHTML = '<p class="muted" data-empty-items>Позиции сметы ещё не добавлены.</p>';
}

async function openForm(orderId, card) {
  const [existing, customers, masters] = await Promise.all([orderId ? api('/orders/' + orderId) : null, api('/customers'), api('/masters')]);
  const customerId = existing?.customerId ?? card?.id;
  const vehicleId = existing?.vehicleId ?? card?.orders[0]?.vehicleId ?? card?.vehicles[0]?.id;
  await loadVehicles(customerId, vehicleId);

  order = existing;
  form.reset();
  options(fields.customerId, [['', 'Новый клиент'], ...customers.map(({ id, name, phone }) => [id, [name, phone].filter(Boolean).join(' · ')])], customerId);
  fields.vehicleId.value = vehicleId ?? '';
  find('[data-new-customer]').hidden = Boolean(customerId);
  fields.customer.required = !customerId;
  toggleNewVehicle();
  find('[data-form-title]').textContent = order ? 'Заказ-наряд ЗН-' + order.number : 'Новый заказ-наряд';
  find('[data-form-subtitle]').textContent = order ? order.car + ' · ' + order.customer : 'Приём автомобиля в сервис';
  const status = order?.status ?? 'accepted';
  const available = order ? [status, ...statuses[status].slice(2).filter((value) => value !== 'cancelled' || !order.paid)] : [status];
  options(fields.status, available.map((value) => [value, statuses[value][0]]), status);
  const eligible = masters.filter((master) => master.active || master.id === order?.masterId);
  options(fields.masterId, [['', 'Выберите мастера'], ...eligible.map((master) => [
    master.id, master.name + (master.active ? '' : ' · неактивный'),
  ])], order?.masterId ?? (eligible.length === 1 ? eligible[0].id : ''));
  find('[data-no-masters]').hidden = Boolean(eligible.length);
  if (order) {
    fields.due.value = order.due.slice(0, 16);
    fields.complaint.value = order.complaint;
  }
  find('[data-lines]').replaceChildren();
  for (const item of order?.items ?? []) addItem(item);
  emptyItems();
  estimate();
  renderOrderHistory();
  dirty = false;
  notice();
  show('form');
}

async function openClient(customerId) {
  const customers = await api('/customers');
  const chosen = customerId ?? customer?.id ?? customers[0]?.id;
  customer = chosen ? await api('/customers/' + chosen) : null;
  options(find('[data-client-picker]'), customers.map(({ id, name, phone }) => [id, [name, phone].filter(Boolean).join(' · ')]), chosen);
  find('[data-client-picker]').disabled = !customers.length;
  find('[data-client-details]').hidden = !customer;
  find('[data-client-history]').hidden = !customer;
  find('[data-empty-client]').hidden = Boolean(customer);
  contactForm.hidden = true;
  editingContact = null;
  if (customer) {
    find('[data-client-name]').textContent = customer.name;
    find('[data-initials]').textContent = customer.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join('');
    find('[data-client-since]').textContent = 'Клиент техцентра';
    find('[data-contact]').innerHTML = [
      ['Телефон', customer.phone], ['Электронная почта', customer.email], ['Предпочтение', customer.contactNote],
    ].map(([label, value]) => `<div><small>${label}</small>${clean(value) || '—'}</div>`).join('');
    find('[data-cars]').innerHTML = customer.vehicles.length ? customer.vehicles.map((vehicle) =>
      `<div class="car"><strong>${clean(vehicle.model)}</strong><small>${clean(vehicle.plate) || 'Госномер не указан'}</small></div>`).join('')
      : '<p class="muted">Автомобилей пока нет.</p>';
    table('client', customer.orders, 'Заказов у клиента пока нет.');
  }
  dirty = false;
  notice();
  show('client');
}

function canLeave() {
  return !dirty || window.confirm('Есть несохранённые изменения. Выйти без сохранения?');
}

async function navigate(next) {
  if (next === 'form') return openForm(order?.id);
  if (next === 'client') return openClient();
  show(next);
  dirty = false;
  if (next === 'orders') await renderOrders(true);
  if (next === 'home') {
    await renderHome();
    notice();
  }
  if (next === 'vehicles') {
    find('[data-vehicle-form]').hidden = true;
    find('[data-vehicle-history]').hidden = true;
    await renderVehicles();
  }
  if (next === 'masters') {
    find('[data-master-form]').hidden = true;
    find('[data-master-history]').hidden = true;
    await renderMasters();
  }
  if (next === 'finance') await renderFinance();
  if (next === 'settings') await renderSettings();
}

function openContact(record) {
  editingContact = record?.id ?? null;
  for (const key of ['name', 'phone', 'email', 'contactNote']) contactForm.elements.namedItem(key).value = record?.[key] ?? '';
  contactForm.hidden = false;
  contactForm.elements.namedItem('name').focus();
}

function renderOrderHistory() {
  find('[data-order-history]').hidden = !order;
  find('[data-saved-payment]').hidden = !order;
  find('[data-saved-debt]').hidden = !order;
  const payment = find('[data-payment-form]');
  payment.reset();
  paymentRequestId = undefined;
  if (!order) return;
  find('[data-order-paid]').textContent = money(order.paid);
  find('[data-order-debt]').textContent = money(order.debt);
  payment.hidden = !order.debt;
  records('[data-order-payments]', order.payments, 'Платежей пока нет.', (entry) =>
    `<span>${deliveryDate.format(new Date(entry.paidAt))}<small>${clean(entry.note)}</small></span><strong>${money(entry.amountKopecks)}</strong>`);
  records('[data-status-history]', order.history, 'Изменений пока нет.', (entry) => {
    const label = statuses[entry.toStatus][0];
    const description = entry.imported ? 'Статус на момент переноса' : deliveryDate.format(new Date(entry.changedAt));
    return `<span><strong>${entry.fromStatus ? statuses[entry.fromStatus][0] + ' → ' : ''}${label}</strong><small>${description}</small></span>`;
  });
}

function records(selector, data, empty, markup) {
  find(selector).innerHTML = data.length
    ? data.map((row) => '<div class="record-row">' + markup(row) + '</div>').join('')
    : '<p class="muted">' + clean(empty) + '</p>';
}

function fill(formElement, keys, source) {
  formElement.reset();
  for (const key of keys) formElement.elements.namedItem(key).value = source?.[key] ?? '';
}

async function renderVehicles() {
  const { q } = formData(find('[data-vehicle-search]'));
  const rows = await api('/vehicles?' + new URLSearchParams({ q }));
  records('[data-vehicles]', rows, q ? 'Автомобили не найдены.' : 'Автомобилей пока нет.', (row) =>
    `<div><button type="button" class="text-link" data-vehicle="${row.id}">${clean([row.make, row.model].filter(Boolean).join(' '))}</button>
    <small>${clean([row.plate, row.vin, row.customer].filter(Boolean).join(' · '))}</small></div>`);
  notice();
}

async function openVehicle(recordId) {
  const [customers, vehicle] = await Promise.all([api('/customers'), recordId ? api('/vehicles/' + recordId) : null]);
  if (!customers.length) {
    await openClient();
    openContact(null);
    notice('Добавьте клиента, чтобы привязать автомобиль.');
    return;
  }
  const editor = find('[data-vehicle-form]');
  fill(editor, ['make', 'model', 'plate', 'vin'], vehicle);
  editor.dataset.recordId = vehicle?.id ?? '';
  options(editor.elements.namedItem('customerId'), [['', 'Выберите клиента'], ...customers.map((row) => [
    row.id, [row.name, row.phone].filter(Boolean).join(' · '),
  ])], vehicle?.customerId ?? (customers.length === 1 ? customers[0].id : ''));
  find('[data-vehicle-title]').textContent = vehicle ? 'Редактирование автомобиля' : 'Новый автомобиль';
  editor.hidden = false;
  find('[data-vehicle-history]').hidden = !vehicle;
  if (vehicle) table('vehicle', vehicle.orders, 'У автомобиля пока нет заказов.');
  editor.elements.namedItem('model').focus();
  dirty = false;
  notice();
}

async function renderMasters() {
  const rows = await api('/masters');
  records('[data-masters]', rows, 'В справочнике пока нет мастеров.', (row) =>
    `<div><button type="button" class="text-link" data-master="${row.id}">${clean(row.name)}</button>
    <small>${clean([row.specialty, row.phone].filter(Boolean).join(' · '))}</small></div>
    <span class="status ${row.active ? 'ready' : 'closed'}">${row.active ? 'Активный' : 'Неактивный'}</span>`);
  notice();
}

async function openMaster(recordId) {
  const master = recordId ? await api('/masters/' + recordId) : null;
  const editor = find('[data-master-form]');
  fill(editor, ['name', 'phone', 'specialty'], master);
  editor.elements.namedItem('active').checked = master?.active ?? true;
  editor.dataset.recordId = master?.id ?? '';
  find('[data-master-title]').textContent = master ? 'Редактирование мастера' : 'Новый мастер';
  editor.hidden = false;
  find('[data-master-history]').hidden = !master;
  if (master) table('master', master.orders, 'У мастера пока нет заказов.');
  editor.elements.namedItem('name').focus();
  dirty = false;
  notice();
}

async function renderFinance() {
  const { q, debtors } = formData(find('[data-finance-search]'));
  const data = await api('/finance?' + new URLSearchParams({ q, debtors: debtors ? '1' : '0' }));
  find('[data-finance-received]').textContent = money(data.received);
  find('[data-finance-debt]').textContent = money(data.debt);
  records('[data-finance-orders]', data.orders, 'Подходящих заказов нет.', (row) =>
    `<div><button type="button" class="text-link" data-order="${row.id}">ЗН-${row.number}</button> · ${clean(row.customer)}
    <small>${clean(row.car)} · ${statuses[row.status][0]}</small></div>
    <div><small>Стоимость ${money(row.total)} · оплачено ${money(row.paid)}</small><strong>Долг ${money(row.debt)}</strong></div>`);
  records('[data-finance-payments]', data.payments, 'Платежей пока нет.', (row) =>
    `<div><button type="button" class="text-link" data-order="${row.orderId}">ЗН-${row.number}</button> · ${clean(row.customer)}
    <small>${deliveryDate.format(new Date(row.paidAt))}${row.note ? ' · ' + clean(row.note) : ''}</small></div><strong>${money(row.amountKopecks)}</strong>`);
  notice();
}

function renderShop(settings) {
  find('[data-shop-name]').textContent = settings.name;
  find('[data-shop-contact]').textContent = [settings.phone, settings.address].filter(Boolean).join(' · ');
}

function clearBackup() {
  checkedBackup = undefined;
  find('[data-backup-summary]').hidden = true;
  find('[data-restore]').hidden = true;
}

async function renderSettings() {
  const settings = await api('/settings');
  fill(find('[data-settings-form]'), ['name', 'phone', 'address'], settings);
  renderShop(settings);
  clearBackup();
  find('[data-backup-form]').reset();
  notice();
}

function encodeBackup(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

options(find('[data-filter]'), [['', 'Все статусы'], ...Object.entries(statuses).map(([value, [label]]) => [value, label])]);
app.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || busy) return;
  if (button.hasAttribute('data-retry')) return retry?.();
  if (button.hasAttribute('data-add-item')) {
    if (itemRows().length >= 100) return notice('В смете допустимо до 100 позиций.', true);
    addItem({}, true);
    dirty = true;
    return;
  }
  if (button.hasAttribute('data-remove-item')) {
    button.closest('.item-row').remove();
    emptyItems();
    estimate();
    find('[data-add-item]').focus();
    dirty = true;
    return;
  }
  if (button.hasAttribute('data-edit-client')) {
    if (!contactForm.hidden) return;
    openContact(customer);
    return;
  }
  if (button.dataset.screen === screen || !canLeave()) return;
  if (button.hasAttribute('data-add-client')) {
    dirty = false;
    return openContact(null);
  }
  if (button.hasAttribute('data-new-vehicle') || button.dataset.vehicle) {
    return perform(() => openVehicle(Number(button.dataset.vehicle) || null));
  }
  if (button.hasAttribute('data-new-master') || button.dataset.master) {
    return perform(() => openMaster(Number(button.dataset.master) || null));
  }
  if (button.hasAttribute('data-restore')) {
    if (!checkedBackup || !window.confirm('Восстановить проверенную копию? Она заменит текущие данные CRM. Перед заменой будет создана резервная копия.')) return;
    return perform(async () => {
      await api('/backup/restore', 'POST', checkedBackup);
      order = customer = editingContact = null;
      dirty = false;
      await renderSettings();
      notice('Данные восстановлены из резервной копии.');
    }, { canRetry: false });
  }
  if (button.hasAttribute('data-new')) return perform(() => openForm());
  if (button.hasAttribute('data-client-new')) return perform(() => openForm(null, customer));
  if (button.dataset.customer) return perform(() => openClient(Number(button.dataset.customer)));
  if (button.dataset.order) return perform(() => openForm(Number(button.dataset.order)));
  if (button.dataset.screen) perform(() => navigate(button.dataset.screen));
});

find('[data-search]').addEventListener('input', () => {
  clearTimeout(searchTimer);
  listVersion++;
  searchTimer = setTimeout(renderOrders, 150);
});
find('[data-filter]').addEventListener('change', () => {
  clearTimeout(searchTimer);
  renderOrders();
});
find('[data-client-picker]').addEventListener('change', (event) => {
  const selected = Number(event.target.value);
  event.target.value = customer?.id ?? '';
  if (canLeave()) perform(() => openClient(selected));
});
fields.customerId.addEventListener('change', () => {
  const selected = Number(fields.customerId.value);
  fields.vehicleId.replaceChildren(new Option('Новый автомобиль', ''));
  find('[data-existing-car]').hidden = true;
  find('[data-new-customer]').hidden = Boolean(selected);
  fields.customer.required = !selected;
  toggleNewVehicle();
  perform(async () => {
    fields.customerId.disabled = true;
    try {
      await loadVehicles(selected);
      notice();
    } finally {
      fields.customerId.disabled = false;
    }
  }, { canRetry: false });
});
fields.vehicleId.addEventListener('change', toggleNewVehicle);
form.addEventListener('input', () => { dirty = true; estimate(); });
contactForm.addEventListener('input', () => { dirty = true; });
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  const values = formData(form);
  const items = itemRows().map((row) => ({
    kind: row.querySelector('[data-kind]').value,
    description: row.querySelector('[data-description]').value.trim(),
    amountKopecks: parseKopecks(row.querySelector('[data-amount]').value),
  }));
  const invalidIndex = items.findIndex((item) => !item.description || item.amountKopecks === null || item.amountKopecks > 100_000_000_00);
  if (invalidIndex !== -1) {
    notice('Проверьте название и сумму позиции ' + (invalidIndex + 1) + '.', true);
    itemRows()[invalidIndex].querySelector(items[invalidIndex].description ? '[data-amount]' : '[data-description]').focus();
    return;
  }
  perform(async () => {
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const saved = await api(order ? '/orders/' + order.id : '/orders', order ? 'PATCH' : 'POST', {
        ...values, customerId: Number(values.customerId) || null, vehicleId: Number(values.vehicleId) || null,
        masterId: Number(values.masterId), items,
      });
      order = saved;
      find('[data-search]').value = '';
      find('[data-filter]').value = '';
      await navigate('orders');
      notice('Заказ ЗН-' + saved.number + ' сохранён.');
    } finally {
      submit.disabled = false;
    }
  }, { canRetry: false });
});

contactForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const values = formData(contactForm);
  perform(async () => {
    const submit = contactForm.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const saved = await api(editingContact ? '/customers/' + editingContact : '/customers', editingContact ? 'PATCH' : 'POST', values);
      dirty = false;
      await openClient(saved.id);
      notice('Контакты сохранены.');
    } finally {
      submit.disabled = false;
    }
  }, { canRetry: false });
});

for (const [selector, render] of [['[data-vehicle-search]', renderVehicles], ['[data-finance-search]', renderFinance]]) {
  find(selector).addEventListener('submit', (event) => {
    event.preventDefault();
    perform(render);
  });
}

function bindEditor(selector, action) {
  const editor = find(selector);
  editor.addEventListener('input', () => { dirty = true; });
  editor.addEventListener('submit', (event) => {
    event.preventDefault();
    perform(async () => {
      const submit = editor.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        await action(editor, formData(editor));
      } finally {
        submit.disabled = false;
      }
    }, { canRetry: false });
  });
}

bindEditor('[data-vehicle-form]', async (editor, values) => {
  const recordId = editor.dataset.recordId;
  const saved = await api(recordId ? '/vehicles/' + recordId : '/vehicles', recordId ? 'PATCH' : 'POST', {
    ...values, customerId: Number(values.customerId),
  });
  dirty = false;
  find('[data-vehicle-search]').reset();
  await renderVehicles();
  await openVehicle(saved.id);
  notice('Автомобиль сохранён.');
});

bindEditor('[data-master-form]', async (editor, values) => {
  const recordId = editor.dataset.recordId;
  const saved = await api(recordId ? '/masters/' + recordId : '/masters', recordId ? 'PATCH' : 'POST', {
    ...values, active: Boolean(values.active),
  });
  dirty = false;
  await renderMasters();
  await openMaster(saved.id);
  notice('Мастер сохранён.');
});

bindEditor('[data-settings-form]', async (_editor, values) => {
  const saved = await api('/settings', 'PATCH', values);
  dirty = false;
  renderShop(saved);
  notice('Настройки сохранены.');
});

find('[data-payment-form]').addEventListener('input', () => { paymentRequestId = undefined; });
find('[data-payment-form]').addEventListener('submit', (event) => {
  event.preventDefault();
  if (dirty) return notice('Сохраните изменения в заказе перед оплатой.', true);
  const { amount, note } = formData(event.target);
  const amountKopecks = parseKopecks(amount);
  if (!amountKopecks) return notice('Введите положительную сумму платежа с точностью до копеек.', true);
  paymentRequestId ??= crypto.randomUUID();
  perform(async () => {
    const submit = find('[data-payment-form] [type=submit]');
    submit.disabled = true;
    try {
      order = await api('/orders/' + order.id + '/payments', 'POST', { amountKopecks, note, requestId: paymentRequestId });
      renderOrderHistory();
      notice('Платёж сохранён.');
    } finally {
      submit.disabled = false;
    }
  }, { canRetry: false });
});

find('[data-backup-form]').addEventListener('change', clearBackup);
find('[data-backup-form]').addEventListener('submit', (event) => {
  event.preventDefault();
  const file = event.target.elements.namedItem('backup').files[0];
  clearBackup();
  if (!file || file.size > 16 * 1024 * 1024) return notice('Выберите копию SQLite размером до 16 МБ.', true);
  perform(async () => {
    const encoded = await encodeBackup(file);
    const data = await api('/backup/check', 'POST', { file: encoded });
    if (find('[data-backup-form] input').files[0] !== file) return notice();
    checkedBackup = { file: encoded, token: data.token };
    const summary = find('[data-backup-summary]');
    summary.textContent = 'Копия проверена. Клиентов: ' + data.customers + ', автомобилей: ' + data.vehicles
      + ', мастеров: ' + data.masters + ', заказов: ' + data.service_orders + ', платежей: ' + data.payments + '.';
    summary.hidden = false;
    find('[data-restore]').hidden = false;
    notice();
  }, { canRetry: false });
});

show('home', false);
perform(async () => { await renderHome(); notice(); });
