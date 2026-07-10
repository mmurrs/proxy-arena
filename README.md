# ProxyWar Arena — verifiable AI-vs-AI strategy on EigenCompute

An AI-vs-AI territory game where the **game engine, the AI players' reasoning, and the result
signature all come from inside a TEE** — and every claim is checkable.

Type plain-English orders for your nation. Four AI nations expand, ally, betray, and nuke.
The match ends with a result **signed by a key that exists only inside the enclave**: one
`ecrecover` against the address on the [EigenCloud verify dashboard](https://verify.eigencloud.xyz)
proves the outcome came from this exact code in this exact enclave — nobody, including the
people who deployed it, could forge it.

## The gap this fills

Agent arenas and eval platforms today are **trusted operators**. Results are unsigned, replays
aren't bound to scores, LLM traffic is visible to the platform, and leaderboards can't be
recomputed by outsiders — every claim bottoms out at *"trust our servers."* That's fine at zero
stakes, and broken the moment a result carries money, a ranking, or a research claim. (Survey of
the RL-eval vendor market: **0 of 38 vendors ship any attestation scheme.**)

This demo is the counterfactual: **the same match, with evidence.**

| Claim | Evidence | Check it |
|---|---|---|
| The engine + AI run in a TEE | EigenCompute deployment, app ID on the verify dashboard | dashboard link on the Verify tab |
| The running code is this repo | Verifiable build from a pinned public commit | compare digest vs local rebuild |
| The result wasn't forged | Enclave-wallet signature over the canonical result tuple | one `ecrecover`, button in the UI |
| The result is what the enclave saw | Per-action KMS attestation over the result's SHA-512 | decode the JWT, recompute the hash |
| The match can be re-derived | Engine is a pure function of (seed, decisions) | re-run this repo's engine from the seed |

Nothing here is game-specific — the game is just the most legible way to watch **neutral
execution produce receipts**.

## The opportunity for EigenCompute

EigenCloud already runs staked, verified tournaments for **human** players
([OpenFront × EigenCloud](https://blog.eigencloud.xyz/openfront-eigencloud-verifiable-tournaments/)).
This extends the same rail to **agent** players:

- **Attested evals as a service** — benchmark and competition results a stranger can cite
- **Signed leaderboards** — recomputable by outsiders, not vouched for by operators
- **Stakes on agent competition** — entries and payouts on results nobody has to trust

Platforms keep their games and their community; EigenCompute becomes the layer that makes
their results citable.

> This demo is self-contained — results are **not** sent to Softmax or any external platform.
> It exists to show what any arena gains from running on attested compute.

## How it works

```
browser ──── strategy (plain english) ────▶ ┌─────────────── TEE ───────────────┐
                                            │ LLM planner ◀─▶ attested gateway  │
browser ◀─── SSE: board/plans/events ────── │ deterministic engine (seeded)     │
                                            │ result → wallet sig + attestation │
browser ◀─── signed result tuple ────────── └───────────────────────────────────┘
```

- `game.mjs` — pure engine: deterministic from `(seed, decisions)`, so results are replayable
- `brains.mjs` — deferred planning: the LLM writes a short PLAN every few turns; a deterministic
  executor picks one legal move per turn (matches never stall on model latency)
- `gateway.mjs` — model calls via the Eigen AI gateway, authed by an attestation-derived JWT
  (no API key exists in the container)
- `signer.mjs` — signs the canonical result with the enclave wallet (KMS-injected `MNEMONIC`)
- `attest.mjs` — per-action runtime attestation: KMS-minted JWT over the result's SHA-512
- `server.mjs` — match orchestration, SSE streaming, `/api/verify` proof surface
- `public/index.html` — the whole UI (arena + verify tabs), single file, no build step

## Run it

```bash
npm install
npm start                     # http://localhost:3000 — local mode, unsigned, doctrine AI
```

Deploy to EigenCompute (verifiable build):

```bash
ecloud compute app deploy \
  --verifiable --repo https://github.com/mmurrs/proxy-arena --commit <sha> \
  --build-dockerfile Dockerfile --build-caddyfile Caddyfile \
  --env-file .env.mainnet --environment mainnet-alpha \
  --instance-type g1-standard-2s --log-visibility public
```

In the TEE, the platform injects `MNEMONIC` (result signing), `KMS_SERVER_URL`/`KMS_PUBLIC_KEY`
(attestation + gateway JWT) automatically. The UI's status strip reports exactly which proofs are
live right now — the page structurally cannot claim more than `/api/verify` can show.

## Honest status

The `/api/verify` endpoint and the status strip always tell the truth about the current instance.
Two platform-side issues are visible there today (both escalated): enclave→gateway egress returns
502 on model calls (AI falls back to built-in doctrine, clearly labeled), and per-action
attestation hits a KMS TPM-nonce mismatch (the wallet-signature proof is unaffected and verified).
