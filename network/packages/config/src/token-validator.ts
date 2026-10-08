import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionTypes,
  unpackMint,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

export interface TokenInspection {
  mint: string;
  clusterGenesisHash: string;
  tokenProgram: string;
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  bridgeCompatible: boolean;
  rejectionReasons: string[];
  pumpFunProvenance: "unverified";
}

const BLOCKED_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.TransferFeeConfig,
  ExtensionType.TransferHook,
  ExtensionType.ConfidentialTransferMint,
  ExtensionType.NonTransferable,
  ExtensionType.PermanentDelegate,
  ExtensionType.ScaledUiAmountConfig,
  ExtensionType.DefaultAccountState,
]);

export async function inspectSourceMint(
  rpcUrl: string,
  mintText: string,
  expectedGenesisHash: string,
): Promise<TokenInspection> {
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintText);
  } catch {
    throw new Error("SOURCE_TOKEN_MINT is not a valid Solana public key");
  }

  const connection = new Connection(rpcUrl, "finalized");
  const [genesisHash, account] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(mint, "finalized"),
  ]);
  if (genesisHash !== expectedGenesisHash) {
    throw new Error(`Wrong source cluster: expected ${expectedGenesisHash}, observed ${genesisHash}`);
  }
  if (!account) throw new Error("Mint account does not exist on the configured source cluster");

  const supportedProgram = account.owner.equals(TOKEN_PROGRAM_ID)
    ? TOKEN_PROGRAM_ID
    : account.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : null;
  if (!supportedProgram) {
    throw new Error(`Account owner ${account.owner.toBase58()} is not a supported token program`);
  }

  let parsed;
  try {
    parsed = unpackMint(mint, account, supportedProgram);
  } catch {
    throw new Error("Account is not an initialized SPL mint (it may be a wallet or token account)");
  }
  if (!parsed.isInitialized) throw new Error("SPL mint is not initialized");

  const extensionTypes =
    supportedProgram.equals(TOKEN_2022_PROGRAM_ID) ? getExtensionTypes(account.data) : [];
  const blocked = extensionTypes.filter((extension) => BLOCKED_EXTENSIONS.has(extension));
  const rejectionReasons = blocked.map(
    (extension) => `Unsupported Token-2022 extension: ${ExtensionType[extension]}`,
  );
  if (parsed.freezeAuthority) {
    rejectionReasons.push(
      `Freeze authority remains active: ${parsed.freezeAuthority.toBase58()}; production review required`,
    );
  }

  return {
    mint: mint.toBase58(),
    clusterGenesisHash: genesisHash,
    tokenProgram: supportedProgram.toBase58(),
    decimals: parsed.decimals,
    supply: parsed.supply.toString(),
    mintAuthority: parsed.mintAuthority?.toBase58() ?? null,
    freezeAuthority: parsed.freezeAuthority?.toBase58() ?? null,
    extensions: extensionTypes.map((extension) => ExtensionType[extension] ?? `${extension}`),
    bridgeCompatible: rejectionReasons.length === 0,
    rejectionReasons,
    pumpFunProvenance: "unverified",
  };
}
