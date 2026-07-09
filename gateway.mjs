/**
 * Eigen AI gateway client — plain fetch, enclave-native auth.
 *
 * Inside an EigenCompute TEE the platform injects KMS_AUTH_JWT (audience
 * "llm-proxy"), minted against the enclave's attestation. Using it directly
 * keeps the whole model path inspectable: one HTTPS call to the gateway,
 * bearer = attestation-derived JWT. If the primary model 502s (upstream not
 * provisioned), we walk a fallback list; /v1/models tells us what's live.
 *
 * Everything here is surfaced on /api/verify so the demo can show, not tell.
 */

const GATEWAY = process.env.EIGEN_GATEWAY_URL || "https://ai-gateway-dev.eigencloud.xyz";

// JWT minting: inside the TEE the platform sets KMS_SERVER_URL + KMS_PUBLIC_KEY;
// the SDK's AttestClient turns those into a gateway JWT (audience "llm-proxy")
// via the enclave's attestation. KMS_AUTH_JWT, if present, overrides.
let jwtProvider = null;
async function getJwt() {
  if (process.env.KMS_AUTH_JWT) return process.env.KMS_AUTH_JWT;
  if (!process.env.KMS_SERVER_URL || !process.env.KMS_PUBLIC_KEY) return null;
  try {
    if (!jwtProvider) {
      const { AttestClient, JwtProvider } = await import("@layr-labs/ecloud-sdk/attest");
      const attestClient = new AttestClient({
        kmsServerURL: process.env.KMS_SERVER_URL,
        kmsPublicKey: process.env.KMS_PUBLIC_KEY,
        audience: "llm-proxy",
      });
      jwtProvider = new JwtProvider(attestClient);
    }
    return await jwtProvider.getToken();
  } catch (e) {
    status.lastError = `jwt mint: ${(e?.message || e).toString().slice(0, 140)}`;
    return null;
  }
}
const MODELS = [
  process.env.ARENA_MODEL,
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
].filter(Boolean);

let lockedModel = null;
const status = {
  gateway: GATEWAY,
  jwtPresent: Boolean(process.env.KMS_AUTH_JWT || (process.env.KMS_SERVER_URL && process.env.KMS_PUBLIC_KEY)),
  kmsAttestation: Boolean(process.env.KMS_SERVER_URL && process.env.KMS_PUBLIC_KEY),
  availableModels: null,   // from /v1/models, null until probed
  activeModel: null,
  lastError: null,
  lastSuccessAt: null,
  calls: 0, failures: 0,
};

export function gatewayStatus() { return { ...status }; }

async function authHeaders() {
  const jwt = await getJwt();
  return jwt ? { authorization: `Bearer ${jwt}` } : {};
}

/** Probe /v1/models once (refreshable) so we know what this enclave can reach. */
export async function probeModels() {
  try {
    const r = await fetch(`${GATEWAY}/v1/models`, { headers: await authHeaders(), signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      status.lastError = `models probe ${r.status}`;
      return null;
    }
    const j = await r.json();
    const ids = (j?.data || []).map((m) => m.id).filter(Boolean);
    status.availableModels = ids;
    return ids;
  } catch (e) {
    status.lastError = `models probe: ${(e?.message || e).toString().slice(0, 120)}`;
    return null;
  }
}

/**
 * One chat completion via the gateway. Walks the model fallback list on
 * 5xx/404 (model not provisioned); throws only when every candidate fails.
 */
export async function complete(prompt, { maxTokens = 300, temperature = 0.7 } = {}) {
  status.calls += 1;
  // Prefer: locked model → models the gateway says exist (in our preference order) → static list
  let candidates = lockedModel ? [lockedModel] : MODELS;
  if (!lockedModel && status.availableModels?.length) {
    const live = MODELS.filter((m) => status.availableModels.includes(m));
    if (live.length) candidates = live;
    else candidates = [...status.availableModels.slice(0, 3), ...MODELS];
  }

  let lastErr = null;
  for (const model of candidates) {
    try {
      const r = await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 160);
        lastErr = new Error(`${model}: HTTP ${r.status} ${body.startsWith("<") ? "(html error page)" : body}`);
        continue; // try next model
      }
      const j = await r.json();
      const text = j?.choices?.[0]?.message?.content ?? "";
      lockedModel = model;
      status.activeModel = model;
      status.lastSuccessAt = new Date().toISOString();
      status.lastError = null;
      return { text, model };
    } catch (e) {
      lastErr = e;
    }
  }
  status.failures += 1;
  status.lastError = (lastErr?.message || String(lastErr)).slice(0, 200);
  throw lastErr || new Error("no gateway model responded");
}
