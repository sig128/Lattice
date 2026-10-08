import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { silentLogger } from "../src/log.js";
import { InsufficientQuorum, QuorumReader, RpcDisagreement, type RpcLike } from "../src/rpc/quorum.js";

const OWNER = Keypair.generate().publicKey;
const ADDR = Keypair.generate().publicKey;

function rpc(genesis: string, value: Buffer | null | "throw", slot = 100): RpcLike {
  return {
    getGenesisHash: async () => genesis,
    getSlot: async () => slot,
    getAccountInfoAndContext: async () => {
      if (value === "throw") throw new Error("down");
      const v: AccountInfo<Buffer> | null = value
        ? { data: value, owner: OWNER, lamports: 1, executable: false, rentEpoch: 0 }
        : null;
      return { context: { slot }, value: v };
    },
  };
}

const reader = (rpcs: RpcLike[], quorum = 2) =>
  new QuorumReader("test", rpcs.map((r, i) => ({ label: `e${i}`, rpc: r })), quorum, "G", silentLogger);

describe("RPC quorum", () => {
  it("returns data only when a quorum agrees byte-for-byte", async () => {
    const a = await reader([rpc("G", Buffer.from("abc"), 10), rpc("G", Buffer.from("abc"), 12)]).getAccount(ADDR);
    expect(Buffer.from(a.data!).toString()).toBe("abc");
    expect(a.slot).toBe(10);
    expect(a.agreeing).toEqual(["e0", "e1"]);
  });

  it("treats conflicting data as a disagreement (an RPC lie), never picking a side", async () => {
    await expect(reader([rpc("G", Buffer.from("abc")), rpc("G", Buffer.from("abd")), rpc("G", Buffer.from("abc"))]).getAccount(ADDR)).rejects.toBeInstanceOf(RpcDisagreement);
  });

  it("flags an endpoint claiming absence at or above another's finalized slot", async () => {
    await expect(reader([rpc("G", Buffer.from("abc"), 10), rpc("G", null, 11)]).getAccount(ADDR)).rejects.toBeInstanceOf(RpcDisagreement);
  });

  it("treats absence at a lower slot as lag and waits", async () => {
    await expect(reader([rpc("G", Buffer.from("abc"), 10), rpc("G", null, 9)]).getAccount(ADDR)).rejects.toBeInstanceOf(InsufficientQuorum);
  });

  it("allows mutable accounts to differ across slots but not within one slot", async () => {
    const r1 = reader([rpc("G", Buffer.from("v1"), 10), rpc("G", Buffer.from("v2"), 11)]);
    await expect(r1.getAccount(ADDR, { immutable: false })).rejects.toBeInstanceOf(InsufficientQuorum);
    const r2 = reader([rpc("G", Buffer.from("v1"), 10), rpc("G", Buffer.from("v2"), 10)]);
    await expect(r2.getAccount(ADDR, { immutable: false })).rejects.toBeInstanceOf(RpcDisagreement);
  });

  it("excludes endpoints with the wrong genesis and fails without quorum", async () => {
    await expect(reader([rpc("G", Buffer.from("abc")), rpc("OTHER", Buffer.from("abc"))]).getAccount(ADDR)).rejects.toBeInstanceOf(InsufficientQuorum);
    const ok = await reader([rpc("G", Buffer.from("abc")), rpc("OTHER", Buffer.from("zzz")), rpc("G", Buffer.from("abc"))]).getAccount(ADDR);
    expect(ok.agreeing).toEqual(["e0", "e2"]);
  });

  it("fails without quorum when endpoints are down", async () => {
    await expect(reader([rpc("G", Buffer.from("abc")), rpc("G", "throw")]).getAccount(ADDR)).rejects.toBeInstanceOf(InsufficientQuorum);
  });

  it("uses the lowest finalized slot as watermark", async () => {
    expect(await reader([rpc("G", null, 50), rpc("G", null, 40)]).finalizedSlot()).toBe(40);
  });

  it("rejects unsatisfiable configuration", () => {
    expect(() => reader([rpc("G", null)], 2)).toThrow();
    expect(() => new QuorumReader("t", [{ label: "a", rpc: rpc("G", null) }, { label: "a", rpc: rpc("G", null) }], 1, "G", silentLogger)).toThrow();
    expect(new PublicKey(ADDR).equals(ADDR)).toBe(true);
  });
});
