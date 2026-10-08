import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { LOCAL_DEVELOPMENT_GENESIS } from "@lattice/config";

const rpc = "http://127.0.0.1:8899";
const connection = new Connection(rpc, "confirmed");
const genesis = await connection.getGenesisHash();
if (genesis !== LOCAL_DEVELOPMENT_GENESIS) throw new Error(`Wrong genesis: ${genesis}`);

const sender = Keypair.generate();
const recipient = Keypair.generate();
const airdrop = await connection.requestAirdrop(sender.publicKey, 2 * LAMPORTS_PER_SOL);
await connection.confirmTransaction(airdrop, "confirmed");

const transfer = new Transaction().add(SystemProgram.transfer({
  fromPubkey: sender.publicKey,
  toPubkey: recipient.publicKey,
  lamports: LAMPORTS_PER_SOL / 10,
}));
const signature = await sendAndConfirmTransaction(connection, transfer, [sender], {
  commitment: "confirmed",
});

const slotUpdate = await new Promise<number>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Slot subscription timed out")), 5_000);
  let subscription = 0;
  subscription = connection.onSlotChange((event) => {
    clearTimeout(timeout);
    void connection.removeSlotChangeListener(subscription);
    resolve(event.slot);
  });
});

console.log(JSON.stringify({
  rpc,
  genesis,
  sender: sender.publicKey.toBase58(),
  recipient: recipient.publicKey.toBase58(),
  airdrop,
  transfer: signature,
  recipientBalanceLamports: await connection.getBalance(recipient.publicKey, "confirmed"),
  websocketObservedSlot: slotUpdate,
}, null, 2));
