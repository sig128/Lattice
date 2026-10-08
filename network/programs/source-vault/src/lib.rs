//! Lattice bridge source vault (Solana). Unaudited.
//!
//! Custodies one immutably-bound SPL mint. Deposits create sequenced receipts;
//! releases require an M-of-N Ed25519 guardian attestation over the canonical
//! message in docs/BRIDGE_SPEC.md. There is no administrator, sweep, or
//! withdraw-all path.

pub mod error;
pub mod message;
pub mod processor;
pub mod state;
pub mod token;

#[cfg(test)]
mod tests;

solana_program::declare_id!("hSS8weNSv8RjWCyCPzxHAPq1MZSNX27PH1tRGUpmz3v");

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

    solana_program::entrypoint!(process_instruction);

    fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        crate::processor::process(program_id, accounts, data)
    }
}
