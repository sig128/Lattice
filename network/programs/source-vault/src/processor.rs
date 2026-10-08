use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    ed25519_program,
    entrypoint::ProgramResult,
    log::sol_log_data,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::{instructions as ix_sysvar, Sysvar},
};
use solana_system_interface::instruction as system_instruction;

use crate::{
    error::VaultError,
    message::{self, Header},
    state::{self, attestation, config, consumed, guardian_set, rd_32, rd_i64, rd_u128, rd_u64, receipt, wr},
    token,
};

const BPF_LOADER_UPGRADEABLE: Pubkey =
    solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSTEM_PROGRAM: Pubkey = solana_program::pubkey!("11111111111111111111111111111111");

pub const IX_INITIALIZE: u8 = 0;
pub const IX_DEPOSIT: u8 = 1;
pub const IX_POST_SIGNATURES: u8 = 2;
pub const IX_RELEASE: u8 = 3;
pub const IX_GOVERN: u8 = 4;
pub const IX_PAUSE: u8 = 5;

type Res<T> = Result<T, ProgramError>;

fn err(e: VaultError) -> ProgramError {
    e.into()
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&tag, rest) = data.split_first().ok_or(err(VaultError::InvalidInstruction))?;
    match tag {
        IX_INITIALIZE => initialize(program_id, accounts, rest),
        IX_DEPOSIT => deposit(program_id, accounts, rest),
        IX_POST_SIGNATURES => post_signatures(program_id, accounts, rest),
        IX_RELEASE => release(program_id, accounts, rest),
        IX_GOVERN => govern(program_id, accounts, rest),
        IX_PAUSE => pause(program_id, accounts, rest),
        _ => Err(err(VaultError::InvalidInstruction)),
    }
}

fn account<'a, 'b>(accounts: &'a [AccountInfo<'b>], i: usize) -> Res<&'a AccountInfo<'b>> {
    accounts.get(i).ok_or(ProgramError::NotEnoughAccountKeys)
}

fn expect_key(acc: &AccountInfo, key: &Pubkey) -> ProgramResult {
    if acc.key != key {
        return Err(err(VaultError::WrongAccount));
    }
    Ok(())
}

