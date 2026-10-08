import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ed25519FromSecret, type Ed25519Key } from "../vault/client.js";

export interface MlDsaKey {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export class UnsafeKeyFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeKeyFile";
  }
}

function insideGitWorktree(path: string): string | null {
  let dir = dirname(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Loads a guardian Ed25519 key from a file. The file must be readable only by
 * its owner and must not live inside a git work tree (so it cannot be
 * committed by accident). Accepts a Solana keypair JSON array (64 bytes) or
 * hex of a 32-byte seed / 64-byte keypair.
 */
function readProtected(path: string, envName: string): string {
  if (!path) throw new UnsafeKeyFile(`${envName} is required`);
  const real = realpathSync(path);
  const st = statSync(real);
  if (!st.isFile()) throw new UnsafeKeyFile("guardian key path is not a regular file");
  if ((st.mode & 0o077) !== 0) throw new UnsafeKeyFile("guardian key file must not be group/world accessible (chmod 600)");
  const repo = insideGitWorktree(real);
  if (repo) throw new UnsafeKeyFile(`guardian key file is inside a git work tree (${repo}); store it outside any repository`);
  return readFileSync(real, "utf8").trim();
}

export function loadGuardianKey(path: string): Ed25519Key {
  const text = readProtected(path, "GUARDIAN_KEY_FILE");
  let secret: Uint8Array;
  if (text.startsWith("[")) {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new UnsafeKeyFile("malformed keypair JSON");
    }
    secret = Uint8Array.from(arr as number[]);
  } else if (/^[0-9a-f]{64}([0-9a-f]{64})?$/i.test(text)) {
    secret = new Uint8Array(Buffer.from(text, "hex"));
  } else {
    throw new UnsafeKeyFile("unrecognized key encoding");
  }
  try {
    return ed25519FromSecret(secret);
  } finally {
    secret.fill(0);
  }
}

/**
 * Loads a guardian ML-DSA-65 key (hybrid Lattice sets) from a file holding the
 * hex of its 32-byte FIPS 204 key-generation seed. Same file checks as above.
 */
export function loadMlDsaKey(path: string): MlDsaKey {
  const text = readProtected(path, "GUARDIAN_MLDSA_KEY_FILE");
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new UnsafeKeyFile("ML-DSA-65 key file must contain a 32-byte seed in hex");
  const seed = new Uint8Array(Buffer.from(text, "hex"));
  try {
    return ml_dsa65.keygen(seed);
  } finally {
    seed.fill(0);
  }
}
