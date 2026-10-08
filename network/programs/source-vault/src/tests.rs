use crate::{
    message::{self, Header, Transfer},
    processor::ed25519_signers_for_test as ed25519_signers,
    state::validate_guardians,
    token::check_mint_extensions,
};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn fill(v: u8) -> [u8; 32] {
    [v; 32]
}

/// Same inputs as `VECTOR` in packages/protocol/src/wire.test.ts.
fn vector() -> Transfer {
    let deployment_id = message::deployment_id(b"lattice-test-vector-1");
    Transfer {
        header: Header {
            kind: message::KIND_WITHDRAWAL,
            protocol_version: 1,
            scheme: 1,
            deployment_id,
            solana_genesis_hash: fill(1),
            lattice_genesis_hash: fill(2),
            source_program_id: fill(3),
            source_mint: fill(4),
            signer_epoch: 7,
            nonce: 42,
        },
        source_amount: 1_500_000,
        native_amount: 1_500_000_000,
        recipient: fill(5),
        event_id: message::burn_event_id(&deployment_id, 42),
    }
}

#[test]
fn transfer_round_trip_and_layout() {
    let t = vector();
    let bytes = message::encode_transfer(&t);
    assert_eq!(bytes.len(), message::TRANSFER_LEN);
    assert_eq!(&bytes[0..16], b"lattice-bridge/1");
    assert_eq!(bytes[16], 2);
    assert_eq!(&bytes[188..196], &42u64.to_le_bytes());
    assert_eq!(message::parse_transfer(&bytes), Some(t));
    println!("VECTOR_MESSAGE={}", hex(&bytes));
    println!("VECTOR_DIGEST={}", hex(&message::digest(&bytes)));
}

#[test]
fn cross_language_vector() {
    // Files written from the TypeScript encoder (packages/protocol).
    let bytes = message::encode_transfer(&vector());
    assert_eq!(
        hex(&message::deployment_id(b"lattice-test-vector-1")),
        include_str!("../tests/vector-deployment-id.txt").trim()
    );
    assert_eq!(hex(&message::digest(&bytes)), include_str!("../tests/vector-digest.txt").trim());
}

#[test]
fn parse_rejects_wrong_domain_length_and_reserved() {
    let mut bytes = message::encode_transfer(&vector());
    assert!(message::parse_transfer(&bytes[..275]).is_none());
    bytes[19] = 1;
    assert!(message::parse_transfer(&bytes).is_none());
    bytes[19] = 0;
    bytes[0] = b'L';
    assert!(message::parse_transfer(&bytes).is_none());
}

#[test]
fn every_field_changes_the_digest() {
    let base = message::digest(&message::encode_transfer(&vector()));
    let bytes = message::encode_transfer(&vector());
    for i in 0..bytes.len() {
        let mut m = bytes.clone();
        m[i] ^= 1;
        assert_ne!(message::digest(&m), base, "byte {i}");
    }
}

#[test]
fn event_ids_are_distinct_per_sequence_and_direction() {
    let d = message::deployment_id(b"x");
    assert_ne!(message::deposit_event_id(&d, 0), message::deposit_event_id(&d, 1));
    assert_ne!(message::deposit_event_id(&d, 0), message::burn_event_id(&d, 0));
    assert_ne!(message::deposit_event_id(&d, 0), message::deposit_event_id(&message::deployment_id(b"y"), 0));
}

#[test]
fn guardian_set_rules() {
    let k = |i: u8| [i; 32];
    assert!(validate_guardians(2, &[k(1), k(2), k(3)]));
    assert!(!validate_guardians(1, &[k(1)]), "threshold below minimum");
    assert!(!validate_guardians(2, &[k(1), k(2), k(3), k(4)]), "not a strict majority");
    assert!(validate_guardians(3, &[k(1), k(2), k(3), k(4)]));
    assert!(!validate_guardians(2, &[k(1), k(1), k(3)]), "duplicate");
    assert!(!validate_guardians(2, &[k(0), k(2), k(3)]), "zero key");
    assert!(!validate_guardians(5, &[k(1), k(2), k(3)]), "threshold above count");
    let many: Vec<[u8; 32]> = (1..=20).map(k).collect();
    assert!(!validate_guardians(15, &many), "too many guardians");
    assert!(validate_guardians(13, &many[..19]));
}

fn mint_with_extensions(exts: &[(u16, usize)]) -> Vec<u8> {
    let mut d = vec![0u8; 166];
    d[165] = 1;
    for (ty, len) in exts {
        d.extend_from_slice(&ty.to_le_bytes());
        d.extend_from_slice(&(*len as u16).to_le_bytes());
        d.extend(std::iter::repeat(9u8).take(*len));
    }
    d
}

#[test]
fn extension_allowlist() {
    assert!(check_mint_extensions(&mint_with_extensions(&[(18, 64), (19, 120)])).is_ok());
    for blocked in [1u16, 3, 4, 6, 9, 10, 12, 14, 16, 24, 25, 26, 99] {
        assert!(check_mint_extensions(&mint_with_extensions(&[(18, 64), (blocked, 8)])).is_err(), "{blocked}");
    }
    let mut truncated = mint_with_extensions(&[(18, 64)]);
    truncated.truncate(200);
    assert!(check_mint_extensions(&truncated).is_err());
    let mut wrong_type = mint_with_extensions(&[(18, 64)]);
    wrong_type[165] = 2;
    assert!(check_mint_extensions(&wrong_type).is_err());
}

fn ed_ix(entries: &[(u16, u16, u16, u16)], digest: &[u8; 32], pk: &[u8; 32]) -> Vec<u8> {
    // entries: (sig_ix, pk_ix, msg_ix, msg_len); one shared pk/sig/msg body.
    let n = entries.len();
    let body = 2 + 14 * n;
    let (pk_off, sig_off, msg_off) = (body, body + 32, body + 96);
    let mut d = vec![n as u8, 0];
    for (sig_ix, pk_ix, msg_ix, msg_len) in entries {
        for v in [sig_off as u16, *sig_ix, pk_off as u16, *pk_ix, msg_off as u16, *msg_len, *msg_ix] {
            d.extend_from_slice(&v.to_le_bytes());
        }
    }
    d.extend_from_slice(pk);
    d.extend_from_slice(&[0u8; 64]);
    d.extend_from_slice(digest);
    d
}

#[test]
fn ed25519_instruction_parsing() {
    let digest = [7u8; 32];
    let pk = [8u8; 32];
    let m = u16::MAX;
    assert_eq!(ed25519_signers(&ed_ix(&[(m, m, m, 32)], &digest, &pk), &digest).unwrap(), vec![pk]);
    assert!(ed25519_signers(&ed_ix(&[(m, m, m, 32)], &digest, &pk), &[6u8; 32]).is_err(), "other digest");
    assert!(ed25519_signers(&ed_ix(&[(0, m, m, 32)], &digest, &pk), &digest).is_err(), "external sig");
    assert!(ed25519_signers(&ed_ix(&[(m, 1, m, 32)], &digest, &pk), &digest).is_err(), "external key");
    assert!(ed25519_signers(&ed_ix(&[(m, m, 2, 32)], &digest, &pk), &digest).is_err(), "external msg");
    assert!(ed25519_signers(&ed_ix(&[(m, m, m, 31)], &digest, &pk), &digest).is_err(), "short msg");
    assert!(ed25519_signers(&[0, 0], &digest).is_err(), "no signatures");
    assert!(ed25519_signers(&[3, 0, 1, 2], &digest).is_err(), "truncated");
}
