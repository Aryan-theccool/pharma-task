-- =====================================================================
-- Amrutam Telemedicine — initial schema
-- PostgreSQL 16. Idempotent: safe to re-run.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('patient','doctor','admin','support');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Weighted search vector for doctors. Declared IMMUTABLE (and pinned to the
-- 'simple' regconfig) so it can back a STORED generated column.
CREATE OR REPLACE FUNCTION doctor_search_vector(
  p_name text, p_specializations text[], p_languages text[], p_bio text
) RETURNS tsvector
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('simple'::regconfig, coalesce(p_name, '')), 'A')
      || setweight(to_tsvector('simple'::regconfig,
           coalesce(array_to_string(p_specializations, ' '), '')), 'B')
      || setweight(to_tsvector('simple'::regconfig,
           coalesce(array_to_string(p_languages, ' '), '')), 'C')
      || setweight(to_tsvector('simple'::regconfig, coalesce(p_bio, '')), 'D')
$$;

-- ---------------------------------------------------------------------
-- users: email is stored as (a) a deterministic HMAC for lookup and
-- (b) an AES-256-GCM ciphertext for retrieval. Plaintext never lands on disk.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash      BYTEA UNIQUE NOT NULL,
  email_enc       BYTEA NOT NULL,
  phone_enc       BYTEA,
  password_hash   TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'patient',
  mfa_secret_enc  BYTEA,
  mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'active',
  key_version     INT NOT NULL DEFAULT 1,
  failed_logins   INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

CREATE TABLE IF NOT EXISTS profiles (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  dob_enc     BYTEA,
  gender      TEXT,
  address_enc BYTEA,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  locale      TEXT NOT NULL DEFAULT 'en-IN',
  key_version INT  NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- doctors
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctors (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name       TEXT NOT NULL,
  registration_no    TEXT UNIQUE NOT NULL,
  bio                TEXT NOT NULL DEFAULT '',
  specializations    TEXT[] NOT NULL DEFAULT '{}',
  languages          TEXT[] NOT NULL DEFAULT '{}',
  experience_years   INT NOT NULL DEFAULT 0,
  consultation_fee   NUMERIC(10,2) NOT NULL,
  currency           CHAR(3) NOT NULL DEFAULT 'INR',
  rating_avg         NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count       INT NOT NULL DEFAULT 0,
  verification_state TEXT NOT NULL DEFAULT 'pending',
  timezone           TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector      tsvector GENERATED ALWAYS AS (
    doctor_search_vector(display_name, specializations, languages, bio)
  ) STORED
);
CREATE INDEX IF NOT EXISTS doctors_specializations_gin ON doctors USING GIN (specializations);
CREATE INDEX IF NOT EXISTS doctors_languages_gin      ON doctors USING GIN (languages);
CREATE INDEX IF NOT EXISTS doctors_search_gin         ON doctors USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS doctors_name_trgm          ON doctors USING GIN (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS doctors_fee_rating_idx     ON doctors (consultation_fee, rating_avg DESC);
CREATE INDEX IF NOT EXISTS doctors_verified_idx       ON doctors (verification_state) WHERE verification_state = 'verified';

-- ---------------------------------------------------------------------
-- availability: recurring rules -> materialized slots
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS availability_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id    UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  slot_minutes INT NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 5 AND 240),
  valid_from   DATE NOT NULL,
  valid_to     DATE,
  timezone     TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS availability_rules_doctor_idx ON availability_rules (doctor_id, active);

-- The EXCLUDE constraint makes physically overlapping slots for one doctor
-- impossible at the storage layer — defence #1 against double booking.
CREATE TABLE IF NOT EXISTS availability_slots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id  UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  slot_range TSTZRANGE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'available'
             CHECK (status IN ('available','held','booked','blocked')),
  hold_token UUID,
  held_by    UUID,
  held_until TIMESTAMPTZ,
  version    INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT availability_slots_no_overlap
    EXCLUDE USING gist (doctor_id WITH =, slot_range WITH &&)
);
CREATE INDEX IF NOT EXISTS availability_slots_lookup_idx  ON availability_slots (doctor_id, status);
CREATE INDEX IF NOT EXISTS availability_slots_range_gist  ON availability_slots USING gist (slot_range);
CREATE INDEX IF NOT EXISTS availability_slots_expiry_idx  ON availability_slots (held_until) WHERE status = 'held';

-- ---------------------------------------------------------------------
-- consultations — RANGE partitioned monthly on scheduled_at
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consultations (
  id            UUID NOT NULL DEFAULT gen_random_uuid(),
  patient_id    UUID NOT NULL REFERENCES users(id),
  doctor_id     UUID NOT NULL REFERENCES doctors(id),
  slot_id       UUID NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled','in_progress','completed','no_show','cancelled')),
  mode          TEXT NOT NULL DEFAULT 'video',
  scheduled_at  TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,
  chief_complaint TEXT,
  notes_enc     BYTEA,
  key_version   INT NOT NULL DEFAULT 1,
  amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  saga_state    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, scheduled_at)
) PARTITION BY RANGE (scheduled_at);

