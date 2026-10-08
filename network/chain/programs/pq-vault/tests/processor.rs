//! Host tests: drive the real processor with real ML-DSA-65 (fips204, the
//! same crate the fork's syscall uses) and a mock clock/rent.
use {
    fips204::{
        ml_dsa_65,
        traits::{KeyGen, SerDes, Signer, Verifier},
    },
    lattice_pq_vault::{process_instruction, state::*, Runtime, VaultError},
    solana_account_info::AccountInfo,
    solana_program_error::ProgramError,
    solana_pubkey::Pubkey,
    std::cell::Cell,
};

struct MockRuntime {
    slot: Cell<u64>,
}

impl Runtime for MockRuntime {
    fn slot(&self) -> Result<u64, ProgramError> {
        Ok(self.slot.get())
    }
    fn minimum_balance(&self, data_len: usize) -> Result<u64, ProgramError> {
        Ok((data_len as u64 + 128) * 10)
    }
    fn mldsa65_verify(&self, pk: &[u8], msg: &[u8], sig: &[u8]) -> u64 {
        let pk = ml_dsa_65::PublicKey::try_from_bytes(pk.try_into().unwrap()).unwrap();
        if pk.verify(msg, sig.try_into().unwrap(), &[]) { 0 } else { 1 }
    }
}

struct Acct {
    key: Pubkey,
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
}

impl Acct {
    fn new(owner: Pubkey, lamports: u64, len: usize) -> Self {
        Self { key: Pubkey::new_unique(), owner, lamports, data: vec![0; len] }
    }
}

fn run(
    rt: &MockRuntime,
    program_id: &Pubkey,
    accts: &mut [&mut Acct],
    signers: &[bool],
    ix: &[u8],
) -> Result<(), ProgramError> {
    // Snapshot so a failed instruction leaves state untouched, like the runtime.
    let backup: Vec<(u64, Vec<u8>)> = accts.iter().map(|a| (a.lamports, a.data.clone())).collect();
    let result = {
        let infos: Vec<AccountInfo> = accts
            .iter_mut()
            .zip(signers)
            .map(|(a, &s)| AccountInfo::new(&a.key, s, true, &mut a.lamports, &mut a.data, &a.owner, false))
            .collect();
        process_instruction(rt, program_id, &infos, ix)
    };
    if result.is_err() {
        for (a, (l, d)) in accts.iter_mut().zip(backup) {
            a.lamports = l;
            a.data = d;
        }
    }
    result
}

fn custom(e: VaultError) -> ProgramError {
    ProgramError::Custom(e as u32)
}

struct Fixture {
    rt: MockRuntime,
    program_id: Pubkey,
    genesis: [u8; 32],
    sk: ml_dsa_65::PrivateKey,
    pk_bytes: Vec<u8>,
    vault: Acct,
    authority: Acct,
    relayer: Acct,
    recipient: Acct,
}

fn setup() -> Fixture {
    let program_id = Pubkey::new_unique();
    let (pk, sk) = ml_dsa_65::KG::keygen_from_seed(&[42; 32]);
    let pk_bytes = pk.into_bytes().to_vec();
    let mut f = Fixture {
        rt: MockRuntime { slot: Cell::new(100) },
        program_id,
        genesis: [7; 32],
        sk,
        pk_bytes,
        vault: Acct::new(program_id, 1_000_000_000, VAULT_LEN),
        authority: Acct::new(Pubkey::default(), 1, 0),
        relayer: Acct::new(Pubkey::default(), 1_000, 0),
        recipient: Acct::new(Pubkey::default(), 0, 0),
    };
    let mut ix = vec![0];
    ix.extend_from_slice(&f.genesis);
    let (rt, pid) = (&f.rt, f.program_id);
    run(rt, &pid, &mut [&mut f.vault, &mut f.authority], &[true, true], &ix).unwrap();
    for (i, chunk) in f.pk_bytes.clone().chunks(900).enumerate() {
        let mut ix = vec![1];
        ix.extend_from_slice(&((i * 900) as u16).to_le_bytes());
        ix.extend_from_slice(chunk);
        run(&f.rt, &pid, &mut [&mut f.vault, &mut f.authority], &[false, true], &ix).unwrap();
    }
    run(&f.rt, &pid, &mut [&mut f.vault, &mut f.authority], &[false, true], &[2]).unwrap();
    f
}

