-- ============================================================
-- THE GREEN ACRE — POSTGRESQL SCHEMA
-- Version 1.0 | June 2025
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── MANAGERS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS managers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(60)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(80)  NOT NULL DEFAULT 'Manager',
  phone         VARCHAR(20),
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_managers_username ON managers(username);

-- ── DEFAULT RATES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS default_rates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_type         VARCHAR(10) NOT NULL CHECK (day_type IN ('weekday','weekend')),
  day_slot_rate    DECIMAL(10,2) NOT NULL DEFAULT 6000,
  night_slot_rate  DECIMAL(10,2) NOT NULL DEFAULT 7000,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(day_type)
);

-- ── PRICING RULES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pricing_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_date      DATE        NOT NULL UNIQUE,
  label_name       VARCHAR(20) NOT NULL DEFAULT 'NORMAL'
                     CHECK (label_name IN ('NORMAL','WEEKEND','HOLI','DIWALI','EID','CHRISTMAS','NEW_YEAR','PEAK')),
  day_slot_rate    DECIMAL(10,2),
  night_slot_rate  DECIMAL(10,2),
  is_closed        BOOLEAN NOT NULL DEFAULT FALSE,
  notes            VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pricing_rules_date ON pricing_rules(target_date);

-- ── BOOKINGS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id              VARCHAR(20)   PRIMARY KEY,
  guest_name      VARCHAR(120)  NOT NULL,
  guest_phone     VARCHAR(20)   NOT NULL,
  guest_email     VARCHAR(120),
  guest_count     INTEGER       NOT NULL CHECK (guest_count > 0),
  occasion        VARCHAR(80),
  notes           TEXT,
  booking_date    DATE          NOT NULL,
  slot            VARCHAR(5)    NOT NULL CHECK (slot IN ('day','night')),
  rate_applied    DECIMAL(10,2) NOT NULL,
  rate_label      VARCHAR(20)   NOT NULL DEFAULT 'NORMAL',
  status          VARCHAR(12)   NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','CONFIRMED','RELEASED','CANCELLED')),
  policy_agreed   BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  released_at     TIMESTAMPTZ,
  manager_notes   TEXT
);

CREATE INDEX idx_bookings_status      ON bookings(status);
CREATE INDEX idx_bookings_date        ON bookings(booking_date);
CREATE INDEX idx_bookings_date_slot   ON bookings(booking_date, slot);
CREATE INDEX idx_bookings_created_at  ON bookings(created_at DESC);

-- Prevent double booking same date+slot when active
CREATE UNIQUE INDEX idx_bookings_no_double
  ON bookings(booking_date, slot)
  WHERE status IN ('PENDING','CONFIRMED');

-- ── BOOKING STATUS HISTORY ────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_status_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   VARCHAR(20) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  old_status   VARCHAR(12),
  new_status   VARCHAR(12) NOT NULL,
  changed_by   UUID REFERENCES managers(id),
  notes        TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bsh_booking_id ON booking_status_history(booking_id);

-- ── BLACKOUT DATES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blackout_dates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_from    DATE NOT NULL,
  date_to      DATE NOT NULL,
  reason       VARCHAR(200) NOT NULL,
  created_by   UUID REFERENCES managers(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (date_to >= date_from)
);

CREATE INDEX idx_blackout_dates_from ON blackout_dates(date_from);
CREATE INDEX idx_blackout_dates_to   ON blackout_dates(date_to);

