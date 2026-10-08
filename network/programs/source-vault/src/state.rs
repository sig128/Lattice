//! Fixed account layouts. Offsets are normative: docs/BRIDGE_SPEC.md §7.

pub const MAX_GUARDIANS: usize = 19;
pub const MIN_THRESHOLD: u8 = 2;

pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_VAULT_AUTHORITY: &[u8] = b"vault-authority";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_GUARDIAN_SET: &[u8] = b"guardian-set";
pub const SEED_ATTESTATION: &[u8] = b"attestation";
pub const SEED_DEPOSIT: &[u8] = b"deposit";
pub const SEED_WITHDRAWAL: &[u8] = b"withdrawal";

pub const LAYOUT_VERSION: u8 = 1;

pub fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
pub fn rd_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
pub fn rd_u128(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}
pub fn rd_32(d: &[u8], o: usize) -> [u8; 32] {
    d[o..o + 32].try_into().unwrap()
}
pub fn wr(d: &mut [u8], o: usize, v: &[u8]) {
    d[o..o + v.len()].copy_from_slice(v);
}

pub mod config {
    pub const MAGIC: &[u8; 8] = b"LBSCFG01";
    pub const LEN: usize = 392;
    pub const VERSION: usize = 8;
    pub const BUMP: usize = 9;
    pub const VAULT_AUTHORITY_BUMP: usize = 10;
    pub const VAULT_BUMP: usize = 11;
    pub const DECIMALS: usize = 12;
    pub const FLAGS: usize = 13;
    pub const DEPLOYMENT_ID: usize = 16;
    pub const SOLANA_GENESIS: usize = 48;
    pub const LATTICE_GENESIS: usize = 80;
    pub const MINT: usize = 112;
    pub const TOKEN_PROGRAM: usize = 144;
    pub const VAULT: usize = 176;
    pub const PAUSER: usize = 208;
    pub const EPOCH: usize = 240;
    pub const NEXT_DEPOSIT_SEQ: usize = 248;
    pub const GOVERNANCE_SEQ: usize = 256;
    pub const TOTAL_DEPOSITED: usize = 264;
    pub const TOTAL_RELEASED: usize = 280;
    pub const DEPOSIT_CAP: usize = 296;
    pub const RATE_WINDOW_SECS: usize = 304;
    pub const MAX_DEPOSIT_PER_WINDOW: usize = 312;
    pub const MAX_WITHDRAWAL_PER_WINDOW: usize = 320;
    pub const WINDOW_START: usize = 328;
    pub const DEPOSITED_IN_WINDOW: usize = 336;
    pub const WITHDRAWN_IN_WINDOW: usize = 344;
    pub const RELEASED_COUNT: usize = 352;

    pub const FLAG_DEPOSITS_PAUSED: u8 = 1;
    pub const FLAG_WITHDRAWALS_PAUSED: u8 = 2;
}

pub mod guardian_set {
    pub const MAGIC: &[u8; 8] = b"LBSGSET1";
    pub const LEN: usize = 648;
    pub const BUMP: usize = 9;
    pub const SCHEME: usize = 10;
    pub const THRESHOLD: usize = 11;
    pub const COUNT: usize = 12;
    pub const EPOCH: usize = 16;
    pub const CREATED_SLOT: usize = 24;
    pub const KEYS: usize = 40;
}

pub mod attestation {
    pub const MAGIC: &[u8; 8] = b"LBSATST1";
    pub const LEN: usize = 88;
    pub const BUMP: usize = 9;
    pub const BITMAP: usize = 12;
    pub const EPOCH: usize = 16;
    pub const DIGEST: usize = 24;
    pub const PAYER: usize = 56;
}

pub mod receipt {
    pub const MAGIC: &[u8; 8] = b"LBSDEPO1";
    pub const LEN: usize = 224;
    pub const BUMP: usize = 9;
    pub const SEQUENCE: usize = 16;
    pub const EVENT_ID: usize = 24;
    pub const DEPOSITOR: usize = 56;
    pub const DEPOSITOR_TOKEN: usize = 88;
    pub const RECIPIENT: usize = 120;
    pub const REQUESTED: usize = 152;
    pub const CREDITED: usize = 160;
    pub const NATIVE: usize = 168;
    pub const SLOT: usize = 176;
    pub const TIMESTAMP: usize = 184;
    pub const DEPLOYMENT_ID: usize = 192;
}

pub mod consumed {
    pub const MAGIC: &[u8; 8] = b"LBSWDRL1";
    pub const LEN: usize = 176;
    pub const BUMP: usize = 9;
    pub const NONCE: usize = 16;
    pub const EVENT_ID: usize = 24;
    pub const RECIPIENT: usize = 56;
    pub const RECIPIENT_TOKEN: usize = 88;
    pub const AMOUNT: usize = 120;
    pub const SLOT: usize = 128;
    pub const TIMESTAMP: usize = 136;
    pub const DIGEST: usize = 144;
}

/// Guardian-set validity rules shared by Initialize and RotateGuardians.
pub fn validate_guardians(threshold: u8, keys: &[[u8; 32]]) -> bool {
    let n = keys.len();
    if n == 0 || n > MAX_GUARDIANS || threshold < MIN_THRESHOLD || threshold as usize > n {
        return false;
    }
    if 2 * (threshold as usize) <= n {
        return false;
    }
    for (i, k) in keys.iter().enumerate() {
        if k.iter().all(|b| *b == 0) || keys[..i].contains(k) {
            return false;
        }
    }
    true
}
