import { describe, expect, it } from 'vitest';

import { EventBus } from '../core/events.ts';
import type { GameEvents } from '../core/events.ts';
import {
  DAILY_BONUS_GOLD,
  DAILY_OBJECTIVE_GOLD,
  DAILY_POOL,
  DAY_MS,
  attachDailyTally,
  dailyDelta,
  dailyObjective,
  dailySet,
  defaultDaily,
  emptyTally,
  foldDaily,
  localDayIndex,
  migrateDaily,
  rolloverDaily,
} from './daily.ts';
import type { DailySave } from './daily.ts';

/** Minutes west of UTC, the sign `Date#getTimezoneOffset` uses. */
const ISTANBUL = -180;
const NEW_YORK = 240;

/** A local timestamp built from an explicit offset, so no test reads the host clock. */
const atLocal = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tzOffsetMinutes: number,
): number => Date.UTC(year, month - 1, day, hour, minute) + tzOffsetMinutes * 60_000;

const state = (over: Partial<DailySave> = {}): DailySave => ({ ...defaultDaily(), ...over });

describe('daily pool', () => {
  it('has unique ids, positive targets and only the two declared tiers', () => {
    const ids = new Set<string>();
    for (const def of DAILY_POOL) {
      expect(ids.has(def.id), `duplicate id ${def.id}`).toBe(false);
      ids.add(def.id);
      expect(def.target).toBeGreaterThan(0);
      expect(['core', 'flavour']).toContain(def.tier);
      expect(['sum', 'best']).toContain(def.mode);
      expect(def.label.length).toBeGreaterThan(0);
    }
    expect(DAILY_POOL.filter((d) => d.tier === 'core').length).toBeGreaterThanOrEqual(2);
    expect(DAILY_POOL.filter((d) => d.tier === 'flavour').length).toBeGreaterThanOrEqual(1);
  });

  it('ships the five core and five flavour objectives with their designed signals', () => {
    const byId = Object.fromEntries(DAILY_POOL.map((d) => [d.id, d]));
    expect(byId['kills']).toMatchObject({ tier: 'core', target: 400, mode: 'sum' });
    expect(byId['level']).toMatchObject({ tier: 'core', target: 20, mode: 'best' });
    expect(byId['picks']).toMatchObject({ tier: 'core', target: 12, mode: 'sum' });
    expect(byId['gold']).toMatchObject({ tier: 'core', target: 400, mode: 'sum' });
    expect(byId['survive']).toMatchObject({ tier: 'core', target: 600, mode: 'best' });
    expect(byId['frenzy']).toMatchObject({ tier: 'flavour', target: 5, mode: 'sum' });
    expect(byId['feast']).toMatchObject({ tier: 'flavour', target: 200, mode: 'sum' });
    expect(byId['siege']).toMatchObject({ tier: 'flavour', target: 2, mode: 'sum' });
    expect(byId['evolve']).toMatchObject({ tier: 'flavour', target: 1, mode: 'sum' });
    expect(byId['walls']).toMatchObject({ tier: 'flavour', target: 1, mode: 'best' });
  });

  it('looks objectives up by id and returns null for a stranger', () => {
    expect(dailyObjective('kills')?.id).toBe('kills');
    expect(dailyObjective('nope')).toBeNull();
  });
});

