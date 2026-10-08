//! Minimal, hand-checked SPL Token / Token-2022 layout reading and CPI
//! builders. Only the instructions this program needs are encoded.

use solana_program::{
    account_info::AccountInfo, instruction::{AccountMeta, Instruction}, pubkey::Pubkey,
};

use crate::error::VaultError;

pub const SPL_TOKEN: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

pub const MINT_BASE_LEN: usize = 82;
pub const ACCOUNT_BASE_LEN: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;

/// Token-2022 mint extensions that cannot alter balances, transfers or
/// custody: MetadataPointer, TokenMetadata, GroupPointer, TokenGroup,
/// GroupMemberPointer, TokenGroupMember.
pub const ALLOWED_MINT_EXTENSIONS: [u16; 6] = [18, 19, 20, 21, 22, 23];

pub struct MintInfo {
    pub decimals: u8,
}

pub fn is_supported_token_program(id: &Pubkey) -> bool {
    *id == SPL_TOKEN || *id == TOKEN_2022
}

/// Validates the mint account against the custody policy (spec §8).
pub fn inspect_mint(mint: &AccountInfo) -> Result<MintInfo, VaultError> {
    let owner = *mint.owner;
    if !is_supported_token_program(&owner) {
        return Err(VaultError::UnsupportedTokenProgram);
    }
    let d = mint.try_borrow_data().map_err(|_| VaultError::InvalidMint)?;
    if d.len() < MINT_BASE_LEN || d[45] != 1 {
        return Err(VaultError::InvalidMint);
    }
    if owner == SPL_TOKEN && d.len() != MINT_BASE_LEN {
        return Err(VaultError::InvalidMint);
    }
    if u32::from_le_bytes(d[46..50].try_into().unwrap()) != 0 {
        return Err(VaultError::FreezeAuthorityPresent);
    }
    if owner == TOKEN_2022 && d.len() != MINT_BASE_LEN {
        check_mint_extensions(&d)?;
    }
    let decimals = d[44];
    if decimals > 9 {
        return Err(VaultError::UnsupportedDecimals);
    }
    Ok(MintInfo { decimals })
}

/// Walks the Token-2022 TLV area of a mint. Any type outside the allowlist,
/// a malformed entry, or a wrong account type rejects.
pub fn check_mint_extensions(d: &[u8]) -> Result<(), VaultError> {
    if d.len() <= ACCOUNT_BASE_LEN || d[ACCOUNT_BASE_LEN] != ACCOUNT_TYPE_MINT {
        return Err(VaultError::InvalidMint);
    }
    if d[MINT_BASE_LEN..ACCOUNT_BASE_LEN].iter().any(|b| *b != 0) {
        return Err(VaultError::InvalidMint);
    }
    let mut o = ACCOUNT_BASE_LEN + 1;
    while o + 4 <= d.len() {
        let ty = u16::from_le_bytes([d[o], d[o + 1]]);
        let len = u16::from_le_bytes([d[o + 2], d[o + 3]]) as usize;
        if ty == 0 {
            break;
        }
        if !ALLOWED_MINT_EXTENSIONS.contains(&ty) {
            return Err(VaultError::DisallowedExtension);
        }
        o = o.checked_add(4 + len).ok_or(VaultError::InvalidMint)?;
        if o > d.len() {
            return Err(VaultError::InvalidMint);
        }
    }
    Ok(())
}

pub struct TokenAccountView {
    pub mint: [u8; 32],
    pub owner: [u8; 32],
    pub amount: u64,
    pub state: u8,
}

pub fn read_token_account(acc: &AccountInfo, token_program: &Pubkey) -> Result<TokenAccountView, VaultError> {
    if acc.owner != token_program {
        return Err(VaultError::WrongAccount);
    }
    let d = acc.try_borrow_data().map_err(|_| VaultError::WrongAccount)?;
    if d.len() < ACCOUNT_BASE_LEN {
        return Err(VaultError::WrongAccount);
    }
    if d.len() > ACCOUNT_BASE_LEN && d[ACCOUNT_BASE_LEN] != 2 {
        return Err(VaultError::WrongAccount);
    }
    Ok(TokenAccountView {
        mint: d[0..32].try_into().unwrap(),
        owner: d[32..64].try_into().unwrap(),
        amount: u64::from_le_bytes(d[64..72].try_into().unwrap()),
        state: d[108],
    })
}

pub fn transfer_checked(
    token_program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

pub fn initialize_account3(token_program: &Pubkey, account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(33);
    data.push(18);
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: *token_program,
        accounts: vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(*mint, false)],
        data,
    }
}
