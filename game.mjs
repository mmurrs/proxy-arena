/**
 * ProxyWar-style territory-conquest engine — pure, deterministic, seeded.
 *
 * The whole engine is a function of (seed, sequence of chosen actions), so a
 * match replays identically from its seed + decision log. That determinism is
 * the property that becomes VALUABLE in a TEE: the enclave can sign
 * (seed, decisions, final_state) and anyone can re-run this file to check it.
 *
 * No I/O, no randomness outside the seeded RNG, no wall-clock.
 */

// -- seeded RNG (mulberry32) so matches are reproducible ----------------------
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NATION_NAMES = ["Crimson", "Azure", "Verdant", "Amber"];
export const ACTION_KINDS = [
  "expand", "attack", "build", "alliance_request", "betray", "nuke", "hold",
];

const GRID_W = 5;
const GRID_H = 5;
const BUILD_COST = 10;      // gold → +5 troops on a territory
const BUILD_TROOPS = 5;
const BUILD_STACK_CAP = 25; // can't build past this on one tile (anti-turtle)
const NUKE_COST = 45;       // gold → remove most troops from a target territory
const INCOME_PER_TILE = 2;  // gold per owned tile per turn
const START_TROOPS = 12;

function key(x, y) { return y * GRID_W + x; }

// Build a 5x5 grid graph with 4-way adjacency.
function buildTerritories() {
  const terr = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const adj = [];
      if (x > 0) adj.push(key(x - 1, y));
      if (x < GRID_W - 1) adj.push(key(x + 1, y));
      if (y > 0) adj.push(key(x, y - 1));
      if (y < GRID_H - 1) adj.push(key(x, y + 1));
      terr.push({ id: key(x, y), x, y, owner: null, troops: 3, adj });
    }
  }
  return terr;
}

export function initGame(seed, maxTurns = 60) {
  const rng = makeRng(seed);
  const territories = buildTerritories();

  // Seat 4 nations in the four corners; neutral elsewhere.
  const corners = [key(0, 0), key(GRID_W - 1, 0), key(0, GRID_H - 1), key(GRID_W - 1, GRID_H - 1)];
  const nations = NATION_NAMES.map((name, i) => ({
    id: i, name, alive: true, gold: 20,
    allies: [],           // nation ids
    home: corners[i],
  }));
  corners.forEach((tid, i) => {
    territories[tid].owner = i;
    territories[tid].troops = START_TROOPS;
  });
  // A few neutral garrisons in the middle to make expansion non-trivial.
  for (const t of territories) {
    if (t.owner === null) t.troops = 2 + Math.floor(rng() * 4);
  }

  return {
    seed, turn: 0, maxTurns: Math.min(120, Math.max(20, maxTurns | 0)),
    territories, nations,
    current: 0,            // whose decision it is
    log: [],               // { turn, nation, action, detail }
    rngState: seed >>> 0,  // advanced lazily via nextRng
    over: false, winner: null,
  };
}

// Deterministic per-call RNG that threads through game state.
function nextRng(g) {
  let a = g.rngState >>> 0;
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  g.rngState = (t ^ (t >>> 14)) >>> 0;
  return g.rngState / 4294967296;
}

export function ownedTiles(g, nationId) {
  return g.territories.filter((t) => t.owner === nationId);
}
function isAllied(g, a, b) {
  return g.nations[a].allies.includes(b);
}

