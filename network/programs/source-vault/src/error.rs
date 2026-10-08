use solana_program::program_error::ProgramError;

/// Stable error codes (custom program error `n`). Never renumber.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum VaultError {
    InvalidInstruction = 1,
    NotAuthorizedInitializer = 2,
    InvalidConfig = 3,
    WrongAccount = 4,
    UnsupportedTokenProgram = 5,
    InvalidMint = 6,
    FreezeAuthorityPresent = 7,
    DisallowedExtension = 8,
    UnsupportedDecimals = 9,
    InvalidGuardianSet = 10,
    InvalidLimits = 11,
    DepositsPaused = 12,
    WithdrawalsPaused = 13,
    ZeroAmount = 14,
    ZeroRecipient = 15,
    NothingCredited = 16,
    DepositCapExceeded = 17,
    RateLimitExceeded = 18,
    Overflow = 19,
    MissingEd25519Instruction = 20,
    MalformedEd25519Instruction = 21,
    SignatureNotForDigest = 22,
    UnknownGuardian = 23,
    StaleEpoch = 24,
    DigestMismatch = 25,
    BelowThreshold = 26,
    MalformedMessage = 27,
    WrongDomain = 28,
    WrongKind = 29,
    WrongVersion = 30,
    WrongScheme = 31,
    WrongDeployment = 32,
    WrongGenesis = 33,
    WrongProgram = 34,
    WrongMint = 35,
    WrongEventId = 36,
    AmountMismatch = 37,
    WrongRecipient = 38,
    AlreadyConsumed = 39,
    ExceedsLocked = 40,
    WrongGovernanceNonce = 41,
    UnknownGovernanceAction = 42,
    NotPauser = 43,
    AccountAlreadyInitialized = 44,
    WrongRentRecipient = 45,
    NoSignatures = 46,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