fn sign(f: &Fixture, genesis: &[u8; 32], recipient: &Pubkey, amount: u64, nonce: u64, expiry: u64) -> Vec<u8> {
    let msg = transfer_message(
        genesis,
        f.program_id.as_ref().try_into().unwrap(),
        f.vault.key.as_ref().try_into().unwrap(),
        recipient.as_ref().try_into().unwrap(),
        amount,
        nonce,
        expiry,
    );
    f.sk.try_sign_with_seed(&[0; 32], &msg, &[]).unwrap().to_vec()
}

fn staged_buffer(f: &mut Fixture, sig: &[u8]) -> Acct {
    let pid = f.program_id;
    let mut buffer = Acct::new(pid, 50_000, BUFFER_LEN);
    let mut vault_ref = Acct { key: f.vault.key, owner: pid, lamports: 0, data: vec![] };
    run(&f.rt, &pid, &mut [&mut buffer, &mut f.relayer, &mut vault_ref], &[true, true, false], &[3]).unwrap();
    for (i, chunk) in sig.chunks(1000).enumerate() {
        let mut ix = vec![4];
        ix.extend_from_slice(&((i * 1000) as u16).to_le_bytes());
        ix.extend_from_slice(chunk);
        run(&f.rt, &pid, &mut [&mut buffer, &mut f.relayer], &[false, true], &ix).unwrap();
    }
    buffer
}

fn execute(f: &mut Fixture, buffer: &mut Acct, amount: u64, nonce: u64, expiry: u64) -> Result<(), ProgramError> {
    let mut ix = vec![5];
    ix.extend_from_slice(&amount.to_le_bytes());
    ix.extend_from_slice(&nonce.to_le_bytes());
    ix.extend_from_slice(&expiry.to_le_bytes());
    let pid = f.program_id;
    run(
        &f.rt,
        &pid,
        &mut [&mut f.vault, buffer, &mut f.recipient, &mut f.relayer],
        &[false, false, false, true],
        &ix,
    )
}

#[test]
fn valid_transfer_then_replay_rejected() {
    let mut f = setup();
    let sig = sign(&f, &f.genesis.clone(), &f.recipient.key.clone(), 1000, 0, 200);
    let mut buf = staged_buffer(&mut f, &sig);
    execute(&mut f, &mut buf, 1000, 0, 200).unwrap();
    assert_eq!(f.recipient.lamports, 1000);
    assert_eq!(read_u64(&f.vault.data, VAULT_NEXT_NONCE), 1);
    assert_eq!(buf.lamports, 0, "buffer is closed after use");
    assert_eq!(f.relayer.lamports, 51_000);

    // Same signature re-staged: nonce 0 was consumed.
    let mut buf = staged_buffer(&mut f, &sig);
    assert_eq!(execute(&mut f, &mut buf, 1000, 0, 200), Err(custom(VaultError::NonceMismatch)));
    // Claiming nonce 1 with the nonce-0 signature fails verification.
    assert_eq!(
        execute(&mut f, &mut buf, 1000, 1, 200),
        Err(ProgramError::Custom(VaultError::SignatureRejected as u32 | 1))
    );
    assert_eq!(f.recipient.lamports, 1000);
}

#[test]
fn tampered_fields_rejected() {
    let mut f = setup();
    let sig = sign(&f, &f.genesis.clone(), &f.recipient.key.clone(), 1000, 0, 200);
    let rejected = Err(ProgramError::Custom(VaultError::SignatureRejected as u32 | 1));
    let mut buf = staged_buffer(&mut f, &sig);
    assert_eq!(execute(&mut f, &mut buf, 1001, 0, 200), rejected, "amount");
    assert_eq!(execute(&mut f, &mut buf, 1000, 0, 201), rejected, "expiry");
    let real_recipient = f.recipient.key;
    f.recipient.key = Pubkey::new_unique();
    assert_eq!(execute(&mut f, &mut buf, 1000, 0, 200), rejected, "recipient");
    f.recipient.key = real_recipient;
    execute(&mut f, &mut buf, 1000, 0, 200).unwrap();
}

