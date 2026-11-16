ALTER TABLE vehicles ADD COLUMN make TEXT NOT NULL DEFAULT '';
ALTER TABLE vehicles ADD COLUMN vin TEXT COLLATE NOCASE;
CREATE UNIQUE INDEX vehicles_vin_idx ON vehicles(vin) WHERE vin IS NOT NULL;

CREATE TABLE masters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone TEXT NOT NULL DEFAULT '',
  specialty TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;
INSERT INTO masters (name) SELECT DISTINCT advisor_name FROM service_orders ORDER BY advisor_name;

CREATE TABLE service_orders_new (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE CHECK (number > 0),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle_id INTEGER NOT NULL,
  advisor_name TEXT NOT NULL CHECK (length(trim(advisor_name)) > 0),
  promised_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  complaint TEXT,
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'in_progress', 'waiting_parts', 'ready', 'closed', 'cancelled')),
  master_id INTEGER REFERENCES masters(id),
  FOREIGN KEY (vehicle_id, customer_id) REFERENCES vehicles(id, customer_id)
) STRICT;
INSERT INTO service_orders_new
SELECT o.*, m.id FROM service_orders o JOIN masters m ON m.name = o.advisor_name;

CREATE TABLE order_items_new (
  id INTEGER PRIMARY KEY,
  service_order_id INTEGER NOT NULL REFERENCES service_orders_new(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('labor', 'part')),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0)
) STRICT;
INSERT INTO order_items_new SELECT * FROM order_items;
DROP TABLE order_items;
DROP TABLE service_orders;
ALTER TABLE service_orders_new RENAME TO service_orders;
ALTER TABLE order_items_new RENAME TO order_items;
CREATE INDEX service_orders_customer_idx ON service_orders (customer_id, created_at);
CREATE INDEX service_orders_vehicle_idx ON service_orders (vehicle_id, customer_id);
CREATE INDEX service_orders_queue_idx ON service_orders (status, promised_at);
CREATE INDEX service_orders_master_idx ON service_orders (master_id);
CREATE INDEX order_items_order_idx ON order_items (service_order_id);

CREATE TABLE order_status_history (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  from_status TEXT CHECK (from_status IN ('accepted', 'in_progress', 'waiting_parts', 'ready', 'closed', 'cancelled')),
  to_status TEXT NOT NULL CHECK (to_status IN ('accepted', 'in_progress', 'waiting_parts', 'ready', 'closed', 'cancelled')),
  changed_at TEXT NOT NULL,
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1))
) STRICT;
CREATE INDEX status_history_order_idx ON order_status_history(order_id, id);
INSERT INTO order_status_history (order_id, to_status, changed_at, imported)
SELECT id, status, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1 FROM service_orders;
CREATE TRIGGER order_initial_status AFTER INSERT ON service_orders
BEGIN
  INSERT INTO order_status_history (order_id, to_status, changed_at) VALUES (NEW.id, NEW.status, NEW.created_at);
END;
CREATE TRIGGER order_changed_status AFTER UPDATE OF status ON service_orders WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO order_status_history (order_id, from_status, to_status, changed_at)
  VALUES (NEW.id, OLD.status, NEW.status, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES service_orders(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  paid_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL UNIQUE
) STRICT;
CREATE INDEX payments_order_idx ON payments(order_id, id);
CREATE INDEX payments_date_idx ON payments(paid_at);

CREATE TABLE service_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT ''
) STRICT;
INSERT INTO service_settings (id, name) VALUES (1, 'АвтоСервис CRM');
