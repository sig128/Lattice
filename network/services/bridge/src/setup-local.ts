import { Connection } from "@solana/web3.js";
import {
  burnChecked,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintToChecked,
  transferChecked,
} from "@solana/spl-token";
import { IS_TESTNET, NATIVE_GENESIS_HASH } from "@lattice/config";
import { COMMITMENT, RPC_URL, ensureFunding, loadOrCreateKey, observe } from "./local.js";
import {
  SAMPLES_PATH,
  readState,
  writeJsonAtomic,
  writeState,
  type LocalBridgeState,
} from "./state.js";

const connection = new Connection(RPC_URL, COMMITMENT);
const observedGenesis = await connection.getGenesisHash();
if (!NATIVE_GENESIS_HASH || observedGenesis !== NATIVE_GENESIS_HASH) {
  throw new Error(`Wrong genesis: expected ${NATIVE_GENESIS_HASH}, observed ${observedGenesis}`);
}

const existing = await readState();
if (existing?.genesisHash === observedGenesis) {
  await observe(connection, existing, "setup-reused");
  console.log(JSON.stringify({ reused: true, state: existing }, null, 2));
  process.exit(0);
}

const payer = await loadOrCreateKey("local-operator");
const vaultAuthority = await loadOrCreateKey("local-vault-authority");
const fundingSignature = await ensureFunding(connection, payer);
const decimals = 9;
const unit = 10n ** BigInt(decimals);

const sourceMint = await createMint(connection, payer, payer.publicKey, null, decimals);
const issuedMint = await createMint(connection, payer, payer.publicKey, null, decimals);
const sourceOwner = await getOrCreateAssociatedTokenAccount(connection, payer, sourceMint, payer.publicKey);
const vault = await getOrCreateAssociatedTokenAccount(connection, payer, sourceMint, vaultAuthority.publicKey);
const issuedOwner = await getOrCreateAssociatedTokenAccount(connection, payer, issuedMint, payer.publicKey);

const setupTransactions = fundingSignature ? [fundingSignature] : [];
setupTransactions.push(await mintToChecked(
  connection, payer, sourceMint, sourceOwner.address, payer, 1_000n * unit, decimals,
));

const state: LocalBridgeState = {
  schemaVersion: 1,
  genesisHash: observedGenesis,
  deploymentId: IS_TESTNET ? "lattice-testnet-bridge-v1" : "lattice-local-bridge-v1",
  sourceMint: sourceMint.toBase58(),
  issuedMint: issuedMint.toBase58(),
  sourceOwnerAccount: sourceOwner.address.toBase58(),
  vaultAccount: vault.address.toBase58(),
  issuedOwnerAccount: issuedOwner.address.toBase58(),
  operator: payer.publicKey.toBase58(),
  decimals,
  setupTransactions,
};
await writeState(state);
await writeJsonAtomic(SAMPLES_PATH, []);
await observe(connection, state, "initialized", setupTransactions);

async function deposit(wholeUnits: bigint, label: string) {
  const amount = wholeUnits * unit;
  const lock = await transferChecked(
    connection, payer, sourceOwner.address, sourceMint, vault.address, payer,
    amount, decimals,
  );
  const issue = await mintToChecked(
    connection, payer, issuedMint, issuedOwner.address, payer,
    amount, decimals,
  );
  setupTransactions.push(lock, issue);
  await observe(connection, state, label, [lock, issue]);
}

async function redeem(wholeUnits: bigint, label: string) {
  const amount = wholeUnits * unit;
  const burn = await burnChecked(
    connection, payer, issuedOwner.address, issuedMint, payer,
    amount, decimals,
  );
  const release = await transferChecked(
    connection, payer, vault.address, sourceMint, sourceOwner.address, vaultAuthority,
    amount, decimals,
  );
  setupTransactions.push(burn, release);
  await observe(connection, state, label, [burn, release]);
}

await deposit(100n, "deposit-100");
await deposit(50n, "deposit-50");
await redeem(25n, "redeem-25");
await writeState({ ...state, setupTransactions });

console.log(JSON.stringify({ reused: false, state: { ...state, setupTransactions } }, null, 2));
