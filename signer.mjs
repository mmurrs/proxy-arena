/**
 * Enclave result signing.
 *
 * EigenCompute delivers a MNEMONIC to the app inside the TEE; the platform
 * registers the derived EVM address (path m/44'/60'/0'/0/0) on the app's
 * public dashboard. The key material never leaves the enclave — so a match
 * result signed here, verifying against the dashboard-listed address, is
 * cryptographic proof the result was produced by THIS app running in THIS
 * enclave, not by anyone else (including the operator).
 *
 * Local dev without MNEMONIC: signing reports unavailable; everything else runs.
 */
import { HDNodeWallet, Mnemonic, verifyMessage, sha256, toUtf8Bytes } from "ethers";

const DERIVATION_PATH = "m/44'/60'/0'/0/0";

let wallet = null;
try {
  const phrase = process.env.MNEMONIC;
  if (phrase) {
    wallet = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase.trim()), DERIVATION_PATH);
  }
} catch (e) {
  console.error(`signer: could not derive wallet from MNEMONIC: ${e?.message}`);
  wallet = null;
}

export function signingAvailable() { return wallet !== null; }
export function enclaveAddress() { return wallet?.address ?? null; }

/** Canonical JSON: stable key order so the signed bytes are reproducible. */
export function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(",")}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function hashDecisions(log) {
  // hash the ordered (nation, action) pairs — the full causal record of the match
  return sha256(toUtf8Bytes(canonicalize(log.map((l) => ({ n: l.nation, a: l.action })))));
}

/**
 * Sign a match result tuple. Returns { tuple, message, signature, address } or
 * { tuple, message, unavailable: true } when no key is present.
 */
export async function signResult(tuple) {
  const message = canonicalize(tuple);
  if (!wallet) return { tuple, message, unavailable: true };
  const signature = await wallet.signMessage(message);
  return { tuple, message, signature, address: wallet.address };
}

/** Server-side convenience check (the UI can also verify client-side). */
export function verifySignature(message, signature) {
  try {
    return { recovered: verifyMessage(message, signature) };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}
