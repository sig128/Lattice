-- Hybrid (Ed25519 + ML-DSA-65) Lattice guardian sets: NATIVE_ISSUANCE.md §6.
ALTER TABLE claim_signatures
  ADD COLUMN mldsa_signature bytea CHECK (mldsa_signature IS NULL OR octet_length(mldsa_signature) = 3309);
