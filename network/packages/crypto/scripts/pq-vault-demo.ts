// End-to-end demo against the Lattice PQ fork (default http://127.0.0.1:8999):
// generate an ML-DSA-65 key, create and fund a pq-vault, execute a
// PQ-authorized transfer, then run negative cases that the runtime must reject.
// Writes chain/evidence/pq-local.run.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { encodeTransfer } from "../src/index.js";
import {
  BUFFER_LEN,
  customErrorCode,
  PQ_VAULT_PROGRAM_ID,
  sendPlan,
  signVaultTransfer,
  transferPlan,
  VAULT_ERRORS,
  VAULT_LEN,
  vaultSetupPlan,
  type SentTransaction,
} from "../src/pqVault.js";

const RPC = process.env.PQ_RPC_URL ?? "http://127.0.0.1:8999";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../chain/evidence/pq-local.run.json");
if (RPC.includes(":8899")) throw new Error("refusing to target the unmodified validator on 8899");

const connection = new Connection(RPC, "confirmed");

async function airdrop(to: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

const summarize = (txs: SentTransaction[]) =>
  txs.map((t) => ({
    signature: t.signature,
    sizeBytes: t.sizeBytes,
    computeUnits: t.computeUnits,
    err: t.err,
    errorName: (() => {
      const code = customErrorCode(t.err);
      return code === null ? null : (VAULT_ERRORS[code] ?? `Custom(${code})`);
    })(),
  }));

async function main() {
  const version = await connection.getVersion();
  const genesisHashB58 = await connection.getGenesisHash();
  const genesisHash = new PublicKey(genesisHashB58).toBytes();
  const program = await connection.getAccountInfo(PQ_VAULT_PROGRAM_ID);
  if (!program?.executable) throw new Error(`pq-vault program ${PQ_VAULT_PROGRAM_ID.toBase58()} not loaded`);

  const relayer = Keypair.generate();
  await airdrop(relayer.publicKey, 20);

  const t0 = performance.now();
  const { publicKey, secretKey } = ml_dsa65.keygen();
  const keygenMs = performance.now() - t0;

  const vault = Keypair.generate();
  const vaultRent = await connection.getMinimumBalanceForRentExemption(VAULT_LEN);
  const bufferRent = await connection.getMinimumBalanceForRentExemption(BUFFER_LEN);
  const funding = 2 * LAMPORTS_PER_SOL;
  const setup = await sendPlan(
    connection,
    vaultSetupPlan({
      programId: PQ_VAULT_PROGRAM_ID,
      payer: relayer.publicKey,
      vault: vault.publicKey,
      publicKey,
      genesisHash,
      lamports: vaultRent + funding,
    }),
    relayer,
    (i) => (i === 0 ? [vault] : []),
  );
  if (setup.some((t) => t.err)) throw new Error(`vault setup failed: ${JSON.stringify(summarize(setup))}`);

  const recipient = Keypair.generate().publicKey;
  let nonce = 0n;

  async function attempt(
    label: string,
    opts: { amount: bigint; nonce: bigint; expirySlot?: bigint; sign?: (msgNonce: bigint, expiry: bigint) => Uint8Array; executeAmount?: bigint },
  ) {
    const slot = BigInt(await connection.getSlot("confirmed"));
    const expirySlot = opts.expirySlot ?? slot + 300n;
    const signature =
      opts.sign?.(opts.nonce, expirySlot) ??
      signVaultTransfer(secretKey, {
        genesisHash,
        programId: PQ_VAULT_PROGRAM_ID,
        vault: vault.publicKey,
        recipient,
        amount: opts.amount,
        nonce: opts.nonce,
        expirySlot,
      });
    const buffer = Keypair.generate();
    const txs = await sendPlan(
      connection,
      transferPlan({
        programId: PQ_VAULT_PROGRAM_ID,
        relayer: relayer.publicKey,
        buffer: buffer.publicKey,
        bufferLamports: bufferRent,
        vault: vault.publicKey,
        recipient,
        signature,
        amount: opts.executeAmount ?? opts.amount,
        nonce: opts.nonce,
        expirySlot,
      }),
      relayer,
      (i) => (i === 0 ? [buffer] : []),
    );
    const final = txs.at(-1);
    return { label, transactions: summarize(txs), rejected: Boolean(final?.err), logs: final?.logs ?? [] };
  }

  const amount = BigInt(LAMPORTS_PER_SOL / 4);
  const results = [];
  const before = await connection.getBalance(recipient);
  const ok = await attempt("valid transfer (nonce 0)", { amount: BigInt(amount), nonce });
  results.push(ok);
  if (!ok.rejected) nonce += 1n;
  const after = await connection.getBalance(recipient);

  results.push(await attempt("replay nonce 0", { amount: BigInt(amount), nonce: 0n }));
  results.push(
    await attempt("tampered amount", { amount: BigInt(amount), nonce, executeAmount: BigInt(amount) + 1n }),
  );
  results.push(
    await attempt("wrong genesis hash", {
      amount: BigInt(amount),
      nonce,
      sign: (n, expirySlot) =>
        signVaultTransfer(secretKey, {
          genesisHash: new Uint8Array(32).fill(0xab),
          programId: PQ_VAULT_PROGRAM_ID,
          vault: vault.publicKey,
          recipient,
          amount: BigInt(amount),
          nonce: n,
          expirySlot,
        }),
    }),
  );
  results.push(
    await attempt("wrong domain (off-chain prototype encoding)", {
      amount: BigInt(amount),
      nonce,
      sign: (n, expirySlot) =>
        ml_dsa65.sign(
          encodeTransfer({
            protocol: "lattice-pq-transaction",
            version: 1,
            algorithm: "ML-DSA-65",
            genesisHash: genesisHashB58,
            purpose: "native-transfer",
            senderKeyId: vault.publicKey.toBase58(),
            recipient: recipient.toBase58(),
            amountAtomic: `${amount}`,
            nonce: `${n}`,
            expiresAtSlot: `${expirySlot}`,
          }),
          secretKey,
        ),
    }),
  );
  results.push(
    await attempt("invalid signature (bit flip)", {
      amount: BigInt(amount),
      nonce,
      sign: (n, expirySlot) => {
        const s = signVaultTransfer(secretKey, {
          genesisHash,
          programId: PQ_VAULT_PROGRAM_ID,
          vault: vault.publicKey,
          recipient,
          amount: BigInt(amount),
          nonce: n,
          expirySlot,
        });
        s[100]! ^= 0x01;
        return s;
      },
    }),
  );
  const slotNow = BigInt(await connection.getSlot("confirmed"));
  results.push(await attempt("expired message", { amount: BigInt(amount), nonce, expirySlot: slotNow - 1n }));
  const second = await attempt("valid transfer (nonce 1)", { amount: BigInt(amount), nonce });
  results.push(second);

  const expectations: Record<string, boolean> = {
    "valid transfer (nonce 0)": false,
    "valid transfer (nonce 1)": false,
  };
  const checks = results.map((r) => ({
    label: r.label,
    expectedRejected: expectations[r.label] ?? true,
    rejected: r.rejected,
    pass: (expectations[r.label] ?? true) === r.rejected,
  }));

  const executeCu = ok.transactions.at(-1)?.computeUnits ?? null;
  const report = {
    generatedAt: new Date().toISOString(),
    rpc: RPC,
    version,
    genesisHash: genesisHashB58,
    programId: PQ_VAULT_PROGRAM_ID.toBase58(),
    vault: vault.publicKey.toBase58(),
    recipient: recipient.toBase58(),
    relayer: relayer.publicKey.toBase58(),
    recipientLamportsDelta: after - before,
    mldsaKeygenMs: keygenMs,
    sizes: { publicKey: publicKey.length, signature: 3309, message: 180 },
    setupTransactions: summarize(setup),
    transactionsPerPqTransfer: ok.transactions.length,
    executeComputeUnits: executeCu,
    results,
    checks,
    allChecksPass: checks.every((c) => c.pass),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out: OUT, genesisHash: genesisHashB58, checks, executeCu }, null, 2));
  if (!report.allChecksPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
