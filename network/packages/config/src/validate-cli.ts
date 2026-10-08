import { inspectSourceMint } from "./token-validator.js";
import { SOLANA_MAINNET_GENESIS } from "./index.js";

const mint = process.env.SOURCE_TOKEN_MINT ?? process.env.NEXT_PUBLIC_SOURCE_TOKEN_MINT;
if (!mint) {
  console.error("Set SOURCE_TOKEN_MINT to the exact public Solana mint address.");
  process.exitCode = 1;
} else {
  const result = await inspectSourceMint(
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    mint,
    process.env.SOURCE_GENESIS_HASH ?? SOLANA_MAINNET_GENESIS,
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.bridgeCompatible) process.exitCode = 2;
}
