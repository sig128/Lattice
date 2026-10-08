-- Lattice bridge relayer schema v1. Amounts and sequence numbers are u64 on
-- chain and stored as numeric(20,0) so no value is ever rounded.

CREATE TABLE bridge_claims (
  deployment_id   bytea        NOT NULL CHECK (octet_length(deployment_id) = 32),
  direction       text         NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
  nonce           numeric(20,0) NOT NULL CHECK (nonce >= 0 AND nonce <= 18446744073709551615),
  event_id        bytea        NOT NULL CHECK (octet_length(event_id) = 32),
  state           text         NOT NULL CHECK (state IN ('observed', 'finalized', 'authorized', 'submitted', 'completed', 'failed')),
  source_amount   numeric(20,0) CHECK (source_amount > 0),
  native_amount   numeric(20,0) CHECK (native_amount > 0),
  recipient       bytea        CHECK (octet_length(recipient) = 32),
  observed_slot   numeric(20,0),
  finalized_slot  numeric(20,0),
  message         bytea,
  digest          bytea        CHECK (octet_length(digest) = 32),
  signer_epoch    numeric(20,0),
  submit_attempts integer      NOT NULL DEFAULT 0,
  last_submit_tx  text,
  last_submit_at  timestamptz,
  completed_slot  numeric(20,0),
  failure_reason  text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, direction, nonce),
  UNIQUE (event_id),
  UNIQUE (digest),
  CHECK (state IN ('observed', 'failed') OR (message IS NOT NULL AND digest IS NOT NULL))
);

CREATE INDEX bridge_claims_active ON bridge_claims (direction, nonce)
  WHERE state NOT IN ('completed', 'failed');

CREATE TABLE claim_signatures (
  digest          bytea   NOT NULL CHECK (octet_length(digest) = 32),
  guardian_index  integer NOT NULL CHECK (guardian_index BETWEEN 0 AND 18),
  guardian_key    bytea   NOT NULL CHECK (octet_length(guardian_key) = 32),
  signature       bytea   NOT NULL CHECK (octet_length(signature) = 64),
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest, guardian_index)
);

CREATE TABLE claim_transitions (
  id            bigserial PRIMARY KEY,
  deployment_id bytea   NOT NULL,
  direction     text    NOT NULL,
  nonce         numeric(20,0) NOT NULL,
  from_state    text,
  to_state      text    NOT NULL,
  detail        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (deployment_id, direction, nonce) REFERENCES bridge_claims (deployment_id, direction, nonce)
);

CREATE TABLE reconciliation_samples (
  id            bigserial PRIMARY KEY,
  observed_at   timestamptz NOT NULL,
  solana_slot   numeric(20,0) NOT NULL,
  lattice_slot  numeric(20,0) NOT NULL,
  reserves      numeric(40,0) NOT NULL,
  circulating   numeric(40,0) NOT NULL,
  pending_deposits    numeric(40,0) NOT NULL,
  pending_withdrawals numeric(40,0) NOT NULL,
  backed        boolean NOT NULL,
  label         text    NOT NULL,
  payload       jsonb   NOT NULL
);