CREATE INDEX IF NOT EXISTS consultations_patient_idx ON consultations (patient_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS consultations_doctor_idx  ON consultations (doctor_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS consultations_status_idx  ON consultations (status, scheduled_at);
CREATE INDEX IF NOT EXISTS consultations_slot_idx    ON consultations (slot_id);

-- One live consultation per slot — defence #2 against double booking.
--
-- Postgres requires a unique index on a partitioned table to contain the
-- partition key, so the index is (slot_id, scheduled_at). This is still a
-- GLOBAL guarantee rather than a per-partition one: `scheduled_at` is always
-- lower(slot_range) of `slot_id`, so every row referencing a given slot
-- carries the same scheduled_at and therefore lands in the same partition.
-- Two live consultations on one slot always collide here.
CREATE UNIQUE INDEX IF NOT EXISTS consultations_slot_unique
  ON consultations (slot_id, scheduled_at) WHERE status <> 'cancelled';

-- ---------------------------------------------------------------------
-- prescriptions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prescriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  UUID NOT NULL,
  doctor_id        UUID NOT NULL REFERENCES doctors(id),
  patient_id       UUID NOT NULL REFERENCES users(id),
  items_enc        BYTEA NOT NULL,
  diagnosis_enc    BYTEA,
  advice_enc       BYTEA,
  key_version      INT NOT NULL DEFAULT 1,
  signed_at        TIMESTAMPTZ,
  signature        TEXT,
  signature_alg    TEXT,
  pdf_path         TEXT,
  pdf_status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (pdf_status IN ('pending','processing','ready','failed')),
  immutable        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prescriptions_consultation_idx ON prescriptions (consultation_id);
CREATE INDEX IF NOT EXISTS prescriptions_patient_idx      ON prescriptions (patient_id, created_at DESC);

-- ---------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id UUID,
  booking_ref     UUID,
  patient_id      UUID NOT NULL REFERENCES users(id),
  amount          NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  currency        CHAR(3) NOT NULL DEFAULT 'INR',
  status          TEXT NOT NULL DEFAULT 'initiated'
                  CHECK (status IN ('initiated','authorized','captured','refunded','failed','voided')),
  provider        TEXT NOT NULL DEFAULT 'mock',
  provider_ref    TEXT UNIQUE,
  refund_ref      TEXT,
  refunded_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  failure_reason  TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_patient_idx    ON payments (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_booking_idx    ON payments (booking_ref);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  provider_ref  TEXT,
  payload       JSONB NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------------
-- audit_logs — append-only, hash-chained, monthly partitions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id      UUID,
  actor_role    user_role,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  outcome       TEXT NOT NULL DEFAULT 'success',
  ip            INET,
  user_agent    TEXT,
  request_id    TEXT,
  trace_id      TEXT,
  before        JSONB,
  after         JSONB,
  prev_hash     BYTEA,
  row_hash      BYTEA NOT NULL,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx    ON audit_logs (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx   ON audit_logs (action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id);

-- ---------------------------------------------------------------------
-- idempotency
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT PRIMARY KEY,
  user_id         UUID,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed')),
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------
-- transactional outbox
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  id              BIGSERIAL PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    UUID,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  trace_id        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (next_attempt_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------
-- saga instances (resumable orchestration)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga_instances (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL,
  state        TEXT NOT NULL,
  step         TEXT,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  compensations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saga_instances_state_idx ON saga_instances (type, state);

-- ---------------------------------------------------------------------
-- auth support tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   UUID NOT NULL,
  token_hash  TEXT UNIQUE NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  revoked_reason TEXT,
  user_agent  TEXT,
  ip          INET
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx   ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id UUID NOT NULL,
  doctor_id       UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (consultation_id)
);
CREATE INDEX IF NOT EXISTS reviews_doctor_idx ON reviews (doctor_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL,
  template   TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status     TEXT NOT NULL DEFAULT 'queued',
  event_id   TEXT UNIQUE,
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- consumer-side dedupe for at-least-once queue delivery
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     TEXT PRIMARY KEY,
  consumer     TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- encryption key registry (envelope encryption / rotation bookkeeping)
CREATE TABLE IF NOT EXISTS encryption_keys (
  version     INT PRIMARY KEY,
  wrapped_dek TEXT NOT NULL,
  algorithm   TEXT NOT NULL DEFAULT 'AES-256-GCM',
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','retiring','retired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at  TIMESTAMPTZ
);