/** Enumerate the legal actions for the nation whose turn it is. */
export function legalActions(g, nationId) {
  const actions = [{ id: "hold", kind: "hold", label: "Hold position" }];
  const nation = g.nations[nationId];
  const mine = ownedTiles(g, nationId);
  if (mine.length === 0) return actions;

  // expand / attack: from an owned tile with >1 troop into an adjacent tile
  for (const t of mine) {
    if (t.troops <= 1) continue;
    for (const nid of t.adj) {
      const target = g.territories[nid];
      if (target.owner === nationId) continue;
      if (target.owner !== null && isAllied(g, nationId, target.owner)) continue; // can't attack allies
      const kind = target.owner === null ? "expand" : "attack";
      const oname = target.owner === null ? "neutral" : g.nations[target.owner].name;
      actions.push({
        id: `${kind}:${t.id}->${nid}`, kind,
        from: t.id, to: nid,
        label: `${kind === "expand" ? "Expand into" : "Attack"} ${oname} tile (${target.troops} def) from tile with ${t.troops}`,
        targetNation: target.owner,
      });
    }
  }
  // build: +troops on an owned tile if gold allows — but cap stacking so
  // nations can't turtle infinitely on one fortress tile (kills stalemates).
  if (nation.gold >= BUILD_COST) {
    for (const t of mine) {
      if (t.troops >= BUILD_STACK_CAP) continue;
      actions.push({ id: `build:${t.id}`, kind: "build", to: t.id, label: `Build +${BUILD_TROOPS} troops (cost ${BUILD_COST}g)` });
    }
  }
  // alliance_request: with a living non-ally nation that still owns land
  for (const other of g.nations) {
    if (other.id === nationId || !other.alive) continue;
    if (isAllied(g, nationId, other.id)) continue;
    if (ownedTiles(g, other.id).length === 0) continue;
    actions.push({ id: `alliance_request:${other.id}`, kind: "alliance_request", targetNation: other.id, label: `Propose alliance with ${other.name}` });
  }
  // betray: break an existing alliance (frees you to attack them next turn)
  for (const aid of nation.allies) {
    actions.push({ id: `betray:${aid}`, kind: "betray", targetNation: aid, label: `Betray ${g.nations[aid].name} (break alliance)` });
  }
  // nuke: expensive; hit the strongest enemy tile bordering you
  if (nation.gold >= NUKE_COST) {
    const borderEnemy = new Set();
    for (const t of mine) for (const nid of t.adj) {
      const tt = g.territories[nid];
      if (tt.owner !== null && tt.owner !== nationId && !isAllied(g, nationId, tt.owner)) borderEnemy.add(nid);
    }
    for (const nid of borderEnemy) {
      const tt = g.territories[nid];
      actions.push({ id: `nuke:${nid}`, kind: "nuke", to: nid, label: `Nuke ${g.nations[tt.owner].name} tile (${tt.troops} troops, cost ${NUKE_COST}g)`, targetNation: tt.owner });
    }
  }
  return actions;
}

/** Apply one chosen action id for the given nation, mutating g. Returns a log line. */
export function applyAction(g, nationId, actionId) {
  const nation = g.nations[nationId];
  const [kind, arg] = actionId.split(":");
  let detail = "";

  if (kind === "hold") {
    detail = "held position";
  } else if (kind === "expand" || kind === "attack") {
    const [fromS, toS] = arg.split("->");
    const from = g.territories[+fromS], to = g.territories[+toS];
    if (from && to && from.owner === nationId && from.troops > 1) {
      const moving = from.troops - 1;           // leave 1 behind
      from.troops = 1;
      if (to.owner === null || to.owner === nationId) {
        to.owner = nationId; to.troops += moving;
        detail = `moved ${moving} into tile ${to.id}`;
      } else {
        // combat: attacker moving vs defender troops, small seeded luck
        const luck = 0.85 + nextRng(g) * 0.3;   // 0.85–1.15
        const atk = moving * luck;
        if (atk > to.troops) {
          const survivors = Math.max(1, Math.round(moving - to.troops / luck));
          const prevOwner = to.owner;
          to.owner = nationId; to.troops = survivors;
          detail = `captured tile ${to.id} from ${g.nations[prevOwner].name} (${survivors} left)`;
        } else {
          const defLeft = Math.max(1, Math.round(to.troops - atk));
          to.troops = defLeft;
          detail = `assault on tile ${to.id} repelled (def ${defLeft} left)`;
        }
      }
    } else detail = "invalid move (ignored)";
  } else if (kind === "build") {
    const t = g.territories[+arg];
    if (t && t.owner === nationId && nation.gold >= BUILD_COST) {
      nation.gold -= BUILD_COST; t.troops += BUILD_TROOPS;
      detail = `built +${BUILD_TROOPS} on tile ${t.id}`;
    } else detail = "build failed (ignored)";
  } else if (kind === "alliance_request") {
    const other = g.nations[+arg];
    if (other && other.alive && !isAllied(g, nationId, other.id)) {
      // Acceptance is deterministic: accept if not currently stronger by 2x.
      const mineTiles = ownedTiles(g, nationId).length;
      const theirTiles = ownedTiles(g, other.id).length;
      if (theirTiles > 0 && mineTiles <= theirTiles * 2) {
        nation.allies.push(other.id); other.allies.push(nationId);
        detail = `formed alliance with ${other.name}`;
      } else detail = `alliance with ${other.name} declined`;
    } else detail = "alliance invalid (ignored)";
  } else if (kind === "betray") {
    const other = g.nations[+arg];
    if (other) {
      nation.allies = nation.allies.filter((x) => x !== other.id);
      other.allies = other.allies.filter((x) => x !== nationId);
      detail = `betrayed ${other.name}`;
    }
  } else if (kind === "nuke") {
    const t = g.territories[+arg];
    if (t && t.owner !== null && t.owner !== nationId && nation.gold >= NUKE_COST) {
      nation.gold -= NUKE_COST;
      const before = t.troops;
      t.troops = Math.max(1, Math.round(t.troops * 0.15));
      detail = `nuked tile ${t.id} (${before}→${t.troops})`;
    } else detail = "nuke failed (ignored)";
  }

  const line = { turn: g.turn, nation: nation.name, action: actionId, detail };
  g.log.push(line);
  return line;
}

