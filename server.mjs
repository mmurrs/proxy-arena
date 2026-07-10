/**
 * ProxyWar Arena — server.
 *
 * Everything that matters runs INSIDE this container, which on EigenCompute
 * runs inside a TEE:
 *   - the match engine (deterministic from seed + decisions)
 *   - the LLM planner for every nation (via the Eigen AI gateway, authed by
 *     an attestation-derived JWT the platform injects into the enclave)
 *   - the result signer (enclave-held key; its address is publicly bound to
 *     this app on the EigenCloud verify dashboard)
 *
 * /api/verify exposes all of it as checkable facts — the Verify tab renders
 * that, and the end of each match emits an enclave-signed result tuple that
 * anyone can validate with one ecrecover.
 */
import express from "express";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  initGame, legalActions, applyAction, endTurn, snapshotFor, boardView, NATION_NAMES,
} from "./game.mjs";
import { rulePlan, refreshPlan, DEFAULT_PLANS } from "./brains.mjs";
import { gatewayStatus, probeModels } from "./gateway.mjs";
import { signingAvailable, enclaveAddress, signResult, hashDecisions, verifySignature, canonicalize } from "./signer.mjs";
import { attestPayload, attestStatus, sha512Of } from "./attest.mjs";

const PORT = Number(process.env.APP_PORT || process.env.PORT || 3000);
const PLAN_EVERY = Number(process.env.PLAN_EVERY || 4);
const TURN_DELAY_MS = Number(process.env.TURN_DELAY_MS || 350);
const IN_ENCLAVE = Boolean(process.env.KMS_SERVER_URL || process.env.KMS_AUTH_JWT);

const APP_ID = process.env.EIGEN_APP_ID || null;
const REPO = "https://github.com/mmurrs/proxy-arena";
const DASHBOARD_BASE = process.env.EIGEN_DASHBOARD_BASE || "https://verify.eigencloud.xyz";
// Never emit a dead link: no app ID → no dashboard URL (UI shows "pending registration").
const DASHBOARD = APP_ID ? `${DASHBOARD_BASE}/app/${APP_ID}` : null;
let BUILT_COMMIT = "unknown";
try { BUILT_COMMIT = readFileSync("COMMIT", "utf8").trim(); } catch {}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// ---- the Verify surface ------------------------------------------------------
app.get("/api/verify", async (_req, res) => {
  const gw = gatewayStatus();
  // Honest "what is true right now" summary — the UI renders this verbatim,
  // so the page can never claim more than the instance can prove.
  const now = {
    engineInTee: IN_ENCLAVE,
    llmSteering: gw.lastSuccessAt !== null,      // a model call has actually succeeded
    resultsSigned: signingAvailable(),
    statusLine: [
      IN_ENCLAVE ? "engine: in TEE" : "engine: local (no enclave)",
      gw.lastSuccessAt ? `AI plans: ${gw.activeModel} via gateway` : "AI plans: built-in doctrine (gateway unavailable)",
      signingAvailable() ? "results: enclave-signed" : "results: unsigned",
    ].join(" · "),
  };
  res.json({
    now,
    headline: IN_ENCLAVE
      ? "This arena — engine, AI players, and result signing — is executing inside an EigenCompute TEE."
      : "Local/dev mode: the same code, outside an enclave. Deploy to EigenCompute for the attested version.",
    enclave: {
      runningInEnclave: IN_ENCLAVE,
      appId: APP_ID,
      dashboard: DASHBOARD,
      how: "EigenCompute boots this container inside a hardware TEE. The platform's verify dashboard binds the app ID to the attested image digest and the enclave-derived keys below.",
    },
    build: {
      commit: BUILT_COMMIT,
      repo: REPO,
      commitUrl: `${REPO}/tree/${BUILT_COMMIT}`,
      how: "Verifiable build: the platform built this image from the public repo at this commit and recorded a provenance signature. Compare the dashboard's image digest with a local rebuild of the same commit to check it.",
    },
    modelAccess: {
      gateway: gw.gateway,
      attestationJwt: gw.jwtPresent,
      activeModel: gw.activeModel,
      availableModels: gw.availableModels,
      calls: gw.calls,
      failures: gw.failures,
      lastSuccessAt: gw.lastSuccessAt,
      lastError: gw.lastError,
      how: "Every nation's PLAN is written by a model reached through the Eigen AI gateway, authenticated with a JWT minted from this enclave's attestation — no API key exists in this container.",
    },
    resultSigning: {
      available: signingAvailable(),
      enclaveAddress: enclaveAddress(),
      how: signingAvailable()
        ? "Match results are signed with a key derived inside the enclave (path m/44'/60'/0'/0/0). That address is listed on the app's verify dashboard — if the signature recovers to it, the result came from this enclave and nowhere else."
        : "No enclave key present (local mode) — results are unsigned here.",
    },
    runtimeAttestation: {
      ...attestStatus(),
      how: attestStatus().configured
        ? "At match end the enclave requests a fresh per-action attestation whose extra-data is the SHA-512 of the result. The KMS verifies the hardware quote before minting the JWT, binding (this result ↔ this attested instance ↔ this moment). Independent of the wallet key."
        : "No KMS attestation config (local mode) — per-action attestation unavailable here.",
    },
    determinism: {
      how: "The engine is a pure function of (seed, decision log). Re-running the public engine code with the signed seed and decisions reproduces the exact final board — so a signed tuple is a checkable claim, not a trust-me claim.",
    },
  });
});

