/**
 * Runtime attestation — per-action TEE attestations over arbitrary payloads.
 *
 * Two proofs now back every match result:
 *   1. signer.mjs — an enclave-held wallet key signs the result (ecrecover).
 *   2. THIS — at match end the enclave requests a fresh attestation whose
 *      extra-data is the SHA-512 of the same canonical result message. The KMS
 *      verifies the TEE quote against this app's registered image and mints a
 *      JWT binding (payload hash ↔ attested instance ↔ time). Decoding the JWT
 *      and comparing the hash needs no wallet tooling at all.
 *
 * Uses JwtProvider.getToken(extraData): per-action (bypasses the long-lived
 * token cache) while deduping concurrent in-flight requests for the same
 * extraData. extraData must stay small — SHA-512 digest = exactly 64 bytes,
 * which every TEE accepts.
 */
import { createHash } from "node:crypto";

const AUDIENCES = [process.env.ATTEST_AUDIENCE, "proxy-arena", "llm-proxy"].filter(Boolean);

let providers = null; // Map<audience, JwtProvider>
const status = {
  configured: Boolean(process.env.KMS_SERVER_URL && process.env.KMS_PUBLIC_KEY),
  audience: null,        // audience that last minted successfully
  attestations: 0,
  lastAttestAt: null,
  lastError: null,
};

export function attestStatus() { return { ...status }; }

async function getProviders() {
  if (providers) return providers;
  if (!status.configured) return null;
  const { AttestClient, JwtProvider } = await import("@layr-labs/ecloud-sdk/attest");
  providers = new Map();
  for (const aud of AUDIENCES) {
    providers.set(aud, new JwtProvider(new AttestClient({
      kmsServerURL: process.env.KMS_SERVER_URL,
      kmsPublicKey: process.env.KMS_PUBLIC_KEY,
      audience: aud,
    })));
  }
  return providers;
}

export function sha512Of(data) {
  return createHash("sha512").update(data).digest();
}

function b64urlToJson(part) {
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch { return null; }
}

export function decodeJwt(jwt) {
  const [h, p] = String(jwt).split(".");
  return { header: b64urlToJson(h), payload: b64urlToJson(p) };
}

/** Which claim paths in the JWT payload carry our digest (hex/base64/base64url). */
export function findHashClaims(payload, digest) {
  const enc = [
    digest.toString("hex"),
    "0x" + digest.toString("hex"),
    digest.toString("base64"),
    digest.toString("base64url"),
  ].map((s) => s.toLowerCase());
  const hits = [];
  const walk = (v, path) => {
    if (typeof v === "string") {
      if (enc.includes(v.toLowerCase())) hits.push(path);
    } else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k);
    }
  };
  walk(payload, "");
  return hits;
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`attest timeout ${ms}ms`)), ms))]);

/**
 * Attest a payload (string or Buffer).
 * Returns { jwt, audience, sha512Hex, claims, matchedClaims }
 * or { unavailable: true, note, sha512Hex }.
 */
export async function attestPayload(data) {
  const digest = sha512Of(data);
  const sha512Hex = digest.toString("hex");
  const provs = await getProviders().catch((e) => { status.lastError = String(e?.message || e).slice(0, 160); return null; });
  if (!provs) return { unavailable: true, note: status.lastError || "no KMS attestation config (local mode)", sha512Hex };

  // try the last-known-good audience first, then the rest
  const order = status.audience
    ? [status.audience, ...AUDIENCES.filter((a) => a !== status.audience)]
    : AUDIENCES;

  let lastErr = null;
  for (const aud of order) {
    const prov = provs.get(aud);
    if (!prov) continue;
    try {
      const jwt = await withTimeout(prov.getToken(digest), 20000);
      status.audience = aud;
      status.attestations += 1;
      status.lastAttestAt = new Date().toISOString();
      status.lastError = null;
      const { payload } = decodeJwt(jwt);
      return {
        jwt,
        audience: aud,
        sha512Hex,
        claims: payload,
        matchedClaims: payload ? findHashClaims(payload, digest) : [],
      };
    } catch (e) {
      lastErr = e;
    }
  }
  status.lastError = String(lastErr?.message || lastErr).slice(0, 200);
  return { unavailable: true, note: status.lastError, sha512Hex };
}
