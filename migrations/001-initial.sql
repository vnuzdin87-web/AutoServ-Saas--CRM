CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone TEXT,
  email TEXT,
  contact_note TEXT
) STRICT;

CREATE TABLE vehicles (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  plate TEXT,
  UNIQUE (id, customer_id)
) STRICT;

CREATE TABLE service_orders (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE CHECK (number > 0),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle_id INTEGER NOT NULL,
  advisor_name TEXT NOT NULL CHECK (length(trim(advisor_name)) > 0),
  promised_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  complaint TEXT,
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'in_progress', 'waiting_parts', 'ready', 'closed')),
  FOREIGN KEY (vehicle_id, customer_id) REFERENCES vehicles(id, customer_id)
) STRICT;

CREATE INDEX service_orders_customer_idx ON service_orders (customer_id, created_at);
CREATE INDEX service_orders_vehicle_idx ON service_orders (vehicle_id, customer_id);
CREATE INDEX service_orders_queue_idx ON service_orders (status, promised_at);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  service_order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('labor', 'part')),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0)
) STRICT;

CREATE INDEX order_items_order_idx ON order_items (service_order_id);