describe('dailySet', () => {
  it('is deterministic from the day index alone, so the set is never stored', () => {
    for (const day of [0, 1, 20447, 99999]) {
      expect(dailySet(day).map((d) => d.id)).toEqual(dailySet(day).map((d) => d.id));
    }
  });

  it('always draws two core and one flavour, on every day for a long stretch', () => {
    for (let day = 20000; day < 20400; day++) {
      const set = dailySet(day);
      expect(set).toHaveLength(3);
      expect(set.filter((d) => d.tier === 'core')).toHaveLength(2);
      expect(set.filter((d) => d.tier === 'flavour')).toHaveLength(1);
      expect(new Set(set.map((d) => d.id)).size).toBe(3);
      for (const def of set) expect(DAILY_POOL).toContain(def);
    }
  });

  it('rotates: consecutive days are not all the same set', () => {
    const seen = new Set<string>();
    for (let day = 20000; day < 20030; day++) seen.add(dailySet(day).map((d) => d.id).join('+'));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('localDayIndex', () => {
  it('floors to the local day, not the UTC day', () => {
    // 00:30 local in Istanbul (UTC+3) is still the previous UTC day.
    const justAfterLocalMidnight = atLocal(2026, 8, 2, 0, 30, ISTANBUL);
    const justBeforeLocalMidnight = atLocal(2026, 8, 1, 23, 30, ISTANBUL);
    expect(localDayIndex(justAfterLocalMidnight, ISTANBUL)).toBe(
      localDayIndex(justBeforeLocalMidnight, ISTANBUL) + 1,
    );
    // Same instant judged as UTC would still be Aug 1 — the local rule differs.
    expect(localDayIndex(justAfterLocalMidnight, 0)).toBe(
      localDayIndex(justBeforeLocalMidnight, 0),
    );
  });

  it('is stable across the whole of one local day', () => {
    const start = atLocal(2026, 8, 2, 0, 0, ISTANBUL);
    const end = atLocal(2026, 8, 2, 23, 59, ISTANBUL);
    expect(localDayIndex(end, ISTANBUL)).toBe(localDayIndex(start, ISTANBUL));
    expect(localDayIndex(start + DAY_MS, ISTANBUL)).toBe(localDayIndex(start, ISTANBUL) + 1);
  });
});

describe('rollover — the monotonic floor', () => {
  const day0 = atLocal(2026, 8, 2, 21, 0, ISTANBUL);
  const rolled = rolloverDaily(defaultDaily(), day0, ISTANBUL).state;

  it('adopts the observed day on the first ever roll without paying for a set it replaces', () => {
    const first = rolloverDaily(defaultDaily(), day0, ISTANBUL);
    expect(first.rolled).toBe(true);
    expect(first.state.day).toBe(localDayIndex(day0, ISTANBUL));
    expect(first.state.progress).toEqual({});
    expect(first.state.claimed).toEqual([]);
    expect(first.state.bonusClaimed).toBe(false);
  });

  it('does not roll twice in the same local day, and leaves progress alone', () => {
    const mid = { ...rolled, progress: { kills: 120 }, claimed: ['kills'], bonusClaimed: false };
    const again = rolloverDaily(mid, day0 + 60 * 60_000, ISTANBUL);
    expect(again.rolled).toBe(false);
    expect(again.state).toBe(mid);
    expect(again.state.progress).toEqual({ kills: 120 });
  });

  it('rolls at the next local midnight and wipes progress, claims and the bonus', () => {
    const mid = { ...rolled, progress: { kills: 400 }, claimed: ['kills'], bonusClaimed: true };
    const next = rolloverDaily(mid, day0 + DAY_MS, ISTANBUL);
    expect(next.rolled).toBe(true);
    expect(next.state.day).toBe(mid.day + 1);
    expect(next.state).toEqual({ day: mid.day + 1, progress: {}, claimed: [], bonusClaimed: false });
  });

  it('absorbs a clock set backwards: no re-roll, nothing already earned is lost', () => {
    const mid = { ...rolled, progress: { kills: 300 }, claimed: ['gold'], bonusClaimed: false };
    const back = rolloverDaily(mid, day0 - 5 * DAY_MS, ISTANBUL);
    expect(back.rolled).toBe(false);
    expect(back.state).toBe(mid);
    expect(back.state.day).toBe(mid.day);
    expect(back.state.progress).toEqual({ kills: 300 });
    expect(back.state.claimed).toEqual(['gold']);
  });

  it('makes clock-forward farming self-punishing: every farmed set raises the floor', () => {
    let s = rolled;
    const realDay = s.day;
    // Three jumps forward, each granting a set immediately.
    for (let jump = 1; jump <= 3; jump++) {
      const result = rolloverDaily(s, day0 + jump * DAY_MS, ISTANBUL);
      expect(result.rolled).toBe(true);
      s = result.state;
    }
    expect(s.day).toBe(realDay + 3);
    // Restore the real clock: the floor never descends, so the next three real
    // days grant nothing at all.
    for (let realDayAhead = 0; realDayAhead <= 3; realDayAhead++) {
      expect(rolloverDaily(s, day0 + realDayAhead * DAY_MS, ISTANBUL).rolled).toBe(false);
    }
    // Only the fourth real day past the jump clears the raised floor.
    expect(rolloverDaily(s, day0 + 4 * DAY_MS, ISTANBUL).rolled).toBe(true);
  });

  it('costs an honest westward traveller at most one skipped set, never a reset', () => {
    // Rolled just past local midnight in Istanbul (01:00 on Aug 3). The same
    // instant is still 18:00 on Aug 2 in New York, so flying west drops the
    // observed local day index by one for the remainder of that day.
    const pastIstanbulMidnight = atLocal(2026, 8, 3, 1, 0, ISTANBUL);
    const inIstanbul = rolloverDaily(defaultDaily(), pastIstanbulMidnight, ISTANBUL).state;
    const withProgress = { ...inIstanbul, progress: { kills: 250 }, claimed: ['picks'] };
    const landed = atLocal(2026, 8, 2, 20, 0, NEW_YORK);
    expect(localDayIndex(landed, NEW_YORK)).toBeLessThan(withProgress.day);

    const after = rolloverDaily(withProgress, landed, NEW_YORK);
    expect(after.rolled).toBe(false);
    expect(after.state.progress).toEqual({ kills: 250 });
    expect(after.state.claimed).toEqual(['picks']);
    // The player keeps the day they already had and advances at their next
    // local midnight — one skipped set at worst, never a lost reward.
    const nextNewYorkMidnight = atLocal(2026, 8, 3, 0, 5, NEW_YORK);
    expect(rolloverDaily(after.state, nextNewYorkMidnight, NEW_YORK).rolled).toBe(false);
    expect(rolloverDaily(after.state, atLocal(2026, 8, 4, 0, 5, NEW_YORK), NEW_YORK).rolled).toBe(
      true,
    );
  });

  it('treats a DST shift as a genuine non-event', () => {
    // Same local wall-clock hour either side of a one-hour offset change.
    const before = rolloverDaily(defaultDaily(), atLocal(2026, 10, 24, 12, 0, -180), -180).state;
    expect(rolloverDaily(before, atLocal(2026, 10, 24, 12, 0, -120), -120).rolled).toBe(false);
    expect(rolloverDaily(before, atLocal(2026, 10, 25, 12, 0, -120), -120).rolled).toBe(true);
  });
});

describe('dailyDelta — the wire between run signals and objective ids', () => {
  const tally = { picks: 7, frenzy: 3, feastHealed: 88, sieges: 1, evolves: 2 };
  const summary = {
    kills: 412,
    level: 19,
    gold: 603,
    survivedSeconds: 640,
    structuresSpawned: 3,
    structuresLost: 0,
  };

  it('maps every objective to the exact signal it was designed against', () => {
    expect(dailyDelta(tally, summary)).toEqual({
      kills: 412,
      level: 19,
      picks: 7,
      gold: 603,
      survive: 640,
      frenzy: 3,
      feast: 88,
      siege: 1,
      evolve: 2,
      walls: 1,
    });
  });

  it('credits walls only when structures existed and every one survived', () => {
    expect(dailyDelta(tally, { ...summary, structuresLost: 1 })['walls']).toBe(0);
    expect(dailyDelta(tally, { ...summary, structuresSpawned: 0 })['walls']).toBe(0);
  });

  /**
   * The label promises the Bastion held, so a siege has to have been held.
   * Structures standing is not evidence of that on its own: the bastion's first
   * siege lands at 60s, so dying into the opening spawns leaves four structures
   * spawned, none lost, and no wall ever tested — the cheapest possible route
   * to a 150-gold objective and, with it, the all-three bonus.
   */
  it('refuses walls to a run that ended before a single siege resolved', () => {
    const suicide = { ...tally, sieges: 0 };
    expect(
      dailyDelta(suicide, {
        kills: 3,
        level: 1,
        gold: 5,
        survivedSeconds: 30,
        structuresSpawned: 4,
        structuresLost: 0,
      })['walls'],
    ).toBe(0);
    // One siege held with every wall up is the whole objective.
    expect(dailyDelta({ ...tally, sieges: 1 }, summary)['walls']).toBe(1);
  });

  it('emits a key for every pool objective, so nothing silently never progresses', () => {
    expect(Object.keys(dailyDelta(tally, summary)).sort()).toEqual(
      DAILY_POOL.map((d) => d.id).sort(),
    );
  });
});

describe('attachDailyTally — the real bus signals, not a paraphrase of them', () => {
  it('counts each signal off the event vocabulary gameplay actually emits', () => {
    const bus = new EventBus<GameEvents>();
    const { tally } = attachDailyTally(bus);

    bus.emit('draft:picked', {
      kind: 'weapon',
      id: 'w',
      level: 2,
      isNew: false,
      atLevel: 3,
      offered: ['w'],
    });
    bus.emit('draft:picked', {
      kind: 'passive',
      id: 'p',
      level: 1,
      isNew: true,
      atLevel: 4,
      offered: ['p'],
    });
    // Heal and gold consolation picks are not upgrades and must not count.
    bus.emit('draft:picked', {
      kind: 'heal',
      id: 'heal',
      level: 0,
      isNew: false,
      atLevel: 5,
      offered: ['heal'],
    });
    bus.emit('draft:picked', {
      kind: 'gold',
      id: 'gold',
      level: 0,
      isNew: false,
      atLevel: 6,
      offered: ['gold'],
    });

    bus.emit('blood:frenzy', { spent: 100, duration: 6 });
    bus.emit('blood:frenzy', { spent: 100, duration: 6 });
    bus.emit('blood:feast', { spent: 50, healed: 30 });
    bus.emit('blood:feast', { spent: 50, healed: 12 });
    bus.emit('siege:defended', { gold: 40 });
    bus.emit('weapon:evolved', { baseId: 'a', intoId: 'b', name: 'B' });

    expect(tally()).toEqual({ picks: 2, frenzy: 2, feastHealed: 42, sieges: 1, evolves: 1 });
  });

  it('detaches cleanly, so a torn-down run cannot keep tallying', () => {
    const bus = new EventBus<GameEvents>();
    const { tally, detach } = attachDailyTally(bus);
    bus.emit('siege:defended', { gold: 10 });
    detach();
    bus.emit('siege:defended', { gold: 10 });
    expect(tally().sieges).toBe(1);
  });

  it('resets to zero between runs without needing a new subscription', () => {
    const bus = new EventBus<GameEvents>();
    const { tally, reset } = attachDailyTally(bus);
    bus.emit('blood:frenzy', { spent: 1, duration: 1 });
    reset();
    expect(tally()).toEqual(emptyTally());
    bus.emit('blood:frenzy', { spent: 1, duration: 1 });
    expect(tally().frenzy).toBe(1);
  });

  it('completes a real objective end to end: bus signals → delta → payout', () => {
    const bus = new EventBus<GameEvents>();
    const { tally } = attachDailyTally(bus);
    // Find a day whose set contains 'frenzy', so the assertion is concrete.
    let day = 20400;
    while (!dailySet(day).some((d) => d.id === 'frenzy')) day++;

    const frenzy = dailyObjective('frenzy')!;
    for (let i = 0; i < frenzy.target; i++) bus.emit('blood:frenzy', { spent: 90, duration: 6 });

    const delta = dailyDelta(tally(), {
      kills: 10,
      level: 4,
      gold: 20,
      survivedSeconds: 120,
      structuresSpawned: 0,
      structuresLost: 0,
    });
    const settled = foldDaily(state({ day }), delta);
    expect(settled.completed).toContain('frenzy');
    expect(settled.gold).toBeGreaterThanOrEqual(DAILY_OBJECTIVE_GOLD);
  });
});

describe('foldDaily', () => {
  // Pin a day whose set is known, so completion assertions are concrete.
  const day = 20400;
  const set = dailySet(day);
  const [a, b, c] = set as [(typeof set)[0], (typeof set)[0], (typeof set)[0]];
  const zero = (): Record<string, number> =>
    Object.fromEntries(DAILY_POOL.map((d) => [d.id, 0]));

  it('sums sum-mode signals across runs and takes the best of best-mode ones', () => {
    const first = foldDaily(state({ day }), { ...zero(), kills: 100, level: 12, survive: 300 });
    const second = foldDaily(first.state, { ...zero(), kills: 150, level: 9, survive: 200 });
    expect(second.state.progress['kills']).toBe(250);
    expect(second.state.progress['level']).toBe(12);
    expect(second.state.progress['survive']).toBe(300);
    const third = foldDaily(second.state, { ...zero(), level: 21, survive: 700 });
    expect(third.state.progress['level']).toBe(21);
    expect(third.state.progress['survive']).toBe(700);
  });

  it('pays a completed objective once and never again', () => {
    const hit = { ...zero(), [a.id]: a.target } as Record<string, number>;
    const first = foldDaily(state({ day }), hit);
    expect(first.completed).toEqual([a.id]);
    expect(first.gold).toBe(DAILY_OBJECTIVE_GOLD);
    expect(first.state.claimed).toEqual([a.id]);

    const second = foldDaily(first.state, hit);
    expect(second.completed).toEqual([]);
    expect(second.gold).toBe(0);
    expect(second.state.claimed).toEqual([a.id]);
  });

  it('ignores objectives outside today’s set', () => {
    const outsider = DAILY_POOL.find((d) => !set.includes(d))!;
    const result = foldDaily(state({ day }), { ...zero(), [outsider.id]: outsider.target * 10 });
    expect(result.completed).toEqual([]);
    expect(result.gold).toBe(0);
    // Progress is still recorded — only the payout is set-scoped.
    expect(result.state.progress[outsider.id]).toBe(outsider.target * 10);
  });

  it('pays the all-three bonus exactly once, on the run that closes the set', () => {
    const partial = foldDaily(state({ day }), {
      ...zero(),
      [a.id]: a.target,
      [b.id]: b.target,
    } as Record<string, number>);
    expect(partial.gold).toBe(2 * DAILY_OBJECTIVE_GOLD);
    expect(partial.state.bonusClaimed).toBe(false);

    const closing = foldDaily(partial.state, { ...zero(), [c.id]: c.target } as Record<
      string,
      number
    >);
    expect(closing.completed).toEqual([c.id]);
    expect(closing.gold).toBe(DAILY_OBJECTIVE_GOLD + DAILY_BONUS_GOLD);
    expect(closing.state.bonusClaimed).toBe(true);

    const after = foldDaily(closing.state, { ...zero(), [c.id]: c.target } as Record<string, number>);
    expect(after.gold).toBe(0);
  });

  it('is worth roughly one good run: a full set matches a 15-minute run’s banked gold', () => {
    // simulation.test.ts pins a full seeded run at 300 < gold < 1200 (~603 observed).
    const fullSet = 3 * DAILY_OBJECTIVE_GOLD + DAILY_BONUS_GOLD;
    expect(fullSet).toBeGreaterThan(300);
    expect(fullSet).toBeLessThan(1200);
  });

  it('never mutates the state it was handed', () => {
    const before = state({ day, progress: { kills: 10 } });
    const snapshot = JSON.parse(JSON.stringify(before)) as DailySave;
    foldDaily(before, { ...zero(), kills: 99 });
    expect(before).toEqual(snapshot);
  });
});

describe('migrateDaily', () => {
  it('falls to defaults for anything that is not a record', () => {
    for (const junk of [undefined, null, 4, 'x', []]) {
      expect(migrateDaily(junk)).toEqual(defaultDaily());
    }
  });

  it('rejects a day that is not a finite non-negative integer', () => {
    expect(migrateDaily({ day: -3 }).day).toBe(0);
    expect(migrateDaily({ day: 1.5 }).day).toBe(0);
    expect(migrateDaily({ day: Number.NaN }).day).toBe(0);
    expect(migrateDaily({ day: Number.POSITIVE_INFINITY }).day).toBe(0);
    expect(migrateDaily({ day: '20400' }).day).toBe(0);
    expect(migrateDaily({ day: 20400 }).day).toBe(20400);
  });

  it('filters progress keys to the known pool so a hand-edited save cannot grow', () => {
    const out = migrateDaily({ day: 1, progress: { kills: 12, notAnObjective: 999 } });
    expect(out.progress).toEqual({ kills: 12 });
  });

  it('coerces progress values to non-negative finite numbers', () => {
    const out = migrateDaily({
      day: 1,
      progress: { kills: -5, gold: Number.NaN, level: '9', picks: 3.7 },
    });
    expect(out.progress).toEqual({ picks: 3.7 });
  });

  it('filters claimed to known pool ids and drops duplicates', () => {
    const out = migrateDaily({ day: 1, claimed: ['kills', 'kills', 'ghost', 7] });
    expect(out.claimed).toEqual(['kills']);
  });

  it('coerces bonusClaimed strictly', () => {
    expect(migrateDaily({ day: 1, bonusClaimed: true }).bonusClaimed).toBe(true);
    expect(migrateDaily({ day: 1, bonusClaimed: 'true' }).bonusClaimed).toBe(false);
    expect(migrateDaily({ day: 1 }).bonusClaimed).toBe(false);
  });
});

/**
 * The rollover boundary is enforced in game.ts, which needs a browser, so this
 * reads it as raw text — the same trick repaint.test.ts uses to hold a game.ts
 * invariant that no headless harness can drive. import.meta.glob is not a
 * specifier position, so this does not trip the engine isolation gate.
 */
const gameSource = (
  import.meta.glob(['../game.ts'], { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >
)['../game.ts']!;

describe('rollover never runs mid-run', () => {
  const onResumed = gameSource.match(/onResumed\(\): void \{([\s\S]*?)\n  \}/)?.[1] ?? '';

  it('has an onResumed to read', () => {
    expect(onResumed).not.toBe('');
    expect(onResumed).toContain('rollDaily');
  });

  /**
   * wireLifecycle fires onResumed on every visibilitychange → visible, and that
   * includes the return from autoPause with a run still open in 'paused'. If
   * the roll were reachable there, backgrounding at 23:55 and returning at
   * 00:05 would replace the day under a run whose runDay was frozen at
   * startRun; commitDailyRun would then discard the entire run as stale (see
   * meta.test.ts, 'discards a run that started on a different day'), paying
   * nothing and resetting the bars the player just filled — with no UI signal.
   *
   * The guard has to wrap the roll itself, not just the repaint that follows
   * it: rollDaily persists the new day as a side effect of being called.
   */
  it('refuses to roll unless the title screen is up, before touching rollDaily', () => {
    const guard = onResumed.indexOf("this.state !== 'title'");
    const roll = onResumed.indexOf('rollDaily');
    expect(guard, 'onResumed must guard on state').toBeGreaterThanOrEqual(0);
    expect(roll, 'the state guard must precede the roll').toBeGreaterThan(guard);
    expect(onResumed.slice(guard, roll), 'the guard must return, not just gate a repaint').toContain(
      'return',
    );
  });

  /**
   * Nothing is lost by the guard: every path out of a run lands on openTitle,
   * which rolls. A suspended app therefore picks the new day up the moment it
   * comes back to the title, and the run in flight keeps the day it began on.
   */
  it('rolls on every path back to the title, so a suspended app still catches up', () => {
    const openTitle = gameSource.match(/openTitle\(\): void \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(openTitle).toContain('rollDaily');
  });
});
