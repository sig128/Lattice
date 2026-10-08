//! pq-vault: lamports held by a program-owned account that can only be
//! released with an ML-DSA-65 signature, checked on-chain by the
//! `sol_mldsa65_verify` syscall of the Lattice experimental Agave fork.
//!
//! Instructions (first byte is the tag, integers little-endian):
//! - 0 InitVault { genesis_hash: [u8; 32] }  accounts: vault (w, s), setup authority (s)
//! - 1 WriteVaultKey { offset: u16, bytes }  accounts: vault (w), setup authority (s)
//! - 2 SealVault                             accounts: vault (w), setup authority (s)
//! - 3 InitSigBuffer                         accounts: buffer (w, s), relayer (s), vault
//! - 4 WriteSig { offset: u16, bytes }       accounts: buffer (w), relayer (s)
//! - 5 Execute { amount, nonce, expiry_slot } accounts: vault (w), buffer (w), recipient (w), relayer (w, s)
//! - 6 CloseSigBuffer                        accounts: buffer (w), relayer (w, s)

pub mod state;

use {
    solana_account_info::AccountInfo,
    solana_program_error::{ProgramError, ProgramResult},
    solana_pubkey::Pubkey,
    state::*,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum VaultError {
    InvalidInstruction = 1,
    InvalidAccount = 2,
    MissingSignature = 3,
    AlreadyInitialized = 4,
    NotLoading = 5,
    NotSealed = 6,
    OutOfOrderWrite = 7,
    KeyIncomplete = 8,
    SignatureIncomplete = 9,
    BufferMismatch = 10,
    Expired = 11,
    NonceMismatch = 12,
    InsufficientFunds = 13,
    InvalidAmount = 14,
    UnsupportedAlgorithm = 15,
    /// The syscall rejected the signature; the low byte of the custom code
    /// carries the syscall result (e.g. 0x101 = invalid signature).
    SignatureRejected = 0x100,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Host services the processor needs; implemented by the SBF runtime in
/// production and by mocks in host tests.
pub trait Runtime {
    fn slot(&self) -> Result<u64, ProgramError>;
    fn minimum_balance(&self, data_len: usize) -> Result<u64, ProgramError>;
    /// Returns 0 when valid, otherwise an `MlDsaVerifyError` code.
    fn mldsa65_verify(&self, public_key: &[u8], message: &[u8], signature: &[u8]) -> u64;
}

#[cfg(target_os = "solana")]
mod sbf {
    use {
        super::*,
        solana_sysvar::{clock::Clock, rent::Rent, Sysvar},
    };

    solana_define_syscall::define_syscall!(fn sol_mldsa65_verify(
        version: u64,
        public_key: *const u8,
        message: *const u8,
        message_len: u64,
        signature: *const u8,
    ) -> u64);

    pub struct SbfRuntime;

    impl Runtime for SbfRuntime {
        fn slot(&self) -> Result<u64, ProgramError> {
            Ok(Clock::get()?.slot)
        }
        fn minimum_balance(&self, data_len: usize) -> Result<u64, ProgramError> {
            Ok(Rent::get()?.minimum_balance(data_len))
        }
        fn mldsa65_verify(&self, public_key: &[u8], message: &[u8], signature: &[u8]) -> u64 {
            if public_key.len() != MLDSA65_PUBLIC_KEY_LEN || signature.len() != MLDSA65_SIGNATURE_LEN {
                return 2;
            }
            unsafe {
                sol_mldsa65_verify(
                    ALGORITHM_MLDSA65_V1 as u64,
                    public_key.as_ptr(),
                    message.as_ptr(),
                    message.len() as u64,
                    signature.as_ptr(),
                )
            }
        }
    }

    fn entry(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        process_instruction(&SbfRuntime, program_id, accounts, data)
    }

    solana_program_entrypoint::entrypoint!(entry);
}

fn require(cond: bool, err: VaultError) -> ProgramResult {
    if cond { Ok(()) } else { Err(err.into()) }
}

fn owned_data(
    program_id: &Pubkey,
    account: &AccountInfo,
    len: usize,
) -> ProgramResult {
    require(account.owner == program_id, VaultError::InvalidAccount)?;
    require(account.is_writable, VaultError::InvalidAccount)?;
    require(account.data_len() == len, VaultError::InvalidAccount)
}

fn accounts<const N: usize>(accounts: &[AccountInfo]) -> Result<[usize; N], ProgramError> {
    if accounts.len() < N {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    Ok(core::array::from_fn(|i| i))
}

fn sequential_write(
    data: &mut [u8],
    written_at: core::ops::Range<usize>,
    region: core::ops::Range<usize>,
    payload: &[u8],
) -> ProgramResult {
    require(payload.len() >= 2, VaultError::InvalidInstruction)?;
    let offset = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    let bytes = &payload[2..];
    let written = read_u16(data, written_at.clone()) as usize;
    let total = region.end - region.start;
    require(offset == written, VaultError::OutOfOrderWrite)?;
    require(!bytes.is_empty() && offset + bytes.len() <= total, VaultError::InvalidInstruction)?;
    let start = region.start + offset;
    data[start..start + bytes.len()].copy_from_slice(bytes);
    data[written_at].copy_from_slice(&((offset + bytes.len()) as u16).to_le_bytes());
    Ok(())
}

pub fn process_instruction(
    rt: &impl Runtime,
    program_id: &Pubkey,
    accs: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (&tag, rest) = data.split_first().ok_or(VaultError::InvalidInstruction)?;
    match tag {
        0 => {
            let [vault, authority] = accounts::<2>(accs)?.map(|i| &accs[i]);
            owned_data(program_id, vault, VAULT_LEN)?;
            require(vault.is_signer && authority.is_signer, VaultError::MissingSignature)?;
            let genesis: [u8; 32] = rest.try_into().map_err(|_| VaultError::InvalidInstruction)?;
            let mut d = vault.try_borrow_mut_data()?;
            require(d[0..8] == [0; 8], VaultError::AlreadyInitialized)?;
            d[0..8].copy_from_slice(&VAULT_MAGIC);
            d[8] = VAULT_STATE_LOADING;
            d[9] = ALGORITHM_MLDSA65_V1;
            d[VAULT_SETUP_AUTHORITY].copy_from_slice(authority.key.as_ref());
            d[VAULT_GENESIS_HASH].copy_from_slice(&genesis);
            d[VAULT_NEXT_NONCE].copy_from_slice(&0u64.to_le_bytes());
            Ok(())
        }
        1 | 2 => {
            let [vault, authority] = accounts::<2>(accs)?.map(|i| &accs[i]);
            owned_data(program_id, vault, VAULT_LEN)?;
            let mut d = vault.try_borrow_mut_data()?;
            require(d[0..8] == VAULT_MAGIC, VaultError::InvalidAccount)?;
            require(d[8] == VAULT_STATE_LOADING, VaultError::NotLoading)?;
            require(
                authority.is_signer && d[VAULT_SETUP_AUTHORITY] == *authority.key.as_ref(),
                VaultError::MissingSignature,
            )?;
            if tag == 1 {
                sequential_write(&mut d, VAULT_KEY_WRITTEN, VAULT_PUBLIC_KEY, rest)
            } else {
                require(
                    read_u16(&d, VAULT_KEY_WRITTEN) as usize == MLDSA65_PUBLIC_KEY_LEN,
                    VaultError::KeyIncomplete,
                )?;
                // After sealing, only an ML-DSA-65 signature can move funds.
                d[8] = VAULT_STATE_SEALED;
                d[VAULT_SETUP_AUTHORITY].fill(0);
                Ok(())
            }
        }
        3 => {
            let [buffer, relayer, vault] = accounts::<3>(accs)?.map(|i| &accs[i]);
            owned_data(program_id, buffer, BUFFER_LEN)?;
            require(buffer.is_signer && relayer.is_signer, VaultError::MissingSignature)?;
            require(vault.owner == program_id, VaultError::InvalidAccount)?;
            let mut d = buffer.try_borrow_mut_data()?;
            require(d[0..8] == [0; 8], VaultError::AlreadyInitialized)?;
            d[0..8].copy_from_slice(&BUFFER_MAGIC);
            d[BUFFER_RELAYER].copy_from_slice(relayer.key.as_ref());
            d[BUFFER_VAULT].copy_from_slice(vault.key.as_ref());
            Ok(())
        }
        4 => {
            let [buffer, relayer] = accounts::<2>(accs)?.map(|i| &accs[i]);
            owned_data(program_id, buffer, BUFFER_LEN)?;
            let mut d = buffer.try_borrow_mut_data()?;
            require(d[0..8] == BUFFER_MAGIC, VaultError::InvalidAccount)?;
            require(
                relayer.is_signer && d[BUFFER_RELAYER] == *relayer.key.as_ref(),
                VaultError::MissingSignature,
            )?;
            sequential_write(&mut d, BUFFER_WRITTEN, BUFFER_SIGNATURE, rest)
        }
        5 => execute(rt, program_id, accs, rest),
        6 => {
            let [buffer, relayer] = accounts::<2>(accs)?.map(|i| &accs[i]);
            owned_data(program_id, buffer, BUFFER_LEN)?;
            {
                let d = buffer.try_borrow_data()?;
                require(d[0..8] == BUFFER_MAGIC, VaultError::InvalidAccount)?;
                require(
                    relayer.is_signer && d[BUFFER_RELAYER] == *relayer.key.as_ref(),
                    VaultError::MissingSignature,
                )?;
            }
            close_buffer(buffer, relayer)
        }
        _ => Err(VaultError::InvalidInstruction.into()),
    }
}

fn close_buffer(buffer: &AccountInfo, relayer: &AccountInfo) -> ProgramResult {
    require(relayer.is_writable, VaultError::InvalidAccount)?;
    buffer.try_borrow_mut_data()?.fill(0);
    let lamports = buffer.lamports();
    **buffer.try_borrow_mut_lamports()? = 0;
    let mut to = relayer.try_borrow_mut_lamports()?;
    **to = to.checked_add(lamports).ok_or(ProgramError::ArithmeticOverflow)?;
    Ok(())
}

fn execute(
    rt: &impl Runtime,
    program_id: &Pubkey,
    accs: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    let [vault, buffer, recipient, relayer] = accounts::<4>(accs)?.map(|i| &accs[i]);
    owned_data(program_id, vault, VAULT_LEN)?;
    owned_data(program_id, buffer, BUFFER_LEN)?;
    require(args.len() == 24, VaultError::InvalidInstruction)?;
    let amount = read_u64(args, 0..8);
    let nonce = read_u64(args, 8..16);
    let expiry_slot = read_u64(args, 16..24);
    require(recipient.is_writable, VaultError::InvalidAccount)?;
    require(
        recipient.key != vault.key && recipient.key != buffer.key,
        VaultError::InvalidAccount,
    )?;
    require(amount > 0, VaultError::InvalidAmount)?;

    {
        let v = vault.try_borrow_data()?;
        let b = buffer.try_borrow_data()?;
        require(v[0..8] == VAULT_MAGIC, VaultError::InvalidAccount)?;
        require(v[8] == VAULT_STATE_SEALED, VaultError::NotSealed)?;
        require(v[9] == ALGORITHM_MLDSA65_V1, VaultError::UnsupportedAlgorithm)?;
        require(b[0..8] == BUFFER_MAGIC, VaultError::InvalidAccount)?;
        require(b[BUFFER_VAULT] == *vault.key.as_ref(), VaultError::BufferMismatch)?;
        require(
            relayer.is_signer && b[BUFFER_RELAYER] == *relayer.key.as_ref(),
            VaultError::MissingSignature,
        )?;
        require(
            read_u16(&b, BUFFER_WRITTEN) as usize == MLDSA65_SIGNATURE_LEN,
            VaultError::SignatureIncomplete,
        )?;
        require(rt.slot()? <= expiry_slot, VaultError::Expired)?;
        require(read_u64(&v, VAULT_NEXT_NONCE) == nonce, VaultError::NonceMismatch)?;
        let floor = rt.minimum_balance(VAULT_LEN)?;
        require(
            vault.lamports().checked_sub(amount).is_some_and(|left| left >= floor),
            VaultError::InsufficientFunds,
        )?;

        let message = transfer_message(
            v[VAULT_GENESIS_HASH].try_into().unwrap(),
            program_id.as_ref().try_into().unwrap(),
            vault.key.as_ref().try_into().unwrap(),
            recipient.key.as_ref().try_into().unwrap(),
            amount,
            nonce,
            expiry_slot,
        );
        let code = rt.mldsa65_verify(&v[VAULT_PUBLIC_KEY], &message, &b[BUFFER_SIGNATURE]);
        if code != 0 {
            return Err(ProgramError::Custom(VaultError::SignatureRejected as u32 | (code as u32 & 0xff)));
        }
    }

    vault.try_borrow_mut_data()?[VAULT_NEXT_NONCE].copy_from_slice(&(nonce + 1).to_le_bytes());
    **vault.try_borrow_mut_lamports()? -= amount;
    {
        let mut to = recipient.try_borrow_mut_lamports()?;
        **to = to.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?;
    }
    // A signature buffer is single use.
    close_buffer(buffer, relayer)
}
