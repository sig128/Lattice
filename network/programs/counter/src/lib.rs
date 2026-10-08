use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _instruction_data: &[u8],
) -> ProgramResult {
    let account = next_account_info(&mut accounts.iter())?;
    if account.owner != program_id || !account.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut data = account.try_borrow_mut_data()?;
    let current = u64::from_le_bytes(
        data.get(..8)
            .ok_or(ProgramError::AccountDataTooSmall)?
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );
    data[..8].copy_from_slice(&current.saturating_add(1).to_le_bytes());
    Ok(())
}
