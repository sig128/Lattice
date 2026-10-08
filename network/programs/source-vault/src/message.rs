//! Canonical bridge message, wire version 1. See docs/BRIDGE_SPEC.md §3.

use solana_program::hash::hashv;

pub const DOMAIN: &[u8; 16] = b"lattice-bridge/1";
pub const PROTOCOL_VERSION: u8 = 1;
pub const SCHEME_ED25519: u8 = 1;

pub const KIND_DEPOSIT: u8 = 1;
pub const KIND_WITHDRAWAL: u8 = 2;
pub const KIND_SOURCE_GOVERNANCE: u8 = 3;
pub const KIND_DESTINATION_GOVERNANCE: u8 = 4;

pub const HEADER_LEN: usize = 196;
pub const TRANSFER_LEN: usize = 276;

pub const ACTION_ROTATE: u8 = 1;
pub const ACTION_SET_PAUSE: u8 = 2;
pub const ACTION_SET_LIMITS: u8 = 3;
pub const ACTION_SET_PAUSER: u8 = 4;

pub const DEPLOYMENT_TAG: &[u8] = b"lattice-bridge/1:deployment";
pub const DEPOSIT_EVENT_TAG: &[u8] = b"lattice-bridge/1:deposit-event";
pub const BURN_EVENT_TAG: &[u8] = b"lattice-bridge/1:burn-event";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub kind: u8,
    pub protocol_version: u8,
    pub scheme: u8,
    pub deployment_id: [u8; 32],
    pub solana_genesis_hash: [u8; 32],
    pub lattice_genesis_hash: [u8; 32],
    pub source_program_id: [u8; 32],
    pub source_mint: [u8; 32],
    pub signer_epoch: u64,
    pub nonce: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transfer {
    pub header: Header,
    pub source_amount: u64,
    pub native_amount: u64,
    pub recipient: [u8; 32],
    pub event_id: [u8; 32],
}

pub fn a32(d: &[u8], o: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&d[o..o + 32]);
    out
}

pub fn u64_at(d: &[u8], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[o..o + 8]);
    u64::from_le_bytes(b)
}

/// Parses the fixed header. Returns `None` for short input or a wrong domain /
/// non-zero reserved byte; semantic checks happen in the processor.
pub fn parse_header(d: &[u8]) -> Option<Header> {
    if d.len() < HEADER_LEN || &d[0..16] != DOMAIN || d[19] != 0 {
        return None;
    }
    Some(Header {
        kind: d[16],
        protocol_version: d[17],
        scheme: d[18],
        deployment_id: a32(d, 20),
        solana_genesis_hash: a32(d, 52),
        lattice_genesis_hash: a32(d, 84),
        source_program_id: a32(d, 116),
        source_mint: a32(d, 148),
        signer_epoch: u64_at(d, 180),
        nonce: u64_at(d, 188),
    })
}

pub fn parse_transfer(d: &[u8]) -> Option<Transfer> {
    if d.len() != TRANSFER_LEN {
        return None;
    }
    Some(Transfer {
        header: parse_header(d)?,
        source_amount: u64_at(d, 196),
        native_amount: u64_at(d, 204),
        recipient: a32(d, 212),
        event_id: a32(d, 244),
    })
}

pub fn encode_header(h: &Header, out: &mut Vec<u8>) {
    out.extend_from_slice(DOMAIN);
    out.extend_from_slice(&[h.kind, h.protocol_version, h.scheme, 0]);
    out.extend_from_slice(&h.deployment_id);
    out.extend_from_slice(&h.solana_genesis_hash);
    out.extend_from_slice(&h.lattice_genesis_hash);
    out.extend_from_slice(&h.source_program_id);
    out.extend_from_slice(&h.source_mint);
    out.extend_from_slice(&h.signer_epoch.to_le_bytes());
    out.extend_from_slice(&h.nonce.to_le_bytes());
}

pub fn encode_transfer(t: &Transfer) -> Vec<u8> {
    let mut out = Vec::with_capacity(TRANSFER_LEN);
    encode_header(&t.header, &mut out);
    out.extend_from_slice(&t.source_amount.to_le_bytes());
    out.extend_from_slice(&t.native_amount.to_le_bytes());
    out.extend_from_slice(&t.recipient);
    out.extend_from_slice(&t.event_id);
    out
}

pub fn digest(message: &[u8]) -> [u8; 32] {
    hashv(&[message]).to_bytes()
}

pub fn deployment_id(label: &[u8]) -> [u8; 32] {
    hashv(&[DEPLOYMENT_TAG, label]).to_bytes()
}

pub fn deposit_event_id(deployment_id: &[u8; 32], sequence: u64) -> [u8; 32] {
    hashv(&[DEPOSIT_EVENT_TAG, deployment_id, &sequence.to_le_bytes()]).to_bytes()
}

pub fn burn_event_id(deployment_id: &[u8; 32], sequence: u64) -> [u8; 32] {
    hashv(&[BURN_EVENT_TAG, deployment_id, &sequence.to_le_bytes()]).to_bytes()
}