/** Advance to the next living nation; grant income + check end conditions on wrap. */
export function endTurn(g) {
  // income for the nation that just moved
  const justMoved = g.nations[g.current];
  justMoved.gold += ownedTiles(g, justMoved.id).length * INCOME_PER_TILE;

  // mark dead nations
  for (const n of g.nations) {
    if (n.alive && ownedTiles(g, n.id).length === 0) {
      n.alive = false;
      // dissolve their alliances
      for (const other of g.nations) other.allies = other.allies.filter((x) => x !== n.id);
    }
  }

  // next living nation
  let next = g.current;
  for (let i = 0; i < g.nations.length; i++) {
    next = (next + 1) % g.nations.length;
    if (g.nations[next].alive) break;
  }
  // a full wrap (back to <= current) means a new round → increment turn
  if (next <= g.current) g.turn += 1;
  g.current = next;

  const living = g.nations.filter((n) => n.alive);
  if (living.length <= 1 || g.turn >= g.maxTurns) {
    g.over = true;
    // winner = most tiles, tiebreak troops
    const rank = [...g.nations].sort((a, b) => {
      const at = ownedTiles(g, a.id).length, bt = ownedTiles(g, b.id).length;
      if (bt !== at) return bt - at;
      const asum = ownedTiles(g, a.id).reduce((s, t) => s + t.troops, 0);
      const bsum = ownedTiles(g, b.id).reduce((s, t) => s + t.troops, 0);
      return bsum - asum;
    });
    g.winner = rank[0]?.id ?? null;
  }
  return g;
}

/** Compact per-nation snapshot for a planner/LLM to reason over. */
export function snapshotFor(g, nationId) {
  const total = g.territories.length;
  const me = g.nations[nationId];
  const myTiles = ownedTiles(g, nationId);
  const myTroops = myTiles.reduce((s, t) => s + t.troops, 0);
  const rivals = g.nations
    .filter((n) => n.id !== nationId && n.alive)
    .map((n) => {
      const tiles = ownedTiles(g, n.id);
      const troops = tiles.reduce((s, t) => s + t.troops, 0);
      const borders = myTiles.some((t) => t.adj.some((a) => g.territories[a].owner === n.id));
      return {
        name: n.name, tileShare: +(tiles.length / total).toFixed(2),
        relativeTroopRatio: +(myTroops / Math.max(1, troops)).toFixed(2),
        sharesBorder: borders, isAllied: isAllied(g, nationId, n.id),
      };
    });
  return {
    turn: g.turn, maxTurns: g.maxTurns,
    self: { name: me.name, tileShare: +(myTiles.length / total).toFixed(2), troops: myTroops, gold: me.gold, allies: me.allies.map((a) => g.nations[a].name) },
    rivals,
  };
}

/** Public view of the board for the UI. */
export function boardView(g) {
  return {
    turn: g.turn, maxTurns: g.maxTurns, over: g.over,
    winner: g.winner !== null ? g.nations[g.winner].name : null,
    current: g.nations[g.current]?.name ?? null,
    gridW: GRID_W, gridH: GRID_H,
    territories: g.territories.map((t) => ({ id: t.id, x: t.x, y: t.y, owner: t.owner, troops: t.troops })),
    nations: g.nations.map((n) => ({
      id: n.id, name: n.name, alive: n.alive, gold: n.gold,
      allies: n.allies.map((a) => g.nations[a].name),
      tiles: ownedTiles(g, n.id).length,
      troops: ownedTiles(g, n.id).reduce((s, t) => s + t.troops, 0),
    })),
  };
}