/// Creates a program-owned PDA. Tolerates lamports pre-sent to the address
/// (which would make `create_account` fail) but never an account that
/// already holds data or belongs to another program.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    program_id: &Pubkey,
    seeds: &[&[u8]],
    space: usize,
    owner: &Pubkey,
) -> ProgramResult {
    expect_key(system_program, &SYSTEM_PROGRAM)?;
    let rent = Rent::get()?.minimum_balance(space);
    let _ = program_id;
    if target.lamports() == 0 {
        return invoke_signed(
            &system_instruction::create_account(payer.key, target.key, rent, space as u64, owner),
            &[payer.clone(), target.clone(), system_program.clone()],
            &[seeds],
        );
    }
    if *target.owner != SYSTEM_PROGRAM || target.data_len() != 0 {
        return Err(err(VaultError::AccountAlreadyInitialized));
    }
    let top_up = rent.saturating_sub(target.lamports());
    if top_up > 0 {
        invoke(
            &system_instruction::transfer(payer.key, target.key, top_up),
            &[payer.clone(), target.clone(), system_program.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(target.key, space as u64),
        &[target.clone(), system_program.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(target.key, owner),
        &[target.clone(), system_program.clone()],
        &[seeds],
    )
}

fn close_account(acc: &AccountInfo, recipient: &AccountInfo) -> ProgramResult {
    let lamports = acc.lamports();
    **recipient.try_borrow_mut_lamports()? = recipient
        .lamports()
        .checked_add(lamports)
        .ok_or(err(VaultError::Overflow))?;
    **acc.try_borrow_mut_lamports()? = 0;
    acc.try_borrow_mut_data()?.fill(0);
    acc.resize(0)?;
    acc.assign(&SYSTEM_PROGRAM);
    Ok(())
}

fn load_config<'a>(program_id: &Pubkey, acc: &AccountInfo<'a>) -> ProgramResult {
    if acc.owner != program_id || acc.data_len() != config::LEN {
        return Err(err(VaultError::InvalidConfig));
    }
    let d = acc.try_borrow_data()?;
    if &d[0..8] != config::MAGIC || d[config::VERSION] != state::LAYOUT_VERSION {
        return Err(err(VaultError::InvalidConfig));
    }
    let expected = Pubkey::create_program_address(&[state::SEED_CONFIG, &[d[config::BUMP]]], program_id)
        .map_err(|_| err(VaultError::InvalidConfig))?;
    if *acc.key != expected {
        return Err(err(VaultError::InvalidConfig));
    }
    Ok(())
}

struct GuardianSet {
    epoch: u64,
    threshold: u8,
    keys: Vec<[u8; 32]>,
}

fn load_current_guardian_set(program_id: &Pubkey, acc: &AccountInfo, current_epoch: u64) -> Res<GuardianSet> {
    if acc.owner != program_id || acc.data_len() != guardian_set::LEN {
        return Err(err(VaultError::InvalidGuardianSet));
    }
    let d = acc.try_borrow_data()?;
    if &d[0..8] != guardian_set::MAGIC {
        return Err(err(VaultError::InvalidGuardianSet));
    }
    let epoch = rd_u64(&d, guardian_set::EPOCH);
    let expected = Pubkey::create_program_address(
        &[state::SEED_GUARDIAN_SET, &epoch.to_le_bytes(), &[d[guardian_set::BUMP]]],
        program_id,
    )
    .map_err(|_| err(VaultError::InvalidGuardianSet))?;
    if *acc.key != expected {
        return Err(err(VaultError::InvalidGuardianSet));
    }
    if epoch != current_epoch {
        return Err(err(VaultError::StaleEpoch));
    }
    let count = d[guardian_set::COUNT] as usize;
    let keys = (0..count).map(|i| rd_32(&d, guardian_set::KEYS + 32 * i)).collect();
    Ok(GuardianSet { epoch, threshold: d[guardian_set::THRESHOLD], keys })
}

fn write_guardian_set(
    d: &mut [u8],
    bump: u8,
    epoch: u64,
    threshold: u8,
    keys: &[[u8; 32]],
    slot: u64,
) {
    wr(d, 0, guardian_set::MAGIC);
    d[8] = state::LAYOUT_VERSION;
    d[guardian_set::BUMP] = bump;
    d[guardian_set::SCHEME] = message::SCHEME_ED25519;
    d[guardian_set::THRESHOLD] = threshold;
    d[guardian_set::COUNT] = keys.len() as u8;
    wr(d, guardian_set::EPOCH, &epoch.to_le_bytes());
    wr(d, guardian_set::CREATED_SLOT, &slot.to_le_bytes());
    for (i, k) in keys.iter().enumerate() {
        wr(d, guardian_set::KEYS + 32 * i, k);
    }
}

fn parse_keys(data: &[u8], count: usize) -> Res<Vec<[u8; 32]>> {
    if data.len() != 32 * count {
        return Err(err(VaultError::InvalidInstruction));
    }
    Ok(data.chunks_exact(32).map(|c| c.try_into().unwrap()).collect())
}

fn valid_limits(window: u64, max_dep: u64, max_wd: u64) -> bool {
    window > 0 && max_dep > 0 && max_wd > 0
}

fn verify_upgrade_authority(program_id: &Pubkey, program_data: &AccountInfo, authority: &AccountInfo) -> ProgramResult {
    let (expected, _) = Pubkey::find_program_address(&[program_id.as_ref()], &BPF_LOADER_UPGRADEABLE);
    if *program_data.key != expected || *program_data.owner != BPF_LOADER_UPGRADEABLE {
        return Err(err(VaultError::NotAuthorizedInitializer));
    }
    let d = program_data.try_borrow_data()?;
    if d.len() < 45 || d[0..4] != 3u32.to_le_bytes() || d[12] != 1 || d[13..45] != authority.key.to_bytes() {
        return Err(err(VaultError::NotAuthorizedInitializer));
    }
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 0 Initialize
// data: deployment_id[32] solana_genesis[32] lattice_genesis[32] pauser[32]
//       deposit_cap u64 rate_window_secs u64 max_deposit u64 max_withdrawal u64
//       flags u8 threshold u8 count u8 keys[count*32]
// accounts: authority(s,w) config(w) guardian_set(w) vault_authority vault(w)
//           mint token_program program_data system_program
// ---------------------------------------------------------------------------
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    const FIXED: usize = 32 * 4 + 8 * 4 + 3;
    if data.len() < FIXED {
        return Err(err(VaultError::InvalidInstruction));
    }
    let authority = account(accounts, 0)?;
    let config_acc = account(accounts, 1)?;
    let gset_acc = account(accounts, 2)?;
    let vault_authority = account(accounts, 3)?;
    let vault = account(accounts, 4)?;
    let mint = account(accounts, 5)?;
    let token_program = account(accounts, 6)?;
    let program_data = account(accounts, 7)?;
    let system_program = account(accounts, 8)?;

    verify_upgrade_authority(program_id, program_data, authority)?;

    let deployment_id = rd_32(data, 0);
    let solana_genesis = rd_32(data, 32);
    let lattice_genesis = rd_32(data, 64);
    let pauser = rd_32(data, 96);
    let deposit_cap = rd_u64(data, 128);
    let window = rd_u64(data, 136);
    let max_dep = rd_u64(data, 144);
    let max_wd = rd_u64(data, 152);
    let flags = data[160];
    let threshold = data[161];
    let count = data[162] as usize;
    let keys = parse_keys(&data[FIXED..], count)?;

    if [deployment_id, solana_genesis, lattice_genesis].iter().any(|v| v.iter().all(|b| *b == 0))
        || solana_genesis == lattice_genesis
        || flags & !(config::FLAG_DEPOSITS_PAUSED | config::FLAG_WITHDRAWALS_PAUSED) != 0
    {
        return Err(err(VaultError::InvalidConfig));
    }
    if !valid_limits(window, max_dep, max_wd) {
        return Err(err(VaultError::InvalidLimits));
    }
    if !state::validate_guardians(threshold, &keys) {
        return Err(err(VaultError::InvalidGuardianSet));
    }
    if !token::is_supported_token_program(token_program.key) || mint.owner != token_program.key {
        return Err(err(VaultError::UnsupportedTokenProgram));
    }
    let mint_info = token::inspect_mint(mint)?;

    let (config_key, config_bump) = Pubkey::find_program_address(&[state::SEED_CONFIG], program_id);
    let (va_key, va_bump) = Pubkey::find_program_address(&[state::SEED_VAULT_AUTHORITY], program_id);
    let (vault_key, vault_bump) = Pubkey::find_program_address(&[state::SEED_VAULT], program_id);
    let epoch: u64 = 1;
    let (gset_key, gset_bump) =
        Pubkey::find_program_address(&[state::SEED_GUARDIAN_SET, &epoch.to_le_bytes()], program_id);
    expect_key(config_acc, &config_key)?;
    expect_key(vault_authority, &va_key)?;
    expect_key(vault, &vault_key)?;
    expect_key(gset_acc, &gset_key)?;

    create_pda(authority, config_acc, system_program, program_id, &[state::SEED_CONFIG, &[config_bump]], config::LEN, program_id)?;
    create_pda(
        authority,
        gset_acc,
        system_program,
        program_id,
        &[state::SEED_GUARDIAN_SET, &epoch.to_le_bytes(), &[gset_bump]],
        guardian_set::LEN,
        program_id,
    )?;
    create_pda(
        authority,
        vault,
        system_program,
        program_id,
        &[state::SEED_VAULT, &[vault_bump]],
        token::ACCOUNT_BASE_LEN,
        token_program.key,
    )?;
    invoke(
        &token::initialize_account3(token_program.key, vault.key, mint.key, &va_key),
        &[vault.clone(), mint.clone(), token_program.clone()],
    )?;

    let clock = Clock::get()?;
    {
        let mut g = gset_acc.try_borrow_mut_data()?;
        write_guardian_set(&mut g, gset_bump, epoch, threshold, &keys, clock.slot);
    }
    let mut c = config_acc.try_borrow_mut_data()?;
    wr(&mut c, 0, config::MAGIC);
    c[config::VERSION] = state::LAYOUT_VERSION;
    c[config::BUMP] = config_bump;
    c[config::VAULT_AUTHORITY_BUMP] = va_bump;
    c[config::VAULT_BUMP] = vault_bump;
    c[config::DECIMALS] = mint_info.decimals;
    c[config::FLAGS] = flags;
    wr(&mut c, config::DEPLOYMENT_ID, &deployment_id);
    wr(&mut c, config::SOLANA_GENESIS, &solana_genesis);
    wr(&mut c, config::LATTICE_GENESIS, &lattice_genesis);
    wr(&mut c, config::MINT, mint.key.as_ref());
    wr(&mut c, config::TOKEN_PROGRAM, token_program.key.as_ref());
    wr(&mut c, config::VAULT, vault.key.as_ref());
    wr(&mut c, config::PAUSER, &pauser);
    wr(&mut c, config::EPOCH, &epoch.to_le_bytes());
    wr(&mut c, config::DEPOSIT_CAP, &deposit_cap.to_le_bytes());
    wr(&mut c, config::RATE_WINDOW_SECS, &window.to_le_bytes());
    wr(&mut c, config::MAX_DEPOSIT_PER_WINDOW, &max_dep.to_le_bytes());
    wr(&mut c, config::MAX_WITHDRAWAL_PER_WINDOW, &max_wd.to_le_bytes());
    wr(&mut c, config::WINDOW_START, &clock.unix_timestamp.to_le_bytes());
    msg!("lattice source vault initialized, epoch 1, {} guardians, threshold {}", count, threshold);
    Ok(())
}

/// Rolls the fixed rate window forward if it has elapsed.
fn roll_window(c: &mut [u8], now: i64) {
    let start = rd_i64(c, config::WINDOW_START);
    let window = rd_u64(c, config::RATE_WINDOW_SECS) as i64;
    if now.saturating_sub(start) >= window || now < start {
        wr(c, config::WINDOW_START, &now.to_le_bytes());
        wr(c, config::DEPOSITED_IN_WINDOW, &0u64.to_le_bytes());
        wr(c, config::WITHDRAWN_IN_WINDOW, &0u64.to_le_bytes());
    }
}

fn scale(decimals: u8) -> u64 {
    10u64.pow(9 - decimals as u32)
}

// ---------------------------------------------------------------------------
// 1 Deposit — data: amount u64, lattice_recipient[32]
// accounts: depositor(s,w) config(w) depositor_token(w) vault(w) mint
//           token_program receipt(w) system_program
// ---------------------------------------------------------------------------
fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 40 {
        return Err(err(VaultError::InvalidInstruction));
    }
    let amount = rd_u64(data, 0);
    let recipient = rd_32(data, 8);
    let depositor = account(accounts, 0)?;
    let config_acc = account(accounts, 1)?;
    let source = account(accounts, 2)?;
    let vault = account(accounts, 3)?;
    let mint = account(accounts, 4)?;
    let token_program = account(accounts, 5)?;
    let receipt_acc = account(accounts, 6)?;
    let system_program = account(accounts, 7)?;

    load_config(program_id, config_acc)?;
    if !depositor.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (flags, decimals, deployment_id, seq) = {
        let c = config_acc.try_borrow_data()?;
        expect_key(vault, &Pubkey::new_from_array(rd_32(&c, config::VAULT)))?;
        if *mint.key != Pubkey::new_from_array(rd_32(&c, config::MINT)) {
            return Err(err(VaultError::WrongMint));
        }
        expect_key(token_program, &Pubkey::new_from_array(rd_32(&c, config::TOKEN_PROGRAM)))?;
        (c[config::FLAGS], c[config::DECIMALS], rd_32(&c, config::DEPLOYMENT_ID), rd_u64(&c, config::NEXT_DEPOSIT_SEQ))
    };
    if flags & config::FLAG_DEPOSITS_PAUSED != 0 {
        return Err(err(VaultError::DepositsPaused));
    }
    if amount == 0 {
        return Err(err(VaultError::ZeroAmount));
    }
    if recipient.iter().all(|b| *b == 0) {
        return Err(err(VaultError::ZeroRecipient));
    }
    if source.key == vault.key {
        return Err(err(VaultError::WrongAccount));
    }
    let seq_bytes = seq.to_le_bytes();
    let (receipt_key, receipt_bump) =
        Pubkey::find_program_address(&[state::SEED_DEPOSIT, &seq_bytes], program_id);
    expect_key(receipt_acc, &receipt_key)?;

    let before = token::read_token_account(vault, token_program.key)?.amount;
    invoke(
        &token::transfer_checked(token_program.key, source.key, mint.key, vault.key, depositor.key, amount, decimals),
        &[source.clone(), mint.clone(), vault.clone(), depositor.clone(), token_program.clone()],
    )?;
    let after = token::read_token_account(vault, token_program.key)?.amount;
    let credited = after.checked_sub(before).ok_or(err(VaultError::Overflow))?;
    if credited == 0 {
        return Err(err(VaultError::NothingCredited));
    }
    if credited > amount {
        return Err(err(VaultError::AmountMismatch));
    }
    let native = credited.checked_mul(scale(decimals)).ok_or(err(VaultError::Overflow))?;
    let clock = Clock::get()?;

    {
        let mut c = config_acc.try_borrow_mut_data()?;
        roll_window(&mut c, clock.unix_timestamp);
        let in_window = rd_u64(&c, config::DEPOSITED_IN_WINDOW)
            .checked_add(credited)
            .ok_or(err(VaultError::Overflow))?;
        if in_window > rd_u64(&c, config::MAX_DEPOSIT_PER_WINDOW) {
            return Err(err(VaultError::RateLimitExceeded));
        }
        let total_dep = rd_u128(&c, config::TOTAL_DEPOSITED)
            .checked_add(credited as u128)
            .ok_or(err(VaultError::Overflow))?;
        let locked = total_dep
            .checked_sub(rd_u128(&c, config::TOTAL_RELEASED))
            .ok_or(err(VaultError::Overflow))?;
        if locked > rd_u64(&c, config::DEPOSIT_CAP) as u128 {
            return Err(err(VaultError::DepositCapExceeded));
        }
        let next = seq.checked_add(1).ok_or(err(VaultError::Overflow))?;
        wr(&mut c, config::DEPOSITED_IN_WINDOW, &in_window.to_le_bytes());
        wr(&mut c, config::TOTAL_DEPOSITED, &total_dep.to_le_bytes());
        wr(&mut c, config::NEXT_DEPOSIT_SEQ, &next.to_le_bytes());
    }

    create_pda(
        depositor,
        receipt_acc,
        system_program,
        program_id,
        &[state::SEED_DEPOSIT, &seq_bytes, &[receipt_bump]],
        receipt::LEN,
        program_id,
    )?;
    let event_id = message::deposit_event_id(&deployment_id, seq);
    let mut r = receipt_acc.try_borrow_mut_data()?;
    wr(&mut r, 0, receipt::MAGIC);
    r[8] = state::LAYOUT_VERSION;
    r[receipt::BUMP] = receipt_bump;
    wr(&mut r, receipt::SEQUENCE, &seq_bytes);
    wr(&mut r, receipt::EVENT_ID, &event_id);
    wr(&mut r, receipt::DEPOSITOR, depositor.key.as_ref());
    wr(&mut r, receipt::DEPOSITOR_TOKEN, source.key.as_ref());
    wr(&mut r, receipt::RECIPIENT, &recipient);
    wr(&mut r, receipt::REQUESTED, &amount.to_le_bytes());
    wr(&mut r, receipt::CREDITED, &credited.to_le_bytes());
    wr(&mut r, receipt::NATIVE, &native.to_le_bytes());
    wr(&mut r, receipt::SLOT, &clock.slot.to_le_bytes());
    wr(&mut r, receipt::TIMESTAMP, &clock.unix_timestamp.to_le_bytes());
    wr(&mut r, receipt::DEPLOYMENT_ID, &deployment_id);
    sol_log_data(&[b"lattice-deposit", &r]);
    Ok(())
}

#[cfg(test)]
pub(crate) fn ed25519_signers_for_test(ix_data: &[u8], digest: &[u8; 32]) -> Res<Vec<[u8; 32]>> {
    ed25519_signers(ix_data, digest)
}

/// Parses an Ed25519 precompile instruction and returns the public keys that
/// signed exactly `digest`. All offsets must point into that same instruction.
fn ed25519_signers(ix_data: &[u8], digest: &[u8; 32]) -> Res<Vec<[u8; 32]>> {
    let malformed = || err(VaultError::MalformedEd25519Instruction);
    if ix_data.len() < 2 {
        return Err(malformed());
    }
    let n = ix_data[0] as usize;
    if n == 0 {
        return Err(err(VaultError::NoSignatures));
    }
    if ix_data.len() < 2 + 14 * n {
        return Err(malformed());
    }
    let u16_at = |o: usize| u16::from_le_bytes([ix_data[o], ix_data[o + 1]]);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let o = 2 + 14 * i;
        let sig_ix = u16_at(o + 2);
        let pk_off = u16_at(o + 4) as usize;
        let pk_ix = u16_at(o + 6);
        let msg_off = u16_at(o + 8) as usize;
        let msg_len = u16_at(o + 10) as usize;
        let msg_ix = u16_at(o + 12);
        if sig_ix != u16::MAX || pk_ix != u16::MAX || msg_ix != u16::MAX {
            return Err(malformed());
        }
        if msg_len != 32 || msg_off + 32 > ix_data.len() || pk_off + 32 > ix_data.len() {
            return Err(err(VaultError::SignatureNotForDigest));
        }
        if &ix_data[msg_off..msg_off + 32] != digest {
            return Err(err(VaultError::SignatureNotForDigest));
        }
        out.push(rd_32(ix_data, pk_off));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 2 PostSignatures — data: digest[32]
// accounts: payer(s,w) config guardian_set attestation(w) instructions system
// ---------------------------------------------------------------------------
fn post_signatures(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 32 {
        return Err(err(VaultError::InvalidInstruction));
    }
    let digest: [u8; 32] = data.try_into().unwrap();
    let payer = account(accounts, 0)?;
    let config_acc = account(accounts, 1)?;
    let gset_acc = account(accounts, 2)?;
    let att_acc = account(accounts, 3)?;
    let ixs = account(accounts, 4)?;
    let system_program = account(accounts, 5)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    load_config(program_id, config_acc)?;
    let epoch = rd_u64(&config_acc.try_borrow_data()?, config::EPOCH);
    let gs = load_current_guardian_set(program_id, gset_acc, epoch)?;

    expect_key(ixs, &ix_sysvar::ID)?;
    let current = ix_sysvar::load_current_index_checked(ixs)? as usize;
    if current == 0 {
        return Err(err(VaultError::MissingEd25519Instruction));
    }
    let prev = ix_sysvar::load_instruction_at_checked(current - 1, ixs)?;
    if prev.program_id != ed25519_program::ID {
        return Err(err(VaultError::MissingEd25519Instruction));
    }
    let mut bits: u32 = 0;
    for pk in ed25519_signers(&prev.data, &digest)? {
        let idx = gs.keys.iter().position(|k| *k == pk).ok_or(err(VaultError::UnknownGuardian))?;
        bits |= 1 << idx;
    }

    let (att_key, att_bump) = Pubkey::find_program_address(&[state::SEED_ATTESTATION, &digest], program_id);
    expect_key(att_acc, &att_key)?;
    if *att_acc.owner != *program_id {
        create_pda(
            payer,
            att_acc,
            system_program,
            program_id,
            &[state::SEED_ATTESTATION, &digest, &[att_bump]],
            attestation::LEN,
            program_id,
        )?;
        let mut a = att_acc.try_borrow_mut_data()?;
        wr(&mut a, 0, attestation::MAGIC);
        a[8] = state::LAYOUT_VERSION;
        a[attestation::BUMP] = att_bump;
        wr(&mut a, attestation::EPOCH, &gs.epoch.to_le_bytes());
        wr(&mut a, attestation::DIGEST, &digest);
        wr(&mut a, attestation::PAYER, payer.key.as_ref());
    }
    let mut a = att_acc.try_borrow_mut_data()?;
    if &a[0..8] != attestation::MAGIC || rd_32(&a, attestation::DIGEST) != digest {
        return Err(err(VaultError::DigestMismatch));
    }
    if rd_u64(&a, attestation::EPOCH) != gs.epoch {
        return Err(err(VaultError::StaleEpoch));
    }
    let merged = u32::from_le_bytes(a[attestation::BITMAP..attestation::BITMAP + 4].try_into().unwrap()) | bits;
    wr(&mut a, attestation::BITMAP, &merged.to_le_bytes());
    msg!("attestation signers: {} (bitmap {:#x})", merged.count_ones(), merged);
    Ok(())
}

/// Checks the attestation against `msg_bytes` and the current guardian set.
fn check_attested(
    program_id: &Pubkey,
    config_acc: &AccountInfo,
    gset_acc: &AccountInfo,
    att_acc: &AccountInfo,
    rent_recipient: &AccountInfo,
    msg_bytes: &[u8],
    header: &Header,
    expected_kind: u8,
) -> Res<[u8; 32]> {
    let c = config_acc.try_borrow_data()?;
    let epoch = rd_u64(&c, config::EPOCH);
    let gs = load_current_guardian_set(program_id, gset_acc, epoch)?;
    if att_acc.owner != program_id || att_acc.data_len() != attestation::LEN {
        return Err(err(VaultError::DigestMismatch));
    }
    let a = att_acc.try_borrow_data()?;
    let digest = message::digest(msg_bytes);
    if &a[0..8] != attestation::MAGIC || rd_32(&a, attestation::DIGEST) != digest {
        return Err(err(VaultError::DigestMismatch));
    }
    if rent_recipient.key.to_bytes() != rd_32(&a, attestation::PAYER) {
        return Err(err(VaultError::WrongRentRecipient));
    }
    if rd_u64(&a, attestation::EPOCH) != epoch || header.signer_epoch != epoch {
        return Err(err(VaultError::StaleEpoch));
    }
    let bitmap = u32::from_le_bytes(a[attestation::BITMAP..attestation::BITMAP + 4].try_into().unwrap());
    if bitmap.count_ones() < gs.threshold as u32 {
        return Err(err(VaultError::BelowThreshold));
    }

    if header.kind != expected_kind {
        return Err(err(VaultError::WrongKind));
    }
    if header.protocol_version != message::PROTOCOL_VERSION {
        return Err(err(VaultError::WrongVersion));
    }
    if header.scheme != message::SCHEME_ED25519 {
        return Err(err(VaultError::WrongScheme));
    }
    if header.deployment_id != rd_32(&c, config::DEPLOYMENT_ID) {
        return Err(err(VaultError::WrongDeployment));
    }
    if header.solana_genesis_hash != rd_32(&c, config::SOLANA_GENESIS)
        || header.lattice_genesis_hash != rd_32(&c, config::LATTICE_GENESIS)
    {
        return Err(err(VaultError::WrongGenesis));
    }
    if header.source_program_id != program_id.to_bytes() {
        return Err(err(VaultError::WrongProgram));
    }
    if header.source_mint != rd_32(&c, config::MINT) {
        return Err(err(VaultError::WrongMint));
    }
    Ok(digest)
}

// ---------------------------------------------------------------------------
// 3 Release — data: WITHDRAWAL message (276 bytes)
// accounts: payer(s,w) config(w) guardian_set attestation(w) rent_recipient(w)
//           consumed(w) vault(w) vault_authority recipient_token(w) mint
//           token_program system_program
// ---------------------------------------------------------------------------
fn release(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let t = message::parse_transfer(data).ok_or(err(VaultError::MalformedMessage))?;
    let payer = account(accounts, 0)?;
    let config_acc = account(accounts, 1)?;
    let gset_acc = account(accounts, 2)?;
    let att_acc = account(accounts, 3)?;
    let rent_recipient = account(accounts, 4)?;
    let consumed_acc = account(accounts, 5)?;
    let vault = account(accounts, 6)?;
    let vault_authority = account(accounts, 7)?;
    let recipient_token = account(accounts, 8)?;
    let mint = account(accounts, 9)?;
    let token_program = account(accounts, 10)?;
    let system_program = account(accounts, 11)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    load_config(program_id, config_acc)?;
    let digest = check_attested(program_id, config_acc, gset_acc, att_acc, rent_recipient, data, &t.header, message::KIND_WITHDRAWAL)?;

    let (decimals, va_bump) = {
        let c = config_acc.try_borrow_data()?;
        if c[config::FLAGS] & config::FLAG_WITHDRAWALS_PAUSED != 0 {
            return Err(err(VaultError::WithdrawalsPaused));
        }
        expect_key(vault, &Pubkey::new_from_array(rd_32(&c, config::VAULT)))?;
        expect_key(token_program, &Pubkey::new_from_array(rd_32(&c, config::TOKEN_PROGRAM)))?;
        if mint.key.to_bytes() != rd_32(&c, config::MINT) {
            return Err(err(VaultError::WrongMint));
        }
        if t.event_id != message::burn_event_id(&rd_32(&c, config::DEPLOYMENT_ID), t.header.nonce) {
            return Err(err(VaultError::WrongEventId));
        }
        (c[config::DECIMALS], c[config::VAULT_AUTHORITY_BUMP])
    };
    if t.source_amount == 0 || t.native_amount == 0 {
        return Err(err(VaultError::ZeroAmount));
    }
    if t.source_amount.checked_mul(scale(decimals)) != Some(t.native_amount) {
        return Err(err(VaultError::AmountMismatch));
    }
    if t.recipient.iter().all(|b| *b == 0) {
        return Err(err(VaultError::ZeroRecipient));
    }
    let dest = token::read_token_account(recipient_token, token_program.key)?;
    if dest.mint != mint.key.to_bytes() {
        return Err(err(VaultError::WrongMint));
    }
    if dest.owner != t.recipient {
        return Err(err(VaultError::WrongRecipient));
    }
    let va_key = Pubkey::create_program_address(&[state::SEED_VAULT_AUTHORITY, &[va_bump]], program_id)?;
    expect_key(vault_authority, &va_key)?;

    let clock = Clock::get()?;
    {
        let mut c = config_acc.try_borrow_mut_data()?;
        roll_window(&mut c, clock.unix_timestamp);
        let in_window = rd_u64(&c, config::WITHDRAWN_IN_WINDOW)
            .checked_add(t.source_amount)
            .ok_or(err(VaultError::Overflow))?;
        if in_window > rd_u64(&c, config::MAX_WITHDRAWAL_PER_WINDOW) {
            return Err(err(VaultError::RateLimitExceeded));
        }
        let released = rd_u128(&c, config::TOTAL_RELEASED)
            .checked_add(t.source_amount as u128)
            .ok_or(err(VaultError::Overflow))?;
        if released > rd_u128(&c, config::TOTAL_DEPOSITED) {
            return Err(err(VaultError::ExceedsLocked));
        }
        let count = rd_u64(&c, config::RELEASED_COUNT).checked_add(1).ok_or(err(VaultError::Overflow))?;
        wr(&mut c, config::WITHDRAWN_IN_WINDOW, &in_window.to_le_bytes());
        wr(&mut c, config::TOTAL_RELEASED, &released.to_le_bytes());
        wr(&mut c, config::RELEASED_COUNT, &count.to_le_bytes());
    }

    let nonce_bytes = t.header.nonce.to_le_bytes();
    let (consumed_key, consumed_bump) =
        Pubkey::find_program_address(&[state::SEED_WITHDRAWAL, &nonce_bytes], program_id);
    expect_key(consumed_acc, &consumed_key)?;
    if consumed_acc.owner == program_id {
        return Err(err(VaultError::AlreadyConsumed));
    }
    create_pda(
        payer,
        consumed_acc,
        system_program,
        program_id,
        &[state::SEED_WITHDRAWAL, &nonce_bytes, &[consumed_bump]],
        consumed::LEN,
        program_id,
    )?;
    {
        let mut w = consumed_acc.try_borrow_mut_data()?;
        wr(&mut w, 0, consumed::MAGIC);
        w[8] = state::LAYOUT_VERSION;
        w[consumed::BUMP] = consumed_bump;
        wr(&mut w, consumed::NONCE, &nonce_bytes);
        wr(&mut w, consumed::EVENT_ID, &t.event_id);
        wr(&mut w, consumed::RECIPIENT, &t.recipient);
        wr(&mut w, consumed::RECIPIENT_TOKEN, recipient_token.key.as_ref());
        wr(&mut w, consumed::AMOUNT, &t.source_amount.to_le_bytes());
        wr(&mut w, consumed::SLOT, &clock.slot.to_le_bytes());
        wr(&mut w, consumed::TIMESTAMP, &clock.unix_timestamp.to_le_bytes());
        wr(&mut w, consumed::DIGEST, &digest);
        sol_log_data(&[b"lattice-release", &w]);
    }

    invoke_signed(
        &token::transfer_checked(
            token_program.key,
            vault.key,
            mint.key,
            recipient_token.key,
            &va_key,
            t.source_amount,
            decimals,
        ),
        &[vault.clone(), mint.clone(), recipient_token.clone(), vault_authority.clone(), token_program.clone()],
        &[&[state::SEED_VAULT_AUTHORITY, &[va_bump]]],
    )?;
    close_account(att_acc, rent_recipient)
}

// ---------------------------------------------------------------------------
// 4 Govern — data: SOURCE_GOVERNANCE message
// accounts: payer(s,w) config(w) guardian_set attestation(w) rent_recipient(w)
//           new_guardian_set(w, rotation only) system_program
// ---------------------------------------------------------------------------
fn govern(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let header = message::parse_header(data).ok_or(err(VaultError::MalformedMessage))?;
    if data.len() < message::HEADER_LEN + 1 {
        return Err(err(VaultError::MalformedMessage));
    }
    let payer = account(accounts, 0)?;
    let config_acc = account(accounts, 1)?;
    let gset_acc = account(accounts, 2)?;
    let att_acc = account(accounts, 3)?;
    let rent_recipient = account(accounts, 4)?;
    let new_gset_acc = account(accounts, 5)?;
    let system_program = account(accounts, 6)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    load_config(program_id, config_acc)?;
    check_attested(program_id, config_acc, gset_acc, att_acc, rent_recipient, data, &header, message::KIND_SOURCE_GOVERNANCE)?;

    let seq = rd_u64(&config_acc.try_borrow_data()?, config::GOVERNANCE_SEQ);
    if header.nonce != seq {
        return Err(err(VaultError::WrongGovernanceNonce));
    }
    let action = data[message::HEADER_LEN];
    let p = &data[message::HEADER_LEN + 1..];
    match action {
        message::ACTION_ROTATE => {
            if p.len() < 11 {
                return Err(err(VaultError::MalformedMessage));
            }
            let new_epoch = rd_u64(p, 0);
            let threshold = p[8];
            let count = p[9] as usize;
            if p[10] != message::SCHEME_ED25519 {
                return Err(err(VaultError::WrongScheme));
            }
            let keys = parse_keys(&p[11..], count).map_err(|_| err(VaultError::MalformedMessage))?;
            let current = rd_u64(&config_acc.try_borrow_data()?, config::EPOCH);
            if Some(new_epoch) != current.checked_add(1) {
                return Err(err(VaultError::StaleEpoch));
            }
            if !state::validate_guardians(threshold, &keys) {
                return Err(err(VaultError::InvalidGuardianSet));
            }
            let epoch_bytes = new_epoch.to_le_bytes();
            let (key, bump) = Pubkey::find_program_address(&[state::SEED_GUARDIAN_SET, &epoch_bytes], program_id);
            expect_key(new_gset_acc, &key)?;
            create_pda(
                payer,
                new_gset_acc,
                system_program,
                program_id,
                &[state::SEED_GUARDIAN_SET, &epoch_bytes, &[bump]],
                guardian_set::LEN,
                program_id,
            )?;
            let slot = Clock::get()?.slot;
            write_guardian_set(&mut new_gset_acc.try_borrow_mut_data()?, bump, new_epoch, threshold, &keys, slot);
            wr(&mut config_acc.try_borrow_mut_data()?, config::EPOCH, &epoch_bytes);
            msg!("guardian set rotated to epoch {}", new_epoch);
        }
        message::ACTION_SET_PAUSE => {
            if p.len() != 2 || p[0] > 1 || p[1] > 1 {
                return Err(err(VaultError::MalformedMessage));
            }
            let flags = (p[0] * config::FLAG_DEPOSITS_PAUSED) | (p[1] * config::FLAG_WITHDRAWALS_PAUSED);
            config_acc.try_borrow_mut_data()?[config::FLAGS] = flags;
        }
        message::ACTION_SET_LIMITS => {
            if p.len() != 32 {
                return Err(err(VaultError::MalformedMessage));
            }
            let (cap, window, max_dep, max_wd) = (rd_u64(p, 0), rd_u64(p, 8), rd_u64(p, 16), rd_u64(p, 24));
            if !valid_limits(window, max_dep, max_wd) {
                return Err(err(VaultError::InvalidLimits));
            }
            let mut c = config_acc.try_borrow_mut_data()?;
            wr(&mut c, config::DEPOSIT_CAP, &cap.to_le_bytes());
            wr(&mut c, config::RATE_WINDOW_SECS, &window.to_le_bytes());
            wr(&mut c, config::MAX_DEPOSIT_PER_WINDOW, &max_dep.to_le_bytes());
            wr(&mut c, config::MAX_WITHDRAWAL_PER_WINDOW, &max_wd.to_le_bytes());
        }
        message::ACTION_SET_PAUSER => {
            if p.len() != 32 {
                return Err(err(VaultError::MalformedMessage));
            }
            wr(&mut config_acc.try_borrow_mut_data()?, config::PAUSER, p);
        }
        _ => return Err(err(VaultError::UnknownGovernanceAction)),
    }
    wr(&mut config_acc.try_borrow_mut_data()?, config::GOVERNANCE_SEQ, &(seq + 1).to_le_bytes());
    close_account(att_acc, rent_recipient)
}

// ---------------------------------------------------------------------------
// 5 Pause — data: deposits u8, withdrawals u8 (1 = pause). Can never unpause.
// accounts: pauser(s) config(w)
// ---------------------------------------------------------------------------
fn pause(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 2 || data[0] > 1 || data[1] > 1 || (data[0] | data[1]) == 0 {
        return Err(err(VaultError::InvalidInstruction));
    }
    let pauser = account(accounts, 0)?;
    let config_acc = account(accounts, 1)?;
    load_config(program_id, config_acc)?;
    let mut c = config_acc.try_borrow_mut_data()?;
    let configured = rd_32(&c, config::PAUSER);
    if !pauser.is_signer || configured.iter().all(|b| *b == 0) || configured != pauser.key.to_bytes() {
        return Err(err(VaultError::NotPauser));
    }
    c[config::FLAGS] |= (data[0] * config::FLAG_DEPOSITS_PAUSED) | (data[1] * config::FLAG_WITHDRAWALS_PAUSED);
    msg!("paused by pauser: flags {:#x}", c[config::FLAGS]);
    Ok(())
}