#[test]
fn wrong_genesis_and_bad_signature_rejected() {
    let mut f = setup();
    let rejected = Err(ProgramError::Custom(VaultError::SignatureRejected as u32 | 1));
    let sig = sign(&f, &[8; 32], &f.recipient.key.clone(), 1000, 0, 200);
    let mut buf = staged_buffer(&mut f, &sig);
    assert_eq!(execute(&mut f, &mut buf, 1000, 0, 200), rejected, "wrong genesis");

    let mut sig = sign(&f, &f.genesis.clone(), &f.recipient.key.clone(), 1000, 0, 200);
    sig[10] ^= 0xff;
    let mut buf = staged_buffer(&mut f, &sig);
    assert_eq!(execute(&mut f, &mut buf, 1000, 0, 200), rejected, "bit-flipped signature");

    let (_, other_sk) = ml_dsa_65::KG::keygen_from_seed(&[1; 32]);
    let msg = transfer_message(
        &f.genesis,
        f.program_id.as_ref().try_into().unwrap(),
        f.vault.key.as_ref().try_into().unwrap(),
        f.recipient.key.as_ref().try_into().unwrap(),
        1000,
        0,
        200,
    );
    let sig = other_sk.try_sign_with_seed(&[0; 32], &msg, &[]).unwrap();
    let mut buf = staged_buffer(&mut f, &sig);
    assert_eq!(execute(&mut f, &mut buf, 1000, 0, 200), rejected, "wrong key");
    assert_eq!(f.recipient.lamports, 0);
}

#[test]
fn expiry_funds_and_buffer_checks() {
    let mut f = setup();
    let sig = sign(&f, &f.genesis.clone(), &f.recipient.key.clone(), 1000, 0, 200);
    let mut buf = staged_buffer(&mut f, &sig);
    f.rt.slot.set(201);
    assert_eq!(execute(&mut f, &mut buf, 1000, 0, 200), Err(custom(VaultError::Expired)));
    f.rt.slot.set(200);

    let too_much = f.vault.lamports;
    let sig2 = sign(&f, &f.genesis.clone(), &f.recipient.key.clone(), too_much, 0, 200);
    let mut buf2 = staged_buffer(&mut f, &sig2);
    assert_eq!(execute(&mut f, &mut buf2, too_much, 0, 200), Err(custom(VaultError::InsufficientFunds)));

    // Incomplete signature buffer.
    let pid = f.program_id;
    let mut partial = Acct::new(pid, 50_000, BUFFER_LEN);
    let mut vault_ref = Acct { key: f.vault.key, owner: pid, lamports: 0, data: vec![] };
    run(&f.rt, &pid, &mut [&mut partial, &mut f.relayer, &mut vault_ref], &[true, true, false], &[3]).unwrap();
    assert_eq!(execute(&mut f, &mut partial, 1000, 0, 200), Err(custom(VaultError::SignatureIncomplete)));

    // Out-of-order write.
    let mut ix = vec![4, 5, 0];
    ix.extend_from_slice(&[1; 10]);
    assert_eq!(
        run(&f.rt, &pid, &mut [&mut partial, &mut f.relayer], &[false, true], &ix),
        Err(custom(VaultError::OutOfOrderWrite))
    );

    execute(&mut f, &mut buf, 1000, 0, 200).unwrap();
}

#[test]
fn sealed_vault_rejects_setup_authority() {
    let mut f = setup();
    let pid = f.program_id;
    let mut ix = vec![1, 0, 0];
    ix.extend_from_slice(&[0; 32]);
    assert_eq!(
        run(&f.rt, &pid, &mut [&mut f.vault, &mut f.authority], &[false, true], &ix),
        Err(custom(VaultError::NotLoading))
    );
    assert_eq!(&f.vault.data[VAULT_PUBLIC_KEY], f.pk_bytes.as_slice());
    let mut reinit = vec![0];
    reinit.extend_from_slice(&[0; 32]);
    assert_eq!(
        run(&f.rt, &pid, &mut [&mut f.vault, &mut f.authority], &[true, true], &reinit),
        Err(custom(VaultError::AlreadyInitialized))
    );
}
