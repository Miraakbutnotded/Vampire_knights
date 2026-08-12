# Documentation index

Four documents already existed before this folder grew a reference section, and they are still
the right place to start:

| document | what it answers |
| --- | --- |
| [`../README.md`](../README.md) | Controls, the art pipeline, and **the format of every content JSON file**. Read it before editing anything in `src/content/`. |
| [`../CLAUDE.md`](../CLAUDE.md) | The architecture and its invariants — ownership, the tick order, the ECS contracts, the isolation gates. The rules you must not break. |
| [`art/palette.md`](art/palette.md) | The one canonical palette. Colour comes from here and nowhere else. |
| [`plans/`](plans/) | Dated design/roadmap documents from each build phase. Historical intent, not current truth. |

This folder adds a reference layer underneath them. Where CLAUDE.md says *"the tick order is
load-bearing"*, these say *what each system in that order actually does*; where the README says
*"here is the weapons.json schema"*, these say *what the shipped numbers are*.

## Developer reference

| document | what it answers |
| --- | --- |
| [`dev/module-reference.md`](dev/module-reference.md) | Every module in `src/`, its public surface, and the contract each export holds. The "where do I put this / what already exists" map. |
| [`dev/runtime-systems.md`](dev/runtime-systems.md) | How the running game actually works, end to end: boot, the frame, the tick, damage resolution, the event catalogue, rendering, UI layout, persistence. |
| [`dev/testing.md`](dev/testing.md) | What the 20 test files cover, how the simulation harness works, and how to write a new test that is worth having. |
| [`dev/build-and-release.md`](dev/build-and-release.md) | Toolchain, every npm script and what it actually proves, the Python art scripts, and the iOS/Capacitor path. |

## Design reference

| document | what it answers |
| --- | --- |
| [`design/balance-tables.md`](design/balance-tables.md) | The shipped numbers, extracted from `src/content/`: enemies, weapons and their evolutions, passives, characters, abilities, Sanctum, blood, structures. |
| [`design/progression.md`](design/progression.md) | Why those numbers: the fifteen-minute curve, the XP and difficulty maths, wave pressure per stage, the gold economy, the unlock graph, and the rules a new piece of content has to respect. |

## Reading order

- **New to the codebase**: `../CLAUDE.md` → `dev/runtime-systems.md` → `dev/module-reference.md`.
- **Adding content (a weapon, an enemy, a map)**: `../README.md` for the schema →
  `design/balance-tables.md` for where your numbers sit → `design/progression.md` for the
  constraints (wave pressure floor, evolution rules, unlock signals).
- **Adding code (a system, a behavior)**: `../CLAUDE.md` "Extending" → `dev/module-reference.md`
  for the module that owns it → `dev/testing.md` for the gate it will have to pass.
- **Shipping**: `dev/build-and-release.md`.

## A note on drift

Everything in `dev/` and `design/` was written by reading the source and the content JSON, and
the numeric tables were computed from those files rather than transcribed. That makes them
accurate at the time of writing and *unverified* afterwards — nothing in this folder is enforced
by a test. `src/content/*.json` and the modules themselves remain the source of truth. If a
number here disagrees with the JSON, the JSON is right and this file is stale.