// verify a signed result (the UI also does this client-side via ecrecover)
app.post("/api/verify/signature", (req, res) => {
  const { message, signature } = req.body || {};
  if (!message || !signature) return res.status(400).json({ error: "message and signature required" });
  res.json(verifySignature(message, signature));
});

// kick a models probe on demand (also runs at boot)
app.post("/api/verify/probe-models", async (_req, res) => res.json({ models: await probeModels() }));

// legacy endpoint kept for links that point at /attestation
app.get("/attestation", (_req, res) => res.redirect("/api/verify"));

// ---- matches -----------------------------------------------------------------
const matches = new Map();

app.post("/api/match", (req, res) => {
  const strategy = String(req.body?.strategy || "").slice(0, 1200) ||
    "Expand into neutral land early, build economy once you hold a base, attack only rivals weaker than you, and honor alliances until betrayal clearly wins.";
  const yourNation = NATION_NAMES.includes(req.body?.nation) ? req.body.nation : "Crimson";
  const seed = Number.isFinite(req.body?.seed) ? (req.body.seed >>> 0) : (randomBytes(4).readUInt32BE(0));

  const game = initGame(seed);
  const id = randomBytes(4).toString("hex");
  const plans = {};
  for (const name of NATION_NAMES) plans[name] = { ...DEFAULT_PLANS[name] };
  matches.set(id, { game, strategy, yourNation, plans, subscribers: new Set(), running: false, planAge: {} });
  res.json({ id, seed, yourNation, inEnclave: IN_ENCLAVE });
});

app.get("/api/match/:id/stream", (req, res) => {
  const m = matches.get(req.params.id);
  if (!m) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  m.subscribers.add(send);
  send("board", boardView(m.game));
  send("meta", { strategy: m.strategy, yourNation: m.yourNation, inEnclave: IN_ENCLAVE, seed: m.game.seed });
  req.on("close", () => m.subscribers.delete(send));
  if (!m.running) runMatch(m).catch((e) => console.error("match error", e));
});

function broadcast(m, event, data) { for (const s of m.subscribers) s(event, data); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMatch(m) {
  m.running = true;
  const g = m.game;

  while (!g.over) {
    const nationName = g.nations[g.current].name;
    const nationId = g.current;
    const snap = snapshotFor(g, nationId);

    m.planAge[nationName] = (m.planAge[nationName] || 0) + 1;
    if (m.planAge[nationName] >= PLAN_EVERY || !m.plans[nationName]._seeded) {
      const strat = nationName === m.yourNation
        ? m.strategy
        : `You are ${nationName}. Doctrine: ${m.plans[nationName].reason}. Prefer ${m.plans[nationName].preferKinds.join(", ")}.`;
      const { plan, degraded, note } = await refreshPlan(strat, snap, m.plans[nationName]);
      if (plan) m.plans[nationName] = { ...plan, _seeded: true };
      else m.plans[nationName]._seeded = true;
      m.planAge[nationName] = 0;
      broadcast(m, "plan", {
        nation: nationName,
        yours: nationName === m.yourNation,
        plan: m.plans[nationName],
        source: degraded ? "doctrine-fallback" : `llm:${m.plans[nationName].model || "?"}`,
        degraded, note,
      });
    }

    const actions = legalActions(g, nationId);
    const choice = rulePlan(m.plans[nationName], actions, snap);
    const line = applyAction(g, nationId, choice.id);
    const p = m.plans[nationName];
    broadcast(m, "log", {
      turn: g.turn, nation: nationName, kind: choice.kind, detail: line.detail,
      focus: p.focus, planSource: p.model ? `llm:${p.model}` : "doctrine",
    });
    endTurn(g);
    broadcast(m, "board", boardView(g));
    await sleep(TURN_DELAY_MS);
  }

  const view = boardView(g);
  const tuple = {
    app: "proxy-arena",
    appId: APP_ID,
    commit: BUILT_COMMIT,
    seed: g.seed,
    turns: g.turn,
    decisions: g.log.length,
    decisionsHash: hashDecisions(g.log),
    winner: view.winner,
    finalTiles: Object.fromEntries(view.nations.map((n) => [n.name, n.tiles])),
  };
  const signed = await signResult(tuple);
  // Second, independent proof: a fresh per-action TEE attestation whose
  // extra-data is the SHA-512 of the same canonical message. Wallet key
  // proves "this app's key signed it"; this proves "an attested enclave
  // instance committed to it" — hardware-rooted, no wallet tooling needed.
  const attestation = await attestPayload(signed.message);
  broadcast(m, "result", {
    ...signed,
    canonicalMessage: signed.message,
    attestation: attestation.unavailable
      ? { unavailable: true, note: attestation.note, sha512: attestation.sha512Hex }
      : {
          jwt: attestation.jwt,
          audience: attestation.audience,
          sha512: attestation.sha512Hex,
          matchedClaims: attestation.matchedClaims,
          how: "Decode the JWT (KMS-signed): its extra-data claim is the SHA-512 of canonicalMessage. Recompute the hash to check the enclave committed to exactly this result.",
        },
    verify: {
      dashboard: DASHBOARD,
      expectAddress: enclaveAddress(),
      how: signed.unavailable
        ? "Unsigned (local mode)."
        : "ecrecover(message, signature) must equal the enclave address listed on the dashboard.",
    },
  });
  broadcast(m, "done", {});
}

app.use(express.static("public"));

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`proxy-arena listening on :${PORT} — enclave=${IN_ENCLAVE} signer=${signingAvailable() ? enclaveAddress() : "none"}`);
  const models = await probeModels();
  console.log(`gateway models: ${models ? models.slice(0, 8).join(", ") : "probe failed — " + gatewayStatus().lastError}`);
});
