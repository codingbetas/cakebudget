CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL,
  estimate_lo integer     NOT NULL,
  estimate_hi integer     NOT NULL,
  payer_name  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id         bigserial PRIMARY KEY,
  event_id   bigint      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label      text        NOT NULL,
  amount     integer     NOT NULL
);

CREATE TABLE IF NOT EXISTS contributors (
  id         bigserial PRIMARY KEY,
  event_id   bigint      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  pledged    integer     NOT NULL,
  paid       boolean     NOT NULL DEFAULT false,
  note       text        NOT NULL DEFAULT ''
);

-- Seed only if empty
INSERT INTO events (name, estimate_lo, estimate_hi, payer_name)
SELECT 'Birthday Cake', 400, 500, 'Harshit'
WHERE NOT EXISTS (SELECT 1 FROM events);

INSERT INTO items (event_id, label, amount)
SELECT e.id, x.label, x.amount FROM events e, (VALUES
  ('Cake', 500),
  ('Extras (plates, candles, snacks)', 100)
) AS x(label, amount)
WHERE e.name = 'Birthday Cake'
  AND NOT EXISTS (SELECT 1 FROM items WHERE event_id = e.id);

INSERT INTO contributors (event_id, name, pledged, note)
SELECT e.id, x.name, x.pledged, x.note FROM events e, (VALUES
  ('Himanshu', 120, ''),
  ('Tushar',   120, 'uncle''s son'),
  ('Bhavesh',   50, 'Harshit''s elder brother'),
  ('Sumit',     50, 'Harshit''s younger brother'),
  ('Tarun',     40, 'friend'),
  ('Harshit',  220, 'paid upfront, covers the overage'),
  ('Freebie',    0, 'comes to eat')
) AS x(name, pledged, note)
WHERE e.name = 'Birthday Cake'
  AND NOT EXISTS (SELECT 1 FROM contributors WHERE event_id = e.id);