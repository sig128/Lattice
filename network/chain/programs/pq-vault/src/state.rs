//! Account layouts and the canonical signed message. Everything here is pure
//! so it can be unit tested on the host.

pub const MLDSA65_PUBLIC_KEY_LEN: usize = 1952;
pub const MLDSA65_SIGNATURE_LEN: usize = 3309;
pub const ALGORITHM_MLDSA65_V1: u8 = 1;

pub const VAULT_MAGIC: [u8; 8] = *b"LTPQVLT1";
pub const VAULT_STATE_LOADING: u8 = 0;
pub const VAULT_STATE_SEALED: u8 = 1;
pub const VAULT_SETUP_AUTHORITY: core::ops::Range<usize> = 16..48;
pub const VAULT_GENESIS_HASH: core::ops::Range<usize> = 48..80;
pub const VAULT_NEXT_NONCE: core::ops::Range<usize> = 80..88;
pub const VAULT_KEY_WRITTEN: core::ops::Range<usize> = 88..90;
pub const VAULT_PUBLIC_KEY: core::ops::Range<usize> = 96..96 + MLDSA65_PUBLIC_KEY_LEN;
pub const VAULT_LEN: usize = 2048;

pub const BUFFER_MAGIC: [u8; 8] = *b"LTPQSIG1";
pub const BUFFER_RELAYER: core::ops::Range<usize> = 8..40;
pub const BUFFER_VAULT: core::ops::Range<usize> = 40..72;
pub const BUFFER_WRITTEN: core::ops::Range<usize> = 72..74;
pub const BUFFER_SIGNATURE: core::ops::Range<usize> = 80..80 + MLDSA65_SIGNATURE_LEN;
pub const BUFFER_LEN: usize = 3392;

pub const MESSAGE_DOMAIN: &[u8] = b"lattice-pq-vault-transfer";
pub const MESSAGE_VERSION: u8 = 1;
pub const MESSAGE_LEN: usize = 1 + MESSAGE_DOMAIN.len() + 1 + 1 + 32 * 4 + 8 * 3;

/// Canonical transfer authorization. Fixed-width fields, little-endian
/// integers, length-prefixed domain tag:
/// `len(domain) || domain || version || algorithm || genesis_hash ||
///  program_id || vault || recipient || amount || nonce || expiry_slot`.
pub fn transfer_message(
    genesis_hash: &[u8; 32],
    program_id: &[u8; 32],
    vault: &[u8; 32],
    recipient: &[u8; 32],
    amount: u64,
    nonce: u64,
    expiry_slot: u64,
) -> [u8; MESSAGE_LEN] {
    let mut out = [0u8; MESSAGE_LEN];
    let mut at = 0;
    let mut put = |bytes: &[u8]| {
        out[at..at + bytes.len()].copy_from_slice(bytes);
        at += bytes.len();
    };
    put(&[MESSAGE_DOMAIN.len() as u8]);
    put(MESSAGE_DOMAIN);
    put(&[MESSAGE_VERSION, ALGORITHM_MLDSA65_V1]);
    put(genesis_hash);
    put(program_id);
    put(vault);
    put(recipient);
    put(&amount.to_le_bytes());
    put(&nonce.to_le_bytes());
    put(&expiry_slot.to_le_bytes());
    out
}

pub fn read_u16(data: &[u8], range: core::ops::Range<usize>) -> u16 {
    u16::from_le_bytes(data[range].try_into().unwrap())
}

pub fn read_u64(data: &[u8], range: core::ops::Range<usize>) -> u64 {
    u64::from_le_bytes(data[range].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_fit() {
        assert!(VAULT_PUBLIC_KEY.end <= VAULT_LEN);
        assert!(BUFFER_SIGNATURE.end <= BUFFER_LEN);
        assert_eq!(MESSAGE_LEN, 180);
    }

    /// Same vector as `GOLDEN_HEX` in packages/crypto/src/pqVault.test.ts.
    #[test]
    fn golden_vector_matches_ts_client() {
        let m = transfer_message(&[1; 32], &[2; 32], &[3; 32], &[4; 32], 5, 6, 7);
        let mut expected = vec![25u8];
        expected.extend_from_slice(b"lattice-pq-vault-transfer");
        expected.extend_from_slice(&[1, 1]);
        for b in 1..=4u8 {
            expected.extend_from_slice(&[b; 32]);
        }
        for v in [5u64, 6, 7] {
            expected.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(m.as_slice(), expected.as_slice());
    }

    #[test]
    fn message_binds_every_field() {
        let base = transfer_message(&[1; 32], &[2; 32], &[3; 32], &[4; 32], 5, 6, 7);
        let variants = [
            transfer_message(&[9; 32], &[2; 32], &[3; 32], &[4; 32], 5, 6, 7),
            transfer_message(&[1; 32], &[9; 32], &[3; 32], &[4; 32], 5, 6, 7),
            transfer_message(&[1; 32], &[2; 32], &[9; 32], &[4; 32], 5, 6, 7),
            transfer_message(&[1; 32], &[2; 32], &[3; 32], &[9; 32], 5, 6, 7),
            transfer_message(&[1; 32], &[2; 32], &[3; 32], &[4; 32], 9, 6, 7),
            transfer_message(&[1; 32], &[2; 32], &[3; 32], &[4; 32], 5, 9, 7),
            transfer_message(&[1; 32], &[2; 32], &[3; 32], &[4; 32], 5, 6, 9),
        ];
        for v in variants {
            assert_ne!(base, v);
        }
        assert_eq!(&base[1..1 + MESSAGE_DOMAIN.len()], MESSAGE_DOMAIN);
        assert_eq!(&base[MESSAGE_LEN - 8..], &7u64.to_le_bytes());
    }
}
