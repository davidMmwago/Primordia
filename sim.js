/* Evolution sandbox — simulation core (DOM-free; runs in browser and Node).
 * Organisms are bodies of typed cells on a grid. Nothing in here computes fitness:
 * there are only energy, space, eating, moving, reproducing (with mutation) and dying.
 */
(function (global) {
'use strict';

const T = { NONE: 0, PROD: 1, MOUTH: 2, MOVER: 3, KILLER: 4, ARMOR: 5, EYE: 6 };
const TYPE_NAMES = ['', 'Producer', 'Mouth', 'Mover', 'Killer', 'Armor', 'Eye'];
// Per-cell maintenance weights (energy/tick before size scaling).
const UPKEEP = [0, 0.07, 0.09, 0.12, 0.10, 0.10, 0.08];
const ROLE = { PLANT: 0, GRAZER: 1, PREDATOR: 2, SCAVENGER: 3, OTHER: 4 };
const ROLE_NAMES = ['Plants', 'Grazers', 'Predators', 'Scavengers', 'Other'];

// Internal constants. Tuned headlessly so users only touch coarse knobs.
const K = {
  CB: 10,            // energy to build one cell
  LIGHT: 0.6,        // base light energy per producer cell per tick
  LITTER: 0.25,      // share of plant production shed as litter (most NPP becomes detritus, not grazing)
  PCHUNK: 4,         // light competition is resolved in 4x4 patches
  PCAP: 4,           // producer cells per patch at which light is fully shaded
  CHILD_FRAC: 0.6,   // fraction of build investment that reaches the child (rest is lost: Lindeman)
  MAXE: 4,           // max stored energy = MAXE * n * CB
  LIFE0: 800,        // base lifespan (ticks), scaled by n^0.25 (metabolic theory)
  MATURE: 25,
  N_FROM_MEAT: 0.1,  // nutrients a body absorbs per unit of meat eaten (lets plants in poor soil profit from carnivory)
  NSTORE_MAX: 2.5,
  NSTORE_DECAY: 0.999,
  SELF_SHADE: 0.4,   // how much a plant's own producer cells shade each other
  OVERGRAZE: 25,     // energy grazed from a plant (decaying) beyond which grazing can kill it
  STRESS_DECAY: 0.995,
  ARMOR_DEFENSE: 0.7, // each armour cell on a plant halves, thirds... what a grazer gets per bite
  SEED_P: 0.5,       // chance a dying plant leaves a dormant seed in the soil
  SEED_LIFE: 8000,   // days a seed stays viable
  SEED_E: 6,         // energy a sprouting seed starts with
  DISEASE: 0.0015,   // extra death chance per day for a very crowded species...
  DISEASE_FREE: 0.02, // ...starting once it occupies 2% of tiles, full at 6%
  MIXO_COST: 0.2,    // a body with both producer cells and a mouth is 20% worse at each (Ward et al. 2011)
  RETALIATE: 0.3,    // chance per hit that a victim's killer cells strike back
  ANIMAL_BASE: 0,    // fixed metabolic cost of being an animal, on top of per-cell upkeep
  MOVE: 0.012,       // energy per step per unit body mass
  GRAZE: 0.9,        // energy drained per tick by a mouth grazing a producer cell
  GRAZE_FLOOR: 1,    // grazing can't take a plant below this (rootstock survives)
  BITE: 4,           // max food eaten from a pellet per mouth per tick
  HP: 2,             // hit points per cell
  INTERF: 2.0,       // predator interference (Beddington–DeAngelis style)
  SATIATE: 0.6,      // predators stop attacking above this fraction of max energy
  DECAY_PLANT: 0.002,
  DECAY_MEAT: 0.005,
  FERT_GAIN: 0.04,   // fraction of decayed matter returned as soil fertility
  FERT_DECAY: 0.9985,
  COLD: 0.05,        // extra upkeep per cell per unit of cold
  MAX_CELLS: 16,
  EYE_RANGE: 11,
  GUD: 3,            // keep eating (stop moving) only while intake beats 3x upkeep
  PLANT_READY: 0.08, // grazers arrive once plants cover this share of tiles
  PREY_READY: 0.02,  // predators arrive once grazers reach this share of tiles
  DEAD_READY: 0.25,  // scavengers arrive once dead matter averages this much energy per tile
  STAGE_MIN: 400,
  STAGE_DEADLINE: 2500,
  KILL_EAT: 0.8,     // share of a kill the killer can eat at once; the rest is carrion   // predators/scavengers arrive after prey establish (as Huffaker did)
  SPECIES_THRESH: 4.5,
  YEAR: 2000,        // ticks per year (one seasonal cycle)
};

const BIOMES = [
  { key: 'grass',  name: 'Grassland', light: 1.0,  upkeep: 1.0,  vis: 1.0,  move: 1.0, cold: 0, cover: 0, soil: 1.0,
    blurb: 'Plenty of light, open ground. The baseline.' },
  { key: 'forest', name: 'Forest',    light: 1.15, upkeep: 1.0,  vis: 0.45, move: 1.7, cold: 0, cover: 0.5, soil: 1.3,
    blurb: 'Rich light but dense: eyes see less and moving is costly. A refuge for prey.' },
  { key: 'desert', name: 'Desert',    light: 0.5,  upkeep: 1.25, vis: 1.3,  move: 1.0, cold: 0, cover: 0, soil: 0.6,
    blurb: 'Scarce light and heat stress. Rewards efficient, small bodies.' },
  { key: 'tundra', name: 'Tundra',    light: 0.6,  upkeep: 1.0,  vis: 1.0,  move: 1.2, cold: 1.0, cover: 0.15, soil: 0.5,
    blurb: 'Cold drains energy per cell. Armour doubles as insulation.' },
  { key: 'bog',    name: 'Bog',       light: 1.25, upkeep: 1.0,  vis: 0.8,  move: 1.5, cold: 0, cover: 0.25, soil: 0.06,
    blurb: 'Bright and waterlogged but starved of nutrients. Plants barely grow unless they find another source.' },
];
const WALL = 255;

const SIZES = { small: [120, 76], medium: [160, 100], large: [220, 136], huge: [320, 200] };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const NX = [1, 0, -1, 0, 1, 1, -1, -1], NY = [0, 1, 0, -1, 1, -1, 1, -1];

function rotX(x, y, r) { return r === 0 ? x : r === 1 ? -y : r === 2 ? -x : y; }
function rotY(x, y, r) { return r === 0 ? y : r === 1 ? x : r === 2 ? -y : -x; }

// ---------- genome helpers ----------
function cloneGenome(g) {
  return { cells: g.cells.map(c => ({ x: c.x, y: c.y, t: c.t, d: c.d })), diet: g.diet,
           react: g.react.slice(), mut: g.mut, repro: g.repro };
}
function countTypes(g) {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const cell of g.cells) c[cell.t]++;
  return c;
}
function classify(cnt, diet) {
  const hasP = cnt[T.PROD] > 0, hasM = cnt[T.MOUTH] > 0, hasK = cnt[T.KILLER] > 0;
  if (hasP && (!hasM || cnt[T.PROD] > cnt[T.MOUTH] * 2)) return ROLE.PLANT;
  if (hasM && hasK && diet >= 0.6) return ROLE.PREDATOR;
  if (hasM && diet < 0.33) return ROLE.GRAZER;
  if (hasM && diet < 0.72) return ROLE.SCAVENGER;
  return ROLE.OTHER;
}
// Diet is one continuous gene: 0 = eats living plants, 0.5 = eats dead matter, 1 = eats what it kills.
// Being good at one end costs efficiency at the other (a specialist/generalist trade-off).
function dietEff(d, m = 1) {
  const live = Math.max(0.03, 0.75 * (1 - 1.3 * Math.pow(d, 1.5))); // flat near 0: a little omnivory costs little
  const dead = Math.max(0.03, 0.85 * (1 - 3 * Math.abs(d - 0.5)));
  const meat = Math.max(0.03, 0.9 * (d - 0.15) / 0.85); // rises early, so omnivores get something from a kill
  return { effLive: live * m, effMeat: meat * m, effDetritus: Math.max(dead, 0.1 * live) * m, effCarrion: Math.max(dead, 0.6 * meat) * m };
}
function connected(cells) {
  if (cells.length <= 1) return true;
  const key = (x, y) => x * 1000 + y;
  const set = new Set(cells.map(c => key(c.x, c.y)));
  const seen = new Set([key(cells[0].x, cells[0].y)]);
  const st = [cells[0]];
  while (st.length) {
    const c = st.pop();
    for (let d = 0; d < 4; d++) {
      const k = key(c.x + DX[d], c.y + DY[d]);
      if (set.has(k) && !seen.has(k)) { seen.add(k); st.push({ x: c.x + DX[d], y: c.y + DY[d] }); }
    }
  }
  return seen.size === cells.length;
}
function genomeDistance(a, b) {
  const ca = countTypes(a), cb = countTypes(b);
  let d = 0;
  for (let t = 1; t < 7; t++) d += Math.abs(ca[t] - cb[t]);
  const m = new Map();
  for (const c of a.cells) m.set(c.x * 1000 + c.y, c.t);
  let mis = 0;
  for (const c of b.cells) { const t = m.get(c.x * 1000 + c.y); if (t !== c.t) mis++; m.delete(c.x * 1000 + c.y); }
  mis += m.size;
  d += 0.3 * mis;
  d += 2.5 * Math.abs(a.diet - b.diet) + 1.5 * Math.abs(a.repro - b.repro);
  for (let i = 0; i < 4; i++) d += 0.35 * Math.abs(a.react[i] - b.react[i]);
  return d;
}

// ---------- naming ----------
const SYL = ['ve', 'lo', 'ra', 'thi', 'mo', 'ka', 'zu', 'phy', 'dra', 'ne', 'xo', 'qui', 'bo', 'sa', 'ly',
  'gor', 'ten', 'mi', 'cor', 'pha', 'sil', 'tar', 'ul', 'ven', 'ar', 'cli', 'do', 'em', 'fi', 'ga'];
const GEN_END = ['ia', 'us', 'on', 'ax', 'ella', 'ops', 'ix', 'ara', 'odon', 'ites'];
function makeGenus(rng) {
  let s = SYL[Math.floor(rng() * SYL.length)] + SYL[Math.floor(rng() * SYL.length)];
  if (rng() < 0.4) s += SYL[Math.floor(rng() * SYL.length)];
  s += GEN_END[Math.floor(rng() * GEN_END.length)];
  return s[0].toUpperCase() + s.slice(1);
}
// Smooth value noise on a seeded lattice (returns 0..1).
function makeNoise(rng) {
  const P = 256, perm = new Uint16Array(P * 2), val = new Float32Array(P);
  for (let i = 0; i < P; i++) { perm[i] = i; val[i] = rng(); }
  for (let i = P - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < P; i++) perm[i + P] = perm[i];
  const h = (x, y) => val[perm[(perm[x & 255] + y) & 511] & 255];
  const sm = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = sm(x - xi), fy = sm(y - yi);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function makeEpithet(rng, cnt, n, role) {
  const opts = [];
  if (role === 0 && cnt[T.KILLER] && cnt[T.MOUTH]) return pick(rng, ['carnivorus', 'muscipula', 'insectivora', 'dentata']);
  if (cnt[T.KILLER] >= 2) opts.push('spinosus', 'ferox');
  if (cnt[T.ARMOR] >= 2) opts.push('loricatus', 'scutatus');
  if (cnt[T.EYE] >= 2) opts.push('oculatus', 'argus');
  if (cnt[T.MOVER] >= 2) opts.push('velox', 'cursor');
  if (n >= 8) opts.push('magnus', 'gigas');
  if (n === 1) opts.push('minimus', 'simplex');
  if (!opts.length) {
    opts.push(...[['viridis', 'solaris', 'frondosus'], ['pascens', 'herbivorus', 'mitis'],
      ['rapax', 'venator', 'lupinus'], ['necrophagus', 'vorax', 'lugubris'], ['mirabilis', 'ambiguus', 'novus']][role]);
  }
  return pick(rng, opts);
}
function makeCommonName(rng, cnt, n, role) {
  if (role === ROLE.PLANT && cnt[T.ARMOR] && !cnt[T.MOUTH]) return pick(rng, ['Thorny', 'Woody', 'Barbed', 'Tough']) + ' ' + pick(rng, ['bramble', 'thornbush', 'briar', 'cactus', 'holly']);
  if (role === ROLE.PLANT && cnt[T.KILLER] && cnt[T.MOUTH]) return pick(rng, ['Toothed', 'Biting', 'Sticky', 'Hungry', 'Snapping']) + ' ' + pick(rng, ['flytrap', 'sundew', 'snare', 'pitcher', 'bladderwort']);
  const nouns = [['moss', 'fern', 'reed', 'bloom', 'lichen'], ['grazer', 'drifter', 'nibbler', 'browser'],
    ['stalker', 'hunter', 'fang', 'prowler'], ['picker', 'gleaner', 'crawler', 'sweeper'], ['oddity', 'wanderer', 'chimera']][role];
  const adj = [];
  if (cnt[T.ARMOR] >= 2) adj.push('Armoured', 'Shelled');
  if (cnt[T.KILLER] >= 2) adj.push('Spiny', 'Thorned');
  if (cnt[T.EYE] >= 2) adj.push('Many-eyed', 'Watchful');
  if (cnt[T.MOVER] >= 2) adj.push('Swift', 'Darting');
  if (n >= 8) adj.push('Giant', 'Great');
  if (n <= 2) adj.push('Tiny', 'Lesser');
  if (!adj.length) adj.push('Common', 'Plain', 'Dusky', 'Pale', 'Ruddy', 'Speckled');
  const a = pick(rng, adj), b = pick(rng, nouns);
  return a + ' ' + b;
}

// ---------- seed designs ----------
function seedGenome(kind) {
  const C = (x, y, t, d = 0) => ({ x, y, t, d });
  switch (kind) {
    case 'plant': return { cells: [C(0, 0, T.PROD)], diet: 0.0, react: [0, 0, 0, 0], mut: 0.12, repro: 0.1 };
    case 'grazer': return { cells: [C(0, 0, T.MOUTH), C(1, 0, T.MOVER), C(-1, 0, T.EYE, 2)],
      diet: 0.1, react: [0.8, 0.9, -1, 0], mut: 0.12, repro: 0.3 };
    case 'predator': return { cells: [C(0, 0, T.MOUTH), C(-1, 0, T.KILLER), C(1, 0, T.MOVER), C(0, -1, T.EYE, 2)],
      diet: 0.9, react: [0.5, 0, -0.2, 1], mut: 0.12, repro: 0.3 };
    case 'scavenger': return { cells: [C(0, 0, T.MOUTH), C(1, 0, T.MOVER), C(-1, 0, T.EYE, 2)],
      diet: 0.5, react: [1, -0.1, -1, -0.2], mut: 0.12, repro: 0.12 };
  }
}

// =====================================================================
class World {
  constructor(cfg) {
    this.cfg = Object.assign({
      seed: 12345, size: 'medium', biomes: [3, 2, 1, 1, 1], plants: 300, grazers: 60, predators: 12,
      scavengers: 15, sunlight: 1.0, mutation: 1.0, seasons: true, randomEvents: true, barriers: false, staged: true,
    }, cfg || {});
    let [W, H] = SIZES[this.cfg.size] || SIZES.medium;
    if (this.cfg.width && this.cfg.height) { W = Math.max(40, Math.min(800, this.cfg.width | 0)); H = Math.max(30, Math.min(500, this.cfg.height | 0)); }
    this.W = W; this.H = H;
    this.rng = mulberry32(this.cfg.seed >>> 0);
    const N = W * H;
    this.occ = new Int32Array(N);      // slot+1 of occupying organism
    this.cellT = new Uint8Array(N);    // cell type on tile
    this.food = new Float32Array(N);
    this.foodK = new Uint8Array(N);    // 1 plant matter, 2 meat
    this.fert = new Float32Array(N);
    this.terrain = new Uint8Array(N);
    this.seeds = new Array(N).fill(null); // dormant seed bank: { g, sp, gen, t }
    this.seedCount = 0;
    this.orgs = [];
    this.free = [];
    this.nextId = 1;
    this.tick = 0;
    this.species = [];
    this.speciesById = new Map();
    this.events = [];       // active events
    this.eventLog = [];
    this.innovations = [];
    this.history = [];
    this.roleExtinct = [null, null, null, null, null];
    this.roleSeen = [false, false, false, false, false];
    this.maxGen = 0;
    this.peakPop = 0;
    this.biggest = null;
    this.ended = null;
    this.noConsumerSince = -1;
    this.totalBirths = 0;
    this.deaths = { starvation: 0, predation: 0, grazed: 0, age: 0, cold: 0, disease: 0, catastrophe: 0 };
    this.chunk = 8;
    this.cw = Math.ceil(W / this.chunk); this.ch = Math.ceil(H / this.chunk);
    this.predDens = new Uint16Array(this.cw * this.ch);
    this.pw = Math.ceil(W / K.PCHUNK); this.ph = Math.ceil(H / K.PCHUNK);
    this.prodDens = new Uint16Array(this.pw * this.ph);
    this.heightDens = new Float32Array(this.pw * this.ph);
    this.buildTerrain();
    this.populate();
    this.sample();
  }

  // ---------------- terrain ----------------
  // Procedural map. Noise gives each tile an elevation, a temperature (cold toward the poles and up high)
  // and a moisture level. Biomes then claim tiles in a fixed order, each taking exactly its share of the
  // map from the tiles that suit it best: the coldest become tundra, hot dry ground desert, wet lowland bog,
  // other wet ground forest, and the rest grassland. So the sliders set the proportions and the seed sets
  // the geography.
  buildTerrain() {
    const { W, H } = this, N = W * H, rng = this.rng;
    const NB = BIOMES.length;
    const w = BIOMES.map((_, i) => Math.max(0, this.cfg.biomes[i] || 0));
    const tot = w.reduce((a, b) => a + b, 0) || 1;
    const noise = makeNoise(rng);
    const fbm = (x, y, f, oct) => { let v = 0, a = 1, n = 0; for (let o = 0; o < oct; o++) { v += a * noise(x * f, y * f); n += a; a *= 0.5; f *= 2; } return v / n; };
    const ox = rng() * 1000, oy = rng() * 1000, eqShift = (rng() - 0.5) * 0.3;
    const elev = new Float32Array(N), temp = new Float32Array(N), moist = new Float32Array(N), jit = new Float32Array(N);
    const sc = 1 / Math.max(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // domain warp makes coastlines and borders organic instead of blobby
      const wx = x + 14 * (fbm(x + ox + 50, y + oy, 3 * sc, 2) - 0.5) * 2;
      const wy = y + 14 * (fbm(x + ox, y + oy + 50, 3 * sc, 2) - 0.5) * 2;
      elev[i] = fbm(wx + ox, wy + oy, 4 * sc, 4);
      moist[i] = fbm(wx + ox + 300, wy + oy + 300, 5 * sc, 4);
      const lat = Math.min(1, Math.abs(y / (H - 1) - 0.5 - eqShift) * 2);
      temp[i] = 1 - 0.75 * lat - 0.45 * Math.max(0, elev[i] - 0.45) + 0.35 * (fbm(wx + ox + 600, wy + oy + 600, 6 * sc, 3) - 0.5);
      jit[i] = rng() * 0.02;
    }
    const score = [
      i => 0,                                             // grassland takes what is left
      i => moist[i] * 1.0 + elev[i] * 0.25,               // forest: wet ground
      i => temp[i] * 0.8 - moist[i] * 1.1,                // desert: hot and dry
      i => -temp[i],                                      // tundra: the coldest ground
      i => moist[i] * 1.2 - elev[i] * 1.0,                // bog: wet lowland
    ];
    const order = [3, 2, 4, 1];
    const terrain = this.terrain;
    terrain.fill(255);
    const fallback = w.findIndex(v => v > 0);
    for (const b of order) {
      const want = Math.round(N * w[b] / tot);
      if (!want) continue;
      const free = [];
      for (let i = 0; i < N; i++) if (terrain[i] === 255) free.push(i);
      const f = score[b];
      free.sort((p, q) => (f(q) + jit[q]) - (f(p) + jit[p]));
      for (let k = 0; k < want && k < free.length; k++) terrain[free[k]] = b;
    }
    for (let i = 0; i < N; i++) if (terrain[i] === 255) terrain[i] = w[0] > 0 ? 0 : fallback;
    // two passes of a majority filter remove speckle while keeping the shapes
    const tmp = new Uint8Array(N), cnt = new Uint8Array(NB);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        cnt.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
          cnt[terrain[yy * W + xx]]++;
        }
        let best = terrain[y * W + x];
        for (let b = 0; b < NB; b++) if (cnt[b] > cnt[best] && cnt[b] >= 5) best = b;
        tmp[y * W + x] = best;
      }
      terrain.set(tmp);
    }
    // mountain ranges follow ridges in the elevation field, broken by passes
    if (this.cfg.barriers) {
      const px = rng() * 1000;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const r = 1 - Math.abs(2 * fbm(x + px, y + px, 5 * sc, 3) - 1);
        const pass = fbm(x + px + 77, y + px + 77, 9 * sc, 2) < 0.33;
        if (r > 0.972 && !pass) terrain[i] = WALL;
      }
    }
    // relief shading for the map (bright highs, dark lows)
    this.shade = new Uint8Array(N);
    for (let i = 0; i < N; i++) this.shade[i] = Math.max(0, Math.min(255, Math.round(150 + (elev[i] - 0.5) * 260)));
  }
  biomeAt(idx) { const t = this.terrain[idx]; return t === WALL ? null : BIOMES[t]; }

  // ---------------- populate ----------------
  // Ecological succession: producers establish first, then grazers; scavengers arrive once there is
  // dead matter to eat and predators once there is prey. (Huffaker 1958 likewise had to establish
  // prey before adding predators to get any persistence.)
  populate() {
    const c = this.cfg;
    this.release([['plant', c.plants]]);
    this.pending = [];
    if (!c.staged) { this.release([['grazer', c.grazers], ['predator', c.predators], ['scavenger', c.scavengers]]); return; }
    if (c.grazers > 0) this.pending.push({ kind: 'grazer', num: c.grazers, label: 'Grazers arrive', after: null,
      ready: w => w.last.roles[ROLE.PLANT] >= w.W * w.H * K.PLANT_READY });
    if (c.scavengers > 0) this.pending.push({ kind: 'scavenger', num: c.scavengers, label: 'Scavengers arrive', after: 'grazer',
      ready: w => w.deadMatter >= w.W * w.H * K.DEAD_READY });
    if (c.predators > 0) this.pending.push({ kind: 'predator', num: c.predators, label: 'Predators arrive', after: 'grazer',
      ready: w => w.last.roles[ROLE.GRAZER] >= w.W * w.H * K.PREY_READY });
  }
  get stage() { return this.pending && this.pending.length ? 0 : 2; }
  advanceSuccession() {
    if (!this.pending.length || this.tick % 20 !== 0 || !this.last) return;
    const done = this.arrived || (this.arrived = {});
    for (const p of this.pending.slice()) {
      if (p.after && done[p.after] == null) continue;
      const since = this.tick - (p.after ? done[p.after] : 0);
      const minWait = p.after ? K.STAGE_MIN : 0;
      if (since >= minWait && (p.ready(this) || since >= K.STAGE_DEADLINE)) {
        this.release([[p.kind, p.num]]);
        done[p.kind] = this.tick;
        this.pending.splice(this.pending.indexOf(p), 1);
        this.eventLog.push({ tick: this.tick, type: 'arrival', name: p.label });
      }
    }
  }
  release(kinds) {
    for (const [kind, num] of kinds) {
      if (num <= 0) continue;
      const g = seedGenome(kind);
      g.mut *= this.cfg.mutation;
      const sp = this.newSpecies(g, null, null);
      let placed = 0, tries = 0;
      while (placed < num && tries < num * 40) {
        tries++;
        const x = 2 + Math.floor(this.rng() * (this.W - 4)), y = 2 + Math.floor(this.rng() * (this.H - 4));
        const rot = Math.floor(this.rng() * 4);
        const gg = cloneGenome(g);
        if (this.canPlace(gg.cells, x, y, rot, -1, true)) {
          const e = gg.cells.length * K.CB * (kind === 'plant' ? 1.0 : 3.0);
          const o = this.spawn(gg, x, y, rot, e, sp, 0);
          o.age = Math.floor(this.rng() * 80);
          placed++;
        }
      }
    }
  }

  // ---------------- species ----------------
  newSpecies(g, parent, parentOrg) {
    const cnt = countTypes(g);
    const n = g.cells.length;
    const role = classify(cnt, g.diet);
    let genus;
    if (parent && parent.role === role && this.rng() < 0.75) genus = parent.genus;
    else genus = makeGenus(this.rng);
    let epithet = makeEpithet(this.rng, cnt, n, role);
    let name = genus + ' ' + epithet;
    let k = 2;
    const used = this._names || (this._names = new Set());
    while (used.has(name)) { name = genus + ' ' + epithet + ' ' + ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][Math.min(k - 2, 8)] + (k > 10 ? k : ''); k++; }
    used.add(name);
    const sp = {
      id: this.species.length + 1, name, genus, common: makeCommonName(this.rng, cnt, n, role),
      parent: parent ? parent.id : null, born: this.tick, died: null, rep: cloneGenome(g), role,
      alive: 0, peak: 0, births: 0, abundance: 0, maxCells: n, hue: Math.floor(this.rng() * 360),
      cnt, depth: parent ? parent.depth + 1 : 0,
    };
    this.species.push(sp);
    this.speciesById.set(sp.id, sp);
    if (parent) {
      const gained = [];
      for (let t = 1; t < 7; t++) if (cnt[t] > 0 && parent.cnt[t] === 0) gained.push(TYPE_NAMES[t]);
      const roleShift = parent.role !== role;
      if (gained.length || roleShift) {
        this.innovations.push({ tick: this.tick, species: sp.id, parent: parent.id, gained,
          roleFrom: parent.role, roleTo: role });
      }
    }
    return sp;
  }

  // ---------------- organisms ----------------
  canPlace(cells, x, y, rot, selfSlot, spacing) {
    const { W, H, occ, terrain } = this;
    for (const c of cells) {
      const ax = x + rotX(c.x, c.y, rot), ay = y + rotY(c.x, c.y, rot);
      if (ax < 0 || ay < 0 || ax >= W || ay >= H) return false;
      const i = ay * W + ax;
      if (terrain[i] === WALL) return false;
      const o = occ[i];
      if (o !== 0 && o !== selfSlot + 1) return false;
      if (spacing) {
        for (let d = 0; d < 4; d++) {
          const nx = ax + DX[d], ny = ay + DY[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const oo = occ[ny * W + nx];
          if (oo !== 0 && oo !== selfSlot + 1) return false;
        }
      }
    }
    return true;
  }

  spawn(g, x, y, rot, energy, sp, gen) {
    let slot;
    if (this.free.length) slot = this.free.pop(); else { slot = this.orgs.length; this.orgs.push(null); }
    const cnt = countTypes(g);
    const n = g.cells.length;
    let w = 0; for (const c of g.cells) w += UPKEEP[c.t];
    const mass = n + cnt[T.ARMOR];
    const o = {
      slot, id: this.nextId++, x, y, rot, g, n, cnt, E: energy, age: 0,
      life: Math.round(K.LIFE0 * Math.pow(n, 0.25) * (0.8 + this.rng() * 0.4)),
      hp: n * K.HP, sp: sp.id, gen, heading: Math.floor(this.rng() * 4), cool: 0,
      role: classify(cnt, g.diet), maxE: K.MAXE * n * K.CB,
      upk: w * Math.pow(n, -0.25),                         // Kleiber: total ∝ n^0.75
      speed: cnt[T.MOVER] ? Math.min(1, 1.4 * cnt[T.MOVER] / Math.sqrt(mass)) : 0, // bigger bodies are slower, but less than in proportion (Hirt et al. 2017)
      mass, ...dietEff(g.diet, cnt[T.PROD] && cnt[T.MOUTH] ? 1 - K.MIXO_COST : 1),
      insul: Math.min(1, 2 * cnt[T.ARMOR] / n), alive: true, born: this.tick,
      height: Math.max(1, cnt[T.PROD] + 0.5 * cnt[T.ARMOR]), // leaves give height; woody armour helps a little
      reserve: 0.2 + 2.2 * g.repro, ate: 0, kills: 0, nstore: 0, stress: 0,                       // evolvable: breed early (r) vs build reserves (K)
    };
    this.orgs[slot] = o;
    this.stamp(o);
    sp.alive++; sp.births++;
    if (sp.alive > sp.peak) sp.peak = sp.alive;
    this.totalBirths++;
    if (gen > this.maxGen) this.maxGen = gen;
    if (!this.biggest || n > this.biggest.n) this.biggest = { n, sp: sp.id, tick: this.tick, g: cloneGenome(g) };
    if (n > sp.maxCells) sp.maxCells = n;
    this.roleSeen[o.role] = true;
    return o;
  }

  stamp(o) {
    const { W } = this;
    for (const c of o.g.cells) {
      const i = (o.y + rotY(c.x, c.y, o.rot)) * W + (o.x + rotX(c.x, c.y, o.rot));
      this.occ[i] = o.slot + 1; this.cellT[i] = c.t;
    }
  }
  unstamp(o) {
    const { W } = this;
    for (const c of o.g.cells) {
      const i = (o.y + rotY(c.x, c.y, o.rot)) * W + (o.x + rotX(c.x, c.y, o.rot));
      this.occ[i] = 0; this.cellT[i] = 0;
    }
  }

  kill(o, cause, killer) {
    if (!o.alive) return;
    o.alive = false;
    this.unstamp(o);
    let pool = Math.max(0, o.E) + o.n * K.CB * 0.5;
    // A predator with a mouth eats part of its kill on the spot; leftovers become carrion.
    if (killer && killer.alive && killer.cnt[T.MOUTH]) {
      const eff = o.role === ROLE.PLANT ? killer.effLive : killer.effMeat;
      const room = Math.max(0, (killer.maxE - killer.E) / eff);
      const eat = Math.min(pool * K.KILL_EAT, room);
      killer.E += eat * eff; killer.ate += eat * eff; pool -= eat;
      if (o.role !== ROLE.PLANT) killer.nstore = Math.min(K.NSTORE_MAX, killer.nstore + eat * K.N_FROM_MEAT);
      killer.kills = (killer.kills || 0) + 1;
    }
    const per = pool / o.n;
    const kind = o.role === ROLE.PLANT ? 1 : 2;
    const { W } = this;
    for (const c of o.g.cells) {
      const i = (o.y + rotY(c.x, c.y, o.rot)) * W + (o.x + rotX(c.x, c.y, o.rot));
      this.food[i] += per; this.foodK[i] = kind;
    }
    this.deaths[cause] = (this.deaths[cause] || 0) + 1;
    if (o.role === ROLE.PLANT && this.rng() < K.SEED_P) {
      const si = o.y * this.W + o.x;
      if (!this.seeds[si]) this.seedCount++;
      this.seeds[si] = { g: o.g, sp: o.sp, gen: o.gen, t: this.tick };
    }
    const sp = this.speciesById.get(o.sp);
    sp.alive--;
    if (sp.alive === 0) sp.died = this.tick;
    this.orgs[o.slot] = null;
    this.free.push(o.slot);
  }

  // ---------------- mutation ----------------
  mutate(g) {
    const rng = this.rng;
    const ng = cloneGenome(g);
    let structural = false;
    if (rng() < ng.mut) {
      structural = true;
      const r = rng();
      const cells = ng.cells;
      if (r < 0.28) { // change a cell's type
        const c = cells[Math.floor(rng() * cells.length)];
        c.t = 1 + Math.floor(rng() * 6); c.d = Math.floor(rng() * 4);
      } else if (r < 0.55 || r >= 0.9) { // insertion (new random cell) or duplication (copy an existing cell)
        if (cells.length < K.MAX_CELLS) {
          const base = cells[Math.floor(rng() * cells.length)];
          const d = Math.floor(rng() * 4);
          const nx = base.x + DX[d], ny = base.y + DY[d];
          if (!cells.some(c => c.x === nx && c.y === ny)) {
            if (r >= 0.9) { const src = cells[Math.floor(rng() * cells.length)]; cells.push({ x: nx, y: ny, t: src.t, d: src.d }); }
            else cells.push({ x: nx, y: ny, t: 1 + Math.floor(rng() * 6), d: Math.floor(rng() * 4) });
          }
        }
      } else if (r < 0.72) { // deletion
        if (cells.length > 1) {
          const k = 1 + Math.floor(rng() * (cells.length - 1)); // never the origin cell (index 0)
          const removed = cells.splice(k, 1)[0];
          if (!connected(cells)) cells.splice(k, 0, removed);
        }
      } else { // re-aim an eye / reorient a part
        const eyes = cells.filter(c => c.t === T.EYE);
        if (eyes.length) eyes[Math.floor(rng() * eyes.length)].d = Math.floor(rng() * 4);
      }
    }
    // small continuous drift
    if (rng() < 0.3) ng.diet = Math.min(1, Math.max(0, ng.diet + (rng() - 0.5) * 0.12));
    for (let i = 0; i < 4; i++) if (rng() < 0.15) ng.react[i] = Math.max(-1, Math.min(1, ng.react[i] + (rng() - 0.5) * 0.4));
    if (rng() < 0.2) ng.repro = Math.max(0, Math.min(1, ng.repro + (rng() - 0.5) * 0.15));
    if (rng() < 0.1) ng.mut = Math.max(0.01, Math.min(0.5, ng.mut * Math.exp((rng() - 0.5) * 0.4)));
    return { g: ng, structural };
  }

  reproduce(o) {
    const sp = this.speciesById.get(o.sp);
    const { g, structural } = this.mutate(o.g);
    const n2 = g.cells.length;
    const cost = n2 * K.CB;
    if (o.E < cost * (1 + o.reserve)) return;
    const mobile = o.cnt[T.MOVER] > 0;
    const rad = Math.ceil(Math.sqrt(o.n)) + 1;
    for (let tries = 0; tries < 8; tries++) {
      const dist = rad + 1 + Math.floor(this.rng() * (mobile ? 3 : 7));
      const ang = this.rng() * Math.PI * 2;
      const x = Math.round(o.x + Math.cos(ang) * dist), y = Math.round(o.y + Math.sin(ang) * dist);
      const rot = Math.floor(this.rng() * 4);
      if (this.canPlace(g.cells, x, y, rot, -1, !mobile)) {
        o.E -= cost;
        let csp = sp;
        if (structural || this.rng() < 0.3) {
          const dist = genomeDistance(sp.rep, g);
          // a lineage that has changed its way of life counts as a new species sooner
          const cn = countTypes(g), r1 = classify(cn, g.diet - 0.08), r2 = classify(cn, g.diet + 0.08);
          const shifted = r1 === r2 && r1 !== sp.role; // clearly, not borderline, in a new role
          if (dist > K.SPECIES_THRESH || (shifted && dist > K.SPECIES_THRESH * 0.7)) csp = this.newSpecies(g, sp, o);
        }
        this.spawn(g, x, y, rot, cost * K.CHILD_FRAC, csp, o.gen + 1);
        o.cool = 8;
        return;
      }
    }
    o.cool = 12;
    o.E -= cost * 0.05;
  }

  // ---------------- environment ----------------
  globalLight() {
    let l = this.cfg.sunlight;
    if (this.cfg.seasons) l *= 1 + 0.3 * Math.sin((this.tick / K.YEAR) * Math.PI * 2);
    for (const e of this.events) if (e.light) l *= e.light;
    return l;
  }
  globalCold() {
    let c = 0;
    for (const e of this.events) if (e.cold) c += e.cold;
    if (this.cfg.seasons) c += Math.max(0, -Math.sin((this.tick / K.YEAR) * Math.PI * 2)) * 0.25;
    return c;
  }
  triggerEvent(type, x, y) {
    const t = this.tick;
    const E = {
      drought: { type, name: 'Drought', light: 0.5, until: t + 1500 },
      iceage: { type, name: 'Ice age', cold: 1.0, light: 0.85, until: t + 2500 },
      bloom: { type, name: 'Nutrient bloom', light: 1.7, until: t + 900 },
      meteor: { type, name: 'Meteor strike', until: t },
      plague: { type, name: 'Plague', until: t },
    }[type];
    if (!E) return;
    this.eventLog.push({ tick: t, type, name: E.name });
    if (type === 'meteor') {
      const cx = x != null ? x : Math.floor(this.rng() * this.W), cy = y != null ? y : Math.floor(this.rng() * this.H);
      const r = Math.round(Math.min(this.W, this.H) * 0.14);
      for (const o of this.orgs) {
        if (!o) continue;
        if ((o.x - cx) ** 2 + (o.y - cy) ** 2 <= r * r) { this.kill(o, 'catastrophe'); }
      }
      for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= this.W || yy >= this.H) continue;
        if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) { const i = yy * this.W + xx; this.food[i] = 0; this.fert[i] += 3; }
      }
      this.lastMeteor = { x: cx, y: cy, r, tick: t };
      return;
    }
    if (type === 'plague') {
      // strikes the most abundant species hardest (density-dependent disease)
      let top = null; for (const s of this.species) if (s.alive > 0 && (!top || s.alive > top.alive)) top = s;
      if (!top) return;
      this.eventLog[this.eventLog.length - 1].name = 'Plague hits ' + top.name;
      for (const o of this.orgs) if (o && o.sp === top.id && this.rng() < 0.6) this.kill(o, 'catastrophe');
      return;
    }
    this.events.push(E);
  }

  // ---------------- main step ----------------
  step() {
    if (this.ended) return;
    this.tick++;
    const { W, H, occ, cellT, food, foodK, fert, terrain, rng } = this;
    const L = this.globalLight() * K.LIGHT;
    const gCold = this.globalCold();
    this.events = this.events.filter(e => e.until > this.tick);
    this.advanceSuccession();
    if (this.cfg.randomEvents && rng() < 1 / 7000) {
      this.triggerEvent(pick(rng, ['drought', 'iceage', 'bloom', 'meteor', 'plague']));
    }

    // predator density map (for interference)
    const pd = this.predDens; pd.fill(0);
    const cs = this.chunk, cw = this.cw;
    for (const o of this.orgs) if (o && o.cnt[T.KILLER]) pd[((o.y / cs) | 0) * cw + ((o.x / cs) | 0)]++;
    const PD = this.prodDens; PD.fill(0);
    const HD = this.heightDens; HD.fill(0);
    const PC = K.PCHUNK, pw = this.pw;
    for (const o of this.orgs) {
      if (!o || !o.cnt[T.PROD]) continue;
      for (const c of o.g.cells) if (c.t === T.PROD) {
        const ax = o.x + rotX(c.x, c.y, o.rot), ay = o.y + rotY(c.x, c.y, o.rot);
        const p = ((ay / PC) | 0) * pw + ((ax / PC) | 0);
        PD[p]++; HD[p] += o.height;
      }
    }

    const orgs = this.orgs;
    const len = orgs.length;
    const start = Math.floor(rng() * Math.max(1, len));
    for (let k = 0; k < len; k++) {
      const o = orgs[(start + k) % len];
      if (!o || !o.alive) continue;
      o.age++;
      if (o.nstore > 0.001) o.nstore *= K.NSTORE_DECAY;
      if (o.stress > 0.01) o.stress *= K.STRESS_DECAY;
      const ai = o.y * W + o.x;
      const bi = terrain[ai] === WALL ? 0 : terrain[ai];
      const B = BIOMES[bi];
      // metabolism
      const cold = (B.cold + gCold) * (1 - o.insul);
      o.E -= (o.upk + (o.cnt[T.MOUTH] ? K.ANIMAL_BASE : 0)) * B.upkeep + K.COLD * cold * o.n; // animals run hotter than plants
      const rot = o.rot;
      const cells = o.g.cells;
      const hungry = o.E < o.maxE;
      const canHunt = o.E < o.maxE * K.SATIATE;
      let fed = false;
      for (let ci = 0; ci < cells.length; ci++) {
        if (!o.alive) break;
        const c = cells[ci];
        const t = c.t;
        if (t === T.PROD) {
          const ax = o.x + rotX(c.x, c.y, rot), ay = o.y + rotY(c.x, c.y, rot);
          const ti = ay * W + ax;
          // Light competition: bigger (taller) bodies are shaded less by smaller neighbours and shade
          // them more; a body's own leaves shade it only a little.
          const p = ((ay / PC) | 0) * pw + ((ax / PC) | 0);
          let own = 0;
          for (const c2 of cells) if (c2.t === T.PROD && ((((o.y + rotY(c2.x, c2.y, rot)) / PC) | 0) * pw + (((o.x + rotX(c2.x, c2.y, rot)) / PC) | 0)) === p) own++;
          const others = PD[p] - own;
          const rel = others > 0 ? Math.min(2, Math.sqrt((HD[p] - own * o.height) / others / o.height)) : 0;
          const shade = (others * rel + own * K.SELF_SHADE) / K.PCAP;
          const tb = terrain[ti] === WALL ? B : BIOMES[terrain[ti]];
          const soil = tb.soil + fert[ti] * 0.1 + o.nstore;          // nutrients: biome soil + recycled matter + what it has eaten
          const nf = Math.min(1.6, 1.5 * soil / (soil + 0.5));            // = 1 on grassland soil
          const g = L * tb.light * Math.max(0, 1 - shade) * nf * (o.cnt[T.MOUTH] ? 1 - K.MIXO_COST : 1); // mixotrophs pay for running both systems
          // a share of production is shed as leaf litter: the base of the detrital food chain
          if (g > 0) { food[ti] += g * K.LITTER; if (foodK[ti] !== 2 || food[ti] < 1) foodK[ti] = 1; }
          if (hungry || g < 0) o.E += g * (1 - K.LITTER);
        } else if (t === T.MOUTH && hungry) {
          const ax = o.x + rotX(c.x, c.y, rot), ay = o.y + rotY(c.x, c.y, rot);
          // Look at the 9 tiles the mouth touches and take the most rewarding bite.
          let bestGain = 0, bestTi = -1, bestKind = 0;
          const d0 = Math.floor(rng() * 8);
          for (let s = -1; s < 8; s++) {
            let nx = ax, ny = ay;
            if (s >= 0) { const d = (d0 + s) & 7; nx += NX[d]; ny += NY[d]; }
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ti = ny * W + nx;
            const oc = occ[ti];
            if (food[ti] > 0 && (oc === 0 || (oc === o.slot + 1 ? cellT[ti] !== T.PROD : cellT[ti] === T.PROD))) { // litter under other plants, never your own
              const gain = Math.min(food[ti], K.BITE) * (foodK[ti] === 1 ? o.effDetritus : o.effCarrion);
              if (gain > bestGain) { bestGain = gain; bestTi = ti; bestKind = 1; }
            }
            if (o.speed > 0 && oc && oc !== o.slot + 1 && cellT[ti] === T.PROD) { // only mobile animals can graze; sessile ones live on what falls to them
              const tgt = orgs[oc - 1];
              if (tgt && tgt.alive && tgt.sp !== o.sp) {
                const gain = this.grazeAvail(tgt, o) * o.effLive;
                if (gain > bestGain) { bestGain = gain; bestTi = ti; bestKind = 2; }
              }
            }
          }
          if (bestGain > o.upk * K.GUD) fed = true; // giving-up rule: only linger while the patch pays (Charnov 1976)
          if (bestKind === 1) {
            const take = Math.min(food[bestTi], K.BITE);
            food[bestTi] -= take; if (food[bestTi] < 0.05) food[bestTi] = 0;
            o.E += bestGain; o.ate += bestGain;
            if (foodK[bestTi] === 2) o.nstore = Math.min(K.NSTORE_MAX, o.nstore + take * K.N_FROM_MEAT);
          } else if (bestKind === 2) {
            const tgt = orgs[occ[bestTi] - 1];
            // Light grazing crops stored energy but leaves the rootstock. Sustained heavy grazing
            // wears the plant down (stress) until even the rootstock is eaten and the plant dies.
            const drain = this.grazeAvail(tgt, o);
            tgt.E -= drain;
            tgt.stress += drain;
            o.E += drain * o.effLive; o.ate += drain * o.effLive;
            if (tgt.E <= 0.05 && tgt.stress > K.OVERGRAZE) this.kill(tgt, 'grazed', o); // overgrazed to death
          }
        } else if (t === T.KILLER && canHunt) {
          const ax = o.x + rotX(c.x, c.y, rot), ay = o.y + rotY(c.x, c.y, rot);
          const d0 = Math.floor(rng() * 8);
          for (let s = 0; s < 8; s++) {
            const d = (d0 + s) & 7;
            const nx = ax + NX[d], ny = ay + NY[d];
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ti = ny * W + nx;
            const oc = occ[ti];
            if (oc && oc !== o.slot + 1 && cellT[ti] !== T.ARMOR && cellT[ti] !== T.PROD) { // tough cellulose: killers can't hurt producer cells
              const tgt = orgs[oc - 1];
              if (!tgt || !tgt.alive || tgt.sp === o.sp) continue;
              const dens = pd[((o.y / cs) | 0) * cw + ((o.x / cs) | 0)];
              if (rng() < (1 - B.cover) / (1 + K.INTERF * Math.max(0, dens - 1))) { // interference + cover
                tgt.hp -= 1;
                o.E -= 0.05; // effort
                if (tgt.hp <= 0) this.kill(tgt, 'predation', o);
                else if (tgt.cnt[T.KILLER] && rng() < K.RETALIATE * Math.min(1, tgt.cnt[T.KILLER] / 2)) {
                  o.hp -= 1; // armed prey strike back: killer cells are useful for defence before they are useful for hunting
                  if (o.hp <= 0) this.kill(o, 'predation', tgt);
                }
              }
              break;
            }
          }
        }
      }
      if (!o.alive) continue;
      // movement
      if (o.speed > 0 && !fed && rng() < o.speed) this.think(o, B); // animals stop to eat
      // life & death
      if (o.E <= 0) { this.kill(o, cold > 0.5 && o.upk * B.upkeep < K.COLD * cold * o.n ? 'cold' : 'starvation'); continue; }
      if (o.age > o.life) { this.kill(o, 'age'); continue; }
      const spo = this.speciesById.get(o.sp);
      if (spo.disease > 0 && rng() < spo.disease) { this.kill(o, 'disease'); continue; }
      if (o.E > o.maxE) o.E = o.maxE;
      if (o.hp < o.n * K.HP && rng() < 0.02) o.hp++;
      if (o.cool > 0) o.cool--;
      else if (o.age > K.MATURE && o.E >= o.n * K.CB * (1 + o.reserve)) this.reproduce(o);
    }

    // food decay -> soil fertility (nutrient recycling)
    let dead = 0;
    for (let i = 0, N = W * H; i < N; i++) {
      const f = food[i];
      dead += f;
      if (f > 0) {
        const dec = f * (foodK[i] === 1 ? K.DECAY_PLANT : K.DECAY_MEAT);
        const nf = f - dec;
        fert[i] += dec * K.FERT_GAIN * 10;
        if (nf < 0.15) { food[i] = 0; fert[i] += nf * K.FERT_GAIN * 10; } else food[i] = nf;
      }
      if (fert[i] > 0) fert[i] *= K.FERT_DECAY;
    }
    this.deadMatter = dead;
    this.sproutSeeds();

    if (this.tick % 20 === 0) this.sample();
  }

  // How much a grazer can take from a plant this bite. Armour (bark, thorns) makes plants harder to eat.
  // Armour is weighed against the grazer's mouths, so grazers can answer armour with more mouths (an arms race).
  grazeAvail(tgt, o) {
    const floor = tgt.stress > K.OVERGRAZE ? 0 : K.GRAZE_FLOOR;
    return Math.min(K.GRAZE, Math.max(0, tgt.E - floor)) / (1 + K.ARMOR_DEFENSE * tgt.cnt[T.ARMOR] / o.cnt[T.MOUTH]);
  }

  // An eye scans a widening cone in the direction it faces. Every visible thing is weighed by how
  // strongly this organism's genes react to it (and how far away it is); the strongest wins.
  // Seeds sprout where the ground has been cleared: a bare patch with no plants shading it.
  sproutSeeds() {
    const { W, H, seeds, occ } = this, N = W * H, PD = this.prodDens, PC = K.PCHUNK, pw = this.pw;
    const checks = Math.ceil(N / 300);
    for (let k = 0; k < checks; k++) {
      const i = Math.floor(this.rng() * N);
      const sd = seeds[i];
      if (!sd) continue;
      if (this.tick - sd.t > K.SEED_LIFE) { seeds[i] = null; this.seedCount--; continue; }
      if (occ[i]) continue;
      const x = i % W, y = (i / W) | 0;
      if (PD[((y / PC) | 0) * pw + ((x / PC) | 0)] > 0) continue;
      if (!this.canPlace(sd.g.cells, x, y, 0, -1, true)) continue;
      const sp = this.speciesById.get(sd.sp);
      const wasGone = sp.alive === 0 ? this.tick - sp.died : 0;
      seeds[i] = null; this.seedCount--;
      this.spawn(cloneGenome(sd.g), x, y, 0, K.SEED_E, sp, sd.gen);
      if (wasGone) {
        sp.died = null; sp.revived = (sp.revived || 0) + 1;
        if (wasGone > K.YEAR / 2 && sp.peak >= 20) this.eventLog.push({ tick: this.tick, type: 'revival', name: sp.name + ' sprouts again from the seed bank after ' + (wasGone / K.YEAR).toFixed(1) + ' years' });
      }
    }
  }

  look(o, eye, B) {
    const { W, H, occ, cellT, food, terrain } = this;
    const react = o.g.react;
    const dir = (eye.d + o.rot) & 3;
    const ex = o.x + rotX(eye.x, eye.y, o.rot), ey = o.y + rotY(eye.x, eye.y, o.rot);
    const px = DX[(dir + 1) & 3], py = DY[(dir + 1) & 3];
    const R = Math.max(2, Math.round(K.EYE_RANGE * B.vis));
    let best = 0, bestCat = -1, bestDist = 0;
    for (let s = 1; s <= R; s++) {
      const spread = Math.min(3, (s / 3) | 0);
      const cx = ex + DX[dir] * s, cy = ey + DY[dir] * s;
      const fall = 1 - s / (R + 4);
      for (let l = 0; l <= spread * 2; l++) {
        const off = (l & 1 ? -1 : 1) * ((l + 1) >> 1);
        const x = cx + px * off, y = cy + py * off;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (terrain[i] === WALL) continue;
        const oc = occ[i];
        let cat = -1;
        if (oc) {
          if (oc === o.slot + 1) continue;
          const tgt = this.orgs[oc - 1];
          if (!tgt || tgt.sp === o.sp) continue; // ignore kin
          const ct = cellT[i];
          cat = ct === T.PROD ? 1 : ct === T.KILLER ? 2 : 3;
        } else if (food[i] > 0.5) cat = 0;
        if (cat === 1 && food[i] > 0.5 && Math.abs(react[0]) > Math.abs(react[1])) cat = 0; // litter under a plant
        if (cat < 0) continue;
        const w = Math.abs(react[cat]) * fall;
        if (w > best) { best = w; bestCat = cat; bestDist = s; }
      }
    }
    return bestCat < 0 ? null : { cat: bestCat, dist: bestDist, dir, w: best };
  }

  think(o, B) {
    let best = 0.15, bestDir = -1;
    if (o.cnt[T.EYE]) {
      for (const c of o.g.cells) {
        if (c.t !== T.EYE) continue;
        const seen = this.look(o, c, B);
        if (!seen) continue;
        const r = o.g.react[seen.cat];
        const w = seen.w;
        if (w > best) { best = w; bestDir = r > 0 ? seen.dir : (seen.dir + 2) & 3; }
      }
    }
    if (bestDir >= 0) o.heading = bestDir;
    else if (this.rng() < 0.07) o.heading = Math.floor(this.rng() * 4);
    if (this.rng() < 0.02) { // occasional turn of the body
      const nr = (o.rot + (this.rng() < 0.5 ? 1 : 3)) & 3;
      if (this.canPlace(o.g.cells, o.x, o.y, nr, o.slot, false)) { this.unstamp(o); o.rot = nr; this.stamp(o); }
    }
    // try to step forward; if blocked, sidestep left or right (walk around obstacles)
    const side = this.rng() < 0.5 ? 1 : 3;
    const tries = [o.heading, (o.heading + side) & 3, (o.heading + 4 - side) & 3];
    for (let k = 0; k < 3; k++) {
      const d = tries[k];
      const nx = o.x + DX[d], ny = o.y + DY[d];
      if (this.canPlace(o.g.cells, nx, ny, o.rot, o.slot, false)) {
        this.unstamp(o); o.x = nx; o.y = ny; this.stamp(o);
        const ti = ny * this.W + nx;
        const tb = this.terrain[ti] === WALL ? B : BIOMES[this.terrain[ti]];
        o.E -= K.MOVE * o.mass * tb.move;
        if (k > 0 && bestDir < 0) o.heading = d;
        return;
      }
    }
    o.heading = Math.floor(this.rng() * 4);
  }

  // ---------------- stats ----------------
  counts() {
    const roles = [0, 0, 0, 0, 0];
    let cellsSum = 0, animals = 0, maxCells = 0, total = 0, consumers = 0;
    const typeSum = [0, 0, 0, 0, 0, 0, 0];
    for (const o of this.orgs) {
      if (!o) continue;
      total++;
      roles[o.role]++;
      if (o.cnt[T.MOUTH]) consumers++;
      if (o.role !== ROLE.PLANT) { cellsSum += o.n; animals++; }
      if (o.n > maxCells) maxCells = o.n;
      for (let t = 1; t < 7; t++) typeSum[t] += o.cnt[t];
    }
    let spAlive = 0; for (const s of this.species) if (s.alive > 0) spAlive++;
    return { roles, total, consumers, meanAnimalCells: animals ? cellsSum / animals : 0, maxCells, spAlive, typeSum };
  }

  sample() {
    const c = this.counts();
    // Specialist diseases spread best through crowded species ("kill the winner"): transmission depends on
    // how densely a species packs the world, so abundant species suffer extra deaths and rare ones, like most
    // predators, escape. This keeps any one strategy from taking over.
    const tiles = this.W * this.H;
    for (const s of this.species) {
      const dens = s.alive / tiles;
      s.disease = dens > K.DISEASE_FREE ? K.DISEASE * Math.min(1, (dens - K.DISEASE_FREE) / (2 * K.DISEASE_FREE)) : 0;
    }
    for (const s of this.species) s.abundance += s.alive;
    for (let r = 0; r < 4; r++) {
      if (this.roleSeen[r] && c.roles[r] === 0 && this.roleExtinct[r] == null) this.roleExtinct[r] = this.tick;
      if (c.roles[r] > 0) this.roleExtinct[r] = null;
    }
    if (c.total > this.peakPop) this.peakPop = c.total;
    this.history.push({ t: this.tick, r: c.roles.slice(), sp: c.spAlive, mc: c.meanAnimalCells, xc: c.maxCells, total: c.total });
    if (this.history.length > 1200) { // downsample older half
      const h = this.history; const out = [];
      for (let i = 0; i < h.length; i++) if (i >= h.length - 300 || i % 2 === 0) out.push(h[i]);
      this.history = out;
    }
    this.last = c;
    if (c.total === 0) this.end('Total extinction: nothing is left alive.');
    else if (c.consumers === 0 && !this.pending.length && (this.roleSeen[1] || this.roleSeen[2] || this.roleSeen[3])) {
      if (this.noConsumerSince < 0) this.noConsumerSince = this.tick;
      else if (this.tick - this.noConsumerSince > 600) this.end('The food web collapsed: no animal life remains, only plants.');
    } else this.noConsumerSince = -1;
  }

  end(reason) {
    if (this.ended) return;
    this.ended = { tick: this.tick, reason };
  }

  summary() {
    const sp = this.species;
    const byAb = sp.slice().sort((a, b) => b.abundance - a.abundance);
    const life = s => (s.died != null ? s.died : this.tick) - s.born;
    const byLife = sp.slice().sort((a, b) => life(b) - life(a));
    const animalAb = sp.filter(s => s.role !== ROLE.PLANT).sort((a, b) => b.abundance - a.abundance);
    return {
      ticks: this.tick, years: this.tick / K.YEAR, generations: this.maxGen, speciesTotal: sp.length,
      peakPop: this.peakPop, births: this.totalBirths, deaths: Object.assign({}, this.deaths),
      mostSuccessful: byAb.slice(0, 5), mostSuccessfulAnimal: animalAb[0] || null,
      longestLived: byLife[0], biggest: this.biggest, innovations: this.innovations.slice(),
      events: this.eventLog.slice(), roleExtinct: this.roleExtinct.slice(), ended: this.ended,
      history: this.history,
    };
  }
}

const API = { dietEff, World, T, TYPE_NAMES, ROLE, ROLE_NAMES, BIOMES, K, WALL, SIZES, countTypes, classify, rotX, rotY, genomeDistance };
// Always expose a global for the page; also export for Node when a CommonJS module exists.
global.EvoSim = API;
if (typeof window !== 'undefined') window.EvoSim = API;
if (typeof module !== 'undefined' && module && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
