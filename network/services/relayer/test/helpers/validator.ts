import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { messageDigest } from "@lattice/protocol/wire";
import {
  ed25519FromSecret,
  ed25519MultiIx,
  ed25519Sign,
  governIx,
  postSignaturesIx,
  releaseIx,
  type Ed25519Key,
} from "../../src/vault/client.js";

const run = promisify(execFile);

export const RPC_URL = process.env.SOLANA_TEST_RPC ?? "http://127.0.0.1:8899";
export const SO_PATH = new URL("../../../../programs/target/deploy/lattice_source_vault.so", import.meta.url).pathname;
export const SOLANA_BIN = `${process.env.HOME}/.local/share/solana/install/active_release/bin`;

export const connection = new Connection(RPC_URL, "confirmed");

let nonceCounter = Math.floor(Math.random() * 1000);

/** Sends a transaction; a varying priority fee keeps otherwise identical retries distinct. */
export async function send(ixs: TransactionInstruction[], signers: Signer[]): Promise<string> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ++nonceCounter }),
    ...ixs,
  );
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

export function customCode(error: unknown): number | null {
  const text = `${(error as Error)?.message ?? ""} ${((error as { logs?: string[] }).logs ?? []).join(" ")}`;
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  return m ? parseInt(m[1]!, 16) : null;
}

export async function expectCode(p: Promise<unknown>, code: number): Promise<void> {
  try {
    await p;
  } catch (e) {
    const got = customCode(e);
    if (got !== code) throw new Error(`expected custom error ${code}, got ${got}: ${(e as Error).message}`);
    return;
  }
  throw new Error(`expected custom error ${code}, but the transaction succeeded`);
}

export async function expectFailure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the transaction to fail");
}

export async function fund(pubkey: PublicKey, sol = 20): Promise<void> {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
}

export async function validatorReachable(): Promise<boolean> {
  try {
    await connection.getVersion();
    return true;
  } catch {
    return false;
  }
}

/** Deploys a fresh instance of the source-vault program with `authority` as upgrade authority. */
export async function deployVault(authority: Keypair): Promise<PublicKey> {
  const dir = await mkdtemp(join(tmpdir(), "lattice-vault-"));
  try {
    const program = Keypair.generate();
    await writeFile(join(dir, "program.json"), JSON.stringify([...program.secretKey]), { mode: 0o600 });
    await writeFile(join(dir, "authority.json"), JSON.stringify([...authority.secretKey]), { mode: 0o600 });
    await run(
      `${SOLANA_BIN}/solana`,
      [
        "-u", RPC_URL,
        "-k", join(dir, "authority.json"),
        "program", "deploy",
        "--program-id", join(dir, "program.json"),
        "--commitment", "confirmed",
        SO_PATH,
      ],
      { timeout: 180_000 },
    );
    return program.publicKey;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function guardian(): Ed25519Key {
  return ed25519FromSecret(Keypair.generate().secretKey);
}

/** Posts guardian signatures over `message` (in chunks) for the given epoch. */
export async function attest(
  programId: PublicKey,
  payer: Keypair,
  epoch: bigint,
  message: Uint8Array,
  signers: Ed25519Key[],
  chunk = 5,
): Promise<Uint8Array> {
  const digest = messageDigest(message);
  for (let i = 0; i < signers.length; i += chunk) {
    const batch = signers.slice(i, i + chunk).map((g) => ({ publicKey: g.publicKey, signature: ed25519Sign(g, digest) }));
    await send([ed25519MultiIx(digest, batch), postSignaturesIx(programId, payer.publicKey, epoch, digest)], [payer]);
  }
  return digest;
}

export interface ReleaseAccounts {
  programId: PublicKey;
  payer: Keypair;
  epoch: bigint;
  nonce: bigint;
  recipientToken: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}

export function releaseTx(a: ReleaseAccounts, message: Uint8Array, digest = messageDigest(message)) {
  return send(
    [
      releaseIx(a.programId, {
        payer: a.payer.publicKey,
        rentRecipient: a.payer.publicKey,
        epoch: a.epoch,
        digest,
        nonce: a.nonce,
        recipientToken: a.recipientToken,
        mint: a.mint,
        tokenProgram: a.tokenProgram,
        message,
      }),
    ],
    [a.payer],
  );
}

export function governTx(
  programId: PublicKey,
  payer: Keypair,
  epoch: bigint,
  message: Uint8Array,
  newGuardianSet?: PublicKey,
) {
  return send(
    [
      governIx(programId, {
        payer: payer.publicKey,
        rentRecipient: payer.publicKey,
        epoch,
        digest: messageDigest(message),
        message,
        ...(newGuardianSet ? { newGuardianSet } : {}),
      }),
    ],
    [payer],
  );
}
