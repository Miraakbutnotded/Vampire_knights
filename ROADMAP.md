# Roadmap

Where this project is, and the order the remaining work wants to happen in.

Written 2026-08-12 against `feat/tower-defense` @ `77c533a`. Every number here was
measured from the repo, not remembered — re-measure before trusting an old copy.

## Where it actually is

A **mature survivors game** with a **tower-defense pivot one map deep**.

| | built | notes |
| --- | ---: | --- |
| weapons | 26 | with evolutions |
| enemies | 13 | 8 behaviours incl. exploder, splitter |
| passives | 20 | |
| characters | 5 | each with an active ability |
| maps | 5 | **4 of them pure survival** |
| **structures** | **3** | gate, shrine, watchtower |
| **defence maps** | **1** | bastion |
| wave tables | 2 | `default`, `bastion` |
| tests | 500 | 20 files, incl. 7 architectural gates |

The engine work is done and good: isometric projection lands in one module, the
sim is headless-testable, content is data-driven, and the defence layer's core
distinction (`isWall` — walls are the objective, emplacements are hardware) is
derived rather than declared, so it cannot be forgotten by a new structure.

**The gap is content and run structure, not engine.**

## The stated destination

> "Full 3d with 3d character models. It will be a roguelite tower defense game.
> So we will be controlling and defending with our character and also we will
> upgrade the towers as well, add defences."

Two distinct asks. The tower-defense half is 20% built. The 3D half is not
started, and is a bigger decision than it sounds — see Phase 4.

---

## Phase 0 — Land what is already built

Nothing here is new work; it is stranded value.

- [ ] **Fast-forward `feat/tower-defense` into `main`.** *(awaiting go-ahead — touches the shared remote)* `main` has *zero*
      commits the branch lacks, so this is a clean fast-forward with no conflict
      risk. Nine commits — the whole pivot — are currently invisible on `main`.
- [ ] **Refresh `docs/reference-layer`.** Its `balance-tables.md` records gate
      300 hp / tower 140 hp / range 170 / damage 14. All four changed in
      `f4622e0` (2600 / 400 / 200 / 30). It is wrong the moment it merges.
- [ ] **Delete the stale refs** *(awaiting go-ahead — touches the shared remote)* `feat/character-sprites` and
      `feat/character-unlock-requirements` — both already merged, 0 ahead.

## Phase 1 — Make defence a genre, not a map

This is the phase that decides whether the pivot is real.

- [x] **Give the run a wave shape.** ~~Bastion was 900s of continuous survival
      with 255s of siege in it — 72% undifferentiated.~~ Done: `prepPressure`
      thins trash between sieges (derived from the live window, never authored
      twice), and a HUD banner counts the next wave in. Bastion moved from 28%
      to **57% siege by weight**. Still wanted here: a longer, more deliberate
      prep window between the late sieges, once the economy is play-tested.
- [ ] **More structures.** Three is too thin for a build to be a *choice*. The
      shape is already proven — an entry in `structures.json` plus additive
      upgrade deltas, no code — so this is mostly content: something that slows,
      something with splash, something that buffs neighbours.
- [ ] **A second defence map.** One map cannot tell you whether the pipeline
      generalises. This is the test of whether Phase 1's content work was
      structural or bespoke to bastion.

## Phase 2 — Make the defence layer deep

- [ ] **Validate the economy against a human.** The current tuning is measured
      against a *scripted bot*, which is not a player. Bastion currently holds
      to ~11:32 of 15:00 under bot play. Levers, and they move together:
      wall hp, tower dps, `SIEGE_BOUNTY_DIVISOR`.
- [ ] **Structure targeting and placement choices.** Right now a tower shoots
      the nearest thing it can see. Priority (nearest to the wall, lowest hp,
      strongest) is where placement becomes a decision.
- [ ] **Narrow-screen cluster overlap.** At ~375px the thumb cluster and the
      joystick's 40u floor cannot both fit — 60px overlap. iOS is
      landscape-locked so this is portrait-web only, but it is real.

## Phase 3 — Presentation catches up

- [ ] **Eight-direction sprites.** The outstanding cost of the isometric view:
      characters and enemies are single front-facing sprites flipped by
      `facing`, so walking north-west still shows a front view.
- [ ] **Hurt art for enemies.** The code path is already wired and gates on
      `sprites.hasOwn(..., AnimState.Hurt)`, so this is purely art — add the
      strip and the flinch appears.

## Phase 4 — The 3D decision

**This is a fork in the road, not a task, and it should be taken deliberately.**

"Full 3D with 3D character models" means replacing the renderer: Canvas2D and the
fixed 480x270 pixel buffer go, WebGL/Three.js comes in, and the entire art
pipeline (`spritify.py`, `animate.py`, the 20-colour palette, `validate:art`)
stops applying. The *simulation* survives — gameplay is already a flat 2D plane
and knows nothing about the view, which is exactly why the isometric change
landed in 291 lines without touching a single system. That is the good news.

The honest read: the isometric view already delivers most of what "3D" is
usually wanted *for* — depth, layering, a sense of a real space — at a fraction
of the cost, and the pixel art is the game's current identity. **Recommendation:
finish Phases 1-2 first.** A shallow tower defense in 3D is still shallow, and
you will know much more about what the game needs by then.

If 3D is still wanted after that, the cheapest honest first step is *not* a
rewrite: it is rendering 3D models to 8-direction sprite strips offline (Phase 3
wants those strips anyway), which buys the look with none of the engine risk.

---

## Order, and why

Phase 0 first because it is free. Phase 1 next because run structure is the
thing standing between "survivors game with towers in it" and "tower defense" —
and because every later decision is easier to make once the loop is right.
Phase 2 deepens what Phase 1 shapes. Phase 3 and 4 are presentation, and
presentation is the wrong thing to spend on while the loop is still being found.
