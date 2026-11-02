# Primordia

An evolution sandbox. You build a world, release simple organisms, and watch them evolve until the ecosystem collapses. Then you get a summary of how long it lasted and which species did best.

Organisms are bodies made of typed cells: producer, mouth, mover, killer, armour and eye. Every cell costs energy. Organisms eat, move, breed with small copying mistakes, and die. There is no fitness function. Plants, grazers, predators and scavengers, and the shifts between them, all emerge from those rules.

**Play it:** open `index.html` in a browser. Nothing needs installing.

## Files

| File | What it is |
|---|---|
| `index.html` | The built, playable page (interface and simulation in one file) |
| `app.html` | Interface source |
| `sim.js` | Simulation core. It has no DOM dependencies, so it also runs in Node |
| `build.py` | Rebuilds `index.html` from `app.html` and `sim.js` |
| `tools/` | Headless test scripts used for balancing (Node) |

After editing `app.html` or `sim.js`, rebuild the page with:

```
python3 build.py
```

## Balancing tools

Run these from the repo root:

```
node tools/sweep.js 12000 '[{}]' 5          # which trophic levels survive, per seed
node tools/shifts.js 4 15000                 # lineages that changed role (grazer → plant, etc.)
node tools/dom.js ./sim.js 30000             # long-run diversity and dominant strategies
node tools/compare.js ./sim.js '{"predators":0,"scavengers":0}'   # boom-bust and plant diversity
node tools/founder.js 2.5                    # single-ancestor worlds
node tools/preddiag.js                       # predator speed, generations and causes of death
```

All tuning constants live in the `K` object at the top of `sim.js`, each with a comment.

## Where the rules come from

- Metabolic scaling: Brown et al. 2004
- Energy loss between trophic levels: Lindeman 1942
- Succession and spatial refuges: Huffaker 1958
- Predator interference: Beddington–DeAngelis
- Marginal value theorem: Charnov 1976
- Stepping stones to complex features: Lenski et al. 2003
- Carnivorous plants in nutrient-poor habitats: Givnish et al.
- The cost of mixotrophy: Ward et al. 2011; Tittel et al. 2003
- Open-ended evolution: Taylor 2015