-- ── POLICY CONTENT ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_content (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_key  VARCHAR(40) NOT NULL UNIQUE,
  title        VARCHAR(100) NOT NULL,
  content_text TEXT         NOT NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── REVIEWS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_name   VARCHAR(120) NOT NULL,
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text  TEXT NOT NULL,
  occasion     VARCHAR(80),
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  booking_id   VARCHAR(20) REFERENCES bookings(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reviews_published ON reviews(is_published, created_at DESC);

-- ── PROPERTY CONTENT ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_content (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          VARCHAR(60)  NOT NULL UNIQUE,
  value        TEXT         NOT NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── AUDIT LOGS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id  UUID REFERENCES managers(id),
  action      VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40),
  entity_id   VARCHAR(60),
  details     JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_manager   ON audit_logs(manager_id);
CREATE INDEX idx_audit_logs_entity    ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created   ON audit_logs(created_at DESC);

-- ============================================================
-- SEED DATA
-- ============================================================

-- Default rates (weekday / weekend)
INSERT INTO default_rates (day_type, day_slot_rate, night_slot_rate) VALUES
  ('weekday', 6000, 7000),
  ('weekend', 7500, 9000)
ON CONFLICT (day_type) DO NOTHING;

-- Peak pricing rules for 2025-2026
INSERT INTO pricing_rules (target_date, label_name, day_slot_rate, night_slot_rate, notes) VALUES
  -- Holi 2025
  ('2025-03-14', 'HOLI',    12000, 14000, 'Holi festival'),
  -- Eid al-Fitr 2025
  ('2025-03-31', 'EID',     10000, 12000, 'Eid al-Fitr'),
  -- Christmas
  ('2025-12-25', 'CHRISTMAS', 12000, 14000, 'Christmas Day'),
  ('2025-12-24', 'CHRISTMAS', 11000, 13000, 'Christmas Eve'),
  -- New Year
  ('2025-12-31', 'NEW_YEAR', 14000, 16000, 'New Year Eve'),
  ('2026-01-01', 'NEW_YEAR', 13000, 15000, 'New Year Day'),
  -- Diwali 2025 (Oct 20-23)
  ('2025-10-20', 'DIWALI', 12000, 14000, 'Diwali'),
  ('2025-10-21', 'DIWALI', 13000, 15000, 'Diwali main day'),
  ('2025-10-22', 'DIWALI', 12000, 14000, 'Diwali'),
  ('2025-10-23', 'DIWALI', 11000, 13000, 'Diwali'),
  -- Eid 2026
  ('2026-03-20', 'EID',     10000, 12000, 'Eid al-Fitr 2026')
ON CONFLICT (target_date) DO NOTHING;

-- Policy content
INSERT INTO policy_content (section_key, title, content_text) VALUES
  ('checkout_policy', 'Check-In & Check-Out Policy',
   E'• Day Slot (8:00 AM – 8:00 PM): Check-in begins at 8:00 AM sharp. All guests and belongings must vacate the property by 8:00 PM.\n• Night Slot (8:00 PM – 8:00 AM): Check-in begins at 8:00 PM. All guests must leave by 8:00 AM the following morning.\n• Late departure may incur an additional charge of ₹2,000 per hour at the manager\'s discretion.\n• Early access before your slot time is not guaranteed and depends on availability.'),

  ('cleanliness', 'Cleanliness & Property Care',
   E'• A standard cleaning fee is included in your booking rate. Guests are expected to leave the property in a reasonably clean and tidy condition.\n• Guests are liable for any damage to property, furniture, or equipment beyond normal wear and tear.\n• All crockery, utensils, and outdoor furniture must be returned to their original positions before departure.\n• Waste must be separated into bins provided — no littering on the grounds or surrounding areas.\n• The pool area must be kept free of glass items at all times.'),

  ('pool_safety', 'Pool & Outdoor Safety',
   E'• The swimming pool is for the exclusive use of booked guests only. No outside visitors are permitted.\n• Children under 12 must be supervised by an adult at all times in and around the pool.\n• Diving, jumping from the pool fence, or aggressive play that endangers other guests is strictly prohibited.\n• The pool caretaker is on call — however, guests swim at their own risk. No lifeguard is on duty.\n• Pool use is permitted from 7:00 AM to 10:00 PM only.'),

  ('house_rules', 'General House Rules',
   E'• Music and outdoor activity must end by 11:00 PM out of respect for the surrounding area.\n• Guests are responsible for the behaviour of all individuals in their group.\n• The property is strictly no-smoking indoors. Smoking is permitted only in designated outdoor areas.\n• Pets are not permitted on the property.\n• No outside guests or visitors are allowed on the premises during the booking period.\n• Firearms, fireworks, and illegal substances are strictly prohibited.\n• The manager or caretaker reserves the right to ask guests to vacate the premises in case of gross misconduct without refund.')
ON CONFLICT (section_key) DO NOTHING;

-- Sample published reviews
INSERT INTO reviews (guest_name, rating, review_text, occasion, is_published) VALUES
  ('Priya Sharma', 5, 'Absolutely stunning property! The pool was crystal clear, the rooms were spotless, and the caretaker was incredibly helpful. We celebrated my daughter''s birthday here and it was perfect. Will definitely book again.', 'Birthday Party', TRUE),
  ('Rohan Mehta', 5, 'Best farmhouse experience we''ve had. Complete privacy, beautiful grounds, and the night slot was magical under the stars. The booking process was seamless and the team was very responsive.', 'Family Gathering', TRUE),
  ('Ananya Patel', 4, 'Lovely property with great amenities. Kids had a wonderful time at the play area and pool. The only minor thing was that the WiFi was a bit slow, but otherwise everything was perfect. Highly recommended!', 'Family Trip', TRUE),
  ('Vikram Singh', 5, 'We booked this for a corporate team outing and it exceeded all expectations. Spacious grounds, excellent facilities, and very professional management. The WhatsApp confirmation process was quick and easy.', 'Corporate Outing', TRUE),
  ('Meera Krishnan', 5, 'Such a hidden gem! We''ve been to many farmhouses around Pune but this one stands out for its cleanliness, privacy, and value for money. The peak pricing is absolutely worth it for the holidays.', 'Anniversary Celebration', TRUE)
ON CONFLICT DO NOTHING;

-- Property content / settings
INSERT INTO property_content (key, value) VALUES
  ('property_name', 'The Green Acre'),
  ('property_location', 'Pune, Maharashtra, India'),
  ('manager_whatsapp', '919876543210'),
  ('whatsapp_enabled', 'true'),
  ('auto_release_hours', '48'),
  ('max_guests', '30'),
  ('property_description', 'A premium private farmhouse retreat exclusively yours — pool, open grounds, and complete privacy for your group.')
ON CONFLICT (key) DO NOTHING;

-- Default manager account (password: GreenAcre@2025)
-- Hash generated with bcrypt 12 rounds
-- IMPORTANT: Change this password immediately after first login
INSERT INTO managers (username, display_name, password_hash) VALUES
  ('manager@greenacre', 'Property Manager',
   '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewbN3bnqJKST3I.6')
ON CONFLICT (username) DO NOTHING;
