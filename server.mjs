/**
 * ProxyWar Arena — server.
 *
 * Runs the whole match server-side inside the container (→ inside the TEE when
 * deployed on EigenCompute). One nation ("your" nation) follows a plain-English
 * STRATEGY you type; the model call that turns that strategy into a PLAN goes
 * through the attested Eigen AI gateway, so the reasoning happens in-enclave.
 * The other nations follow built-in doctrines. The engine is deterministic from
 * its seed, so every match is replayable and its (seed, decisions, result)
 * could be signed by the enclave.
 */
import express from "express";
import { randomBytes } from "node:crypto";
import {
  initGame, legalActions, applyAction, endTurn, snapshotFor, boardView, NATION_NAMES,
} from "./game.mjs";
import { rulePlan, refreshPlan, DEFAULT_PLANS } from "./brains.mjs";

const PORT = Number(process.env.APP_PORT || process.env.PORT || 3000);
const PLAN_EVERY = Number(process.env.PLAN_EVERY || 4);
const TURN_DELAY_MS = Number(process.env.TURN_DELAY_MS || 350);
const HAS_GATEWAY = Boolean(process.env.KMS_SERVER_URL || process.env.EIGEN_GATEWAY_URL);

const app = express();
app.use(express.json({ limit: "64kb" }));

// health endpoint — Caddy gates public traffic on this
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// attestation-surface: what's verifiable about this running instance
app.get("/attestation", (_req, res) => {
  res.json({
    app: "proxy-arena",
    runningInEnclave: HAS_GATEWAY,
    modelAccess: HAS_GATEWAY ? "attested Eigen AI gateway (in-enclave JWT via TEE attestation)" : "gateway not configured (local/dev)",
    determinism: "engine is a pure function of (seed, decisions); replay from seed reproduces the match",
    signable: "(seed, decision_log, final_state) — the tuple an enclave would sign; wired as a stub below",
    note: "Demo tier: game engine + one LLM-driven nation execute server-side. Production adds enclave-signed results + sealed per-nation strategies.",
  });
});

const matches = new Map(); // id -> { game, strategy, plans, subscribers, running }

function newMatchId() { return randomBytes(4).toString("hex"); }

app.post("/api/match", (req, res) => {
  const strategy = String(req.body?.strategy || "").slice(0, 1200) ||
    "Expand into neutral land early, build economy once you hold a base, attack only rivals weaker than you, and honor alliances until betrayal clearly wins.";
  const yourNation = NATION_NAMES.includes(req.body?.nation) ? req.body.nation : "Crimson";
  const seed = Number.isFinite(req.body?.seed) ? (req.body.seed >>> 0) : (randomBytes(4).readUInt32BE(0));

  const game = initGame(seed);
  const id = newMatchId();
  const plans = {};
  for (const name of NATION_NAMES) plans[name] = { ...DEFAULT_PLANS[name] };
  matches.set(id, { game, strategy, yourNation, plans, subscribers: new Set(), running: false, planAge: {} });
  res.json({ id, seed, yourNation, gatewayConfigured: HAS_GATEWAY });
});

// SSE stream of the match as it plays
app.get("/api/match/:id/stream", (req, res) => {
  const m = matches.get(req.params.id);
  if (!m) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  m.subscribers.add(send);
  send("board", boardView(m.game));
  send("meta", { strategy: m.strategy, yourNation: m.yourNation, gatewayConfigured: HAS_GATEWAY });
  req.on("close", () => m.subscribers.delete(send));
  if (!m.running) runMatch(m).catch((e) => console.error("match error", e));
});

function broadcast(m, event, data) { for (const s of m.subscribers) s(event, data); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMatch(m) {
  m.running = true;
  const g = m.game;
  broadcast(m, "log", { line: `Match seed ${g.seed} — ${m.yourNation} follows your strategy; others follow doctrine. Model access: ${HAS_GATEWAY ? "attested Eigen gateway (in-TEE)" : "local doctrine (no gateway)"}.` });

  while (!g.over) {
    const nationName = g.nations[g.current].name;
    const nationId = g.current;
    const snap = snapshotFor(g, nationId);

    // refresh this nation's PLAN periodically. Your nation uses your strategy;
    // others use their doctrine text as the "strategy".
    m.planAge[nationName] = (m.planAge[nationName] || 0) + 1;
    if (m.planAge[nationName] >= PLAN_EVERY || !m.plans[nationName]._seeded) {
      const strat = nationName === m.yourNation
        ? m.strategy
        : `You are ${nationName}. Doctrine: ${m.plans[nationName].reason}. Prefer ${m.plans[nationName].preferKinds.join(", ")}.`;
      const { plan, degraded, note } = await refreshPlan(strat, snap, m.plans[nationName]);
      if (plan) { m.plans[nationName] = { ...plan, _seeded: true }; }
      else m.plans[nationName]._seeded = true;
      m.planAge[nationName] = 0;
      if (nationName === m.yourNation) {
        broadcast(m, "plan", { nation: nationName, plan: m.plans[nationName], degraded, note });
      }
    }

    const actions = legalActions(g, nationId);
    const choice = rulePlan(m.plans[nationName], actions, snap);
    const line = applyAction(g, nationId, choice.id);
    broadcast(m, "log", { line: `T${g.turn} ${nationName}: ${line.detail} [${m.plans[nationName].focus}]` });
    endTurn(g);
    broadcast(m, "board", boardView(g));
    await sleep(TURN_DELAY_MS);
  }

  const view = boardView(g);
  broadcast(m, "log", { line: `— Match over. Winner: ${view.winner ?? "none"} (turn ${g.turn}) —` });
  broadcast(m, "result", {
    seed: g.seed, winner: view.winner, turns: g.turn,
    decisions: g.log.length,
    signable: { seed: g.seed, decisionCount: g.log.length, winner: view.winner },
    note: "In production the enclave signs this tuple; anyone can re-run the engine from the seed + decisions to verify.",
  });
  broadcast(m, "done", {});
}

app.use(express.static("public"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`proxy-arena listening on :${PORT} — gateway ${HAS_GATEWAY ? "configured" : "NOT configured (local doctrine mode)"}`);
});
