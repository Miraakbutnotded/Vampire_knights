import { describe, expect, it } from 'vitest';

import { CHARACTER_LIST, UNLOCK_SIGNAL_IDS } from '../gameplay/content.ts';
import { emptyTally } from './daily.ts';
import type { DailyRunSummary, DailyRunTally } from './daily.ts';
import {
  FEAT_SIGNAL_IDS,
  defaultFeats,
  featDelta,
  featMet,
  featProgress,
  foldFeats,
  migrateFeats,
} from './feats.ts';

const summary = (over: Partial<DailyRunSummary> = {}): DailyRunSummary => ({
  kills: 0,
  level: 1,
  gold: 0,
  survivedSeconds: 0,
  structuresSpawned: 0,
  structuresLost: 0,
  ...over,
});

const tally = (over: Partial<DailyRunTally> = {}): DailyRunTally => ({ ...emptyTally(), ...over });

describe('feat delta', () => {
  /**
   * Three lists have to agree for a requirement to be reachable: the signals
   * content.ts lets characters.json name, the whitelist feats.ts folds, and
   * what featDelta actually emits for a finished run. feats.ts cannot import
   * content.ts — save.ts's import closure is walled off from gameplay/ by
   * telemetry.test.ts — so the agreement is asserted here, in the one place
   * allowed to see both sides. A signal added to one list and not the others
   * fails here instead of shipping a requirement no run can ever progress.
   */
  it('agrees with content.ts about which signals exist, and emits every one', () => {
    expect([...FEAT_SIGNAL_IDS].sort()).toEqual([...UNLOCK_SIGNAL_IDS].sort());
    const emitted = Object.keys(featDelta(tally(), summary(), false)).sort();
    expect(emitted).toEqual([...FEAT_SIGNAL_IDS].sort());
  });

  it('carries the daily signals through unchanged and adds the victory flag', () => {
    const delta = featDelta(
      tally({ picks: 4, evolves: 1 }),
      summary({ kills: 300, level: 17, gold: 250, survivedSeconds: 610 }),
      true,
    );
    expect(delta).toMatchObject({
      kills: 300,
      level: 17,
      gold: 250,
      survive: 610,
      picks: 4,
      evolve: 1,
      victory: 1,
    });
    expect(featDelta(tally(), summary(), false)['victory']).toBe(0);
  });

  /** Dragos' requirement, end to end: only a won run counts. */
  it('scores victory only on a run that was actually won', () => {
    const died = foldFeats(defaultFeats(), featDelta(tally(), summary({ survivedSeconds: 880 }), false));
    const req = { id: 'victory', target: 1, mode: 'best' } as const;
    expect(featMet(died, req)).toBe(false);
    const won = foldFeats(died, featDelta(tally(), summary({ survivedSeconds: 900 }), true));
    expect(featMet(won, req)).toBe(true);
  });

  /**
   * Aldric's requirement rides on `walls`, which dailyDelta already refuses to
   * score without a siege actually held — an early death on the Bastion leaves
   * four structures standing and must not count as holding them.
   */
  it('scores walls only when a siege was survived with everything standing', () => {
    const suicide = featDelta(tally(), summary({ structuresSpawned: 4 }), false);
    expect(suicide['walls']).toBe(0);
    const held = featDelta(tally({ sieges: 1 }), summary({ structuresSpawned: 4 }), false);
    expect(held['walls']).toBe(1);
    const lostOne = featDelta(
      tally({ sieges: 1 }),
      summary({ structuresSpawned: 4, structuresLost: 1 }),
      false,
    );
    expect(lostOne['walls']).toBe(0);
  });
});

describe('feat record', () => {
  it('accumulates sums and keeps the best single run per signal', () => {
    let state = foldFeats(defaultFeats(), { kills: 100, level: 12 });
    state = foldFeats(state, { kills: 250, level: 8 });
    expect(state.sum).toEqual({ kills: 350, level: 20 });
    expect(state.best).toEqual({ kills: 250, level: 12 });
  });

  it('drops zero and negative contributions rather than recording them', () => {
    const state = foldFeats(defaultFeats(), { kills: 0, level: -3, victory: 1 });
    expect(state.sum).toEqual({ victory: 1 });
    expect(state.best).toEqual({ victory: 1 });
  });

  it('ignores signals outside the whitelist', () => {
    const state = foldFeats(defaultFeats(), { kills: 5, madeUpSignal: 999 });
    expect(state.sum).toEqual({ kills: 5 });
  });

  it('never mutates the state it folds into', () => {
    const before = defaultFeats();
    foldFeats(before, { kills: 10 });
    expect(before).toEqual({ sum: {}, best: {} });
  });

  it('reads progress in the requirement’s own mode', () => {
    const state = foldFeats(foldFeats(defaultFeats(), { kills: 400 }), { kills: 300 });
    expect(featProgress(state, { id: 'kills', target: 1, mode: 'sum' })).toBe(700);
    expect(featProgress(state, { id: 'kills', target: 1, mode: 'best' })).toBe(400);
    // A signal the player has never scored reads 0, not undefined.
    expect(featProgress(state, { id: 'siege', target: 1, mode: 'sum' })).toBe(0);
  });

  it('sanitizes a hand-edited record, section by section', () => {
    expect(migrateFeats(undefined)).toEqual(defaultFeats());
    expect(migrateFeats('feats')).toEqual(defaultFeats());
    expect(migrateFeats([])).toEqual(defaultFeats());
    expect(
      migrateFeats({ sum: { kills: 12, nope: 5, gold: Infinity }, best: { level: 30 }, junk: 1 }),
    ).toEqual({ sum: { kills: 12 }, best: { level: 30 } });
  });
});

describe('character unlock requirements', () => {
  /**
   * Every requirement in characters.json has to be one a run can actually
   * progress — a typo in the signal id normalizes to null (leaving the
   * character on gold alone), so this asserts the roster still asks for the
   * feats it is meant to rather than having quietly lost them.
   */
  it('names a known signal, with a positive target and a printable label', () => {
    const priced = CHARACTER_LIST.filter((c) => c.unlock !== null);
    expect(priced.length).toBeGreaterThan(0);
    for (const character of priced) {
      const requirement = character.unlock!.requirement;
      expect(requirement, `${character.id} lost its unlock requirement`).not.toBeNull();
      expect(UNLOCK_SIGNAL_IDS.has(requirement!.id)).toBe(true);
      expect(requirement!.target).toBeGreaterThan(0);
      expect(requirement!.label.length).toBeGreaterThan(0);
    }
  });

  /** The free entry point stays free — a gated slot 0 would soft-lock a fresh save. */
  it('leaves the first character ungated', () => {
    expect(CHARACTER_LIST[0]!.unlock).toBeNull();
  });
});
