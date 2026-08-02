import type { EventBus, GameEvents } from '../core/events.ts';
import { Rng } from '../core/rng.ts';

/**
 * "Tonight's Oaths" — three daily objectives drawn from a fixed pool.
 *
 * This module is deliberately pure: free functions over plain data, no storage,
 * no clock of its own. MetaService owns the one SaveData and is the only thing
 * that persists a DailySave; a second service wrapping its own SaveStore over
 * the same key would make the two replace each other's state and lose fields on
 * whichever wrote second.
 *
 * Every objective resolves against a signal gameplay already emits. Nothing new
 * is fired for the dailies; `walls` reads the widened 'run:ended' payload.
 */

export type DailyTier = 'core' | 'flavour';

/**
 * How a run's contribution folds into the day's progress. 'sum' accumulates
 * across every run of the day; 'best' keeps the high-water mark, which is what
 * "in one run" objectives need.
 */
export type DailyMode = 'sum' | 'best';

export interface DailyObjectiveDef {
  id: string;
  tier: DailyTier;
  label: string;
  target: number;
  mode: DailyMode;
}

/** The persisted half. Owned by SaveData; migrated by migrateDaily below. */
export interface DailySave {
  /** Monotonic floor, local day index. 0 reads as "never rolled". */
  day: number;
  /** Objective id → accumulated value. Keys are always pool ids. */
  progress: Record<string, number>;
  /** Ids already paid out today. */
  claimed: string[];
  /** Whether the all-three bonus has been paid today. */
  bonusClaimed: boolean;
}

export const DAY_MS = 86_400_000;

/**
 * Flat payout per objective, plus a bonus for clearing all three.
 *
 * Tuned so a full day's set (3 × 150 + 150 = 600) is worth roughly one good
 * run: simulation.test.ts pins a full seeded fifteen-minute run at 300..1200
 * banked gold, ~603 observed. A player who shows up daily therefore earns about
 * double; a player who grinds ten runs earns nothing extra from the dailies.
 * For scale, the cheapest Sanctum rank in meta.json costs 80 and the first rank
 * of the headline nodes costs 100–250.
 */
export const DAILY_OBJECTIVE_GOLD = 150;
export const DAILY_BONUS_GOLD = 150;

/** How many of each tier a day draws. Two core, one flavour — see dailySet. */
const CORE_PER_DAY = 2;
const FLAVOUR_PER_DAY = 1;

export const DAILY_POOL: readonly DailyObjectiveDef[] = [
  // Core: progresses on any map, with any character.
  { id: 'kills', tier: 'core', label: 'Slay 400 of them', target: 400, mode: 'sum' },
  { id: 'level', tier: 'core', label: 'Reach level 20', target: 20, mode: 'best' },
  { id: 'picks', tier: 'core', label: 'Take 12 upgrades', target: 12, mode: 'sum' },
  { id: 'gold', tier: 'core', label: 'Bank 400 gold', target: 400, mode: 'sum' },
  { id: 'survive', tier: 'core', label: 'Last ten minutes in one run', target: 600, mode: 'best' },
  // Flavour: mechanic-specific — these are what make a day feel different.
  { id: 'frenzy', tier: 'flavour', label: 'Enter Frenzy 5 times', target: 5, mode: 'sum' },
  { id: 'feast', tier: 'flavour', label: 'Feast back 200 health', target: 200, mode: 'sum' },
  { id: 'siege', tier: 'flavour', label: 'Repel 2 sieges', target: 2, mode: 'sum' },
  { id: 'evolve', tier: 'flavour', label: 'Awaken a weapon', target: 1, mode: 'sum' },
  {
    id: 'walls',
    tier: 'flavour',
    label: 'Hold the Bastion with every wall standing',
    target: 1,
    mode: 'best',
  },
];

const POOL_IDS: ReadonlySet<string> = new Set(DAILY_POOL.map((def) => def.id));

export function defaultDaily(): DailySave {
  return { day: 0, progress: {}, claimed: [], bonusClaimed: false };
}

export function dailyObjective(id: string): DailyObjectiveDef | null {
  return DAILY_POOL.find((def) => def.id === id) ?? null;
}

/** Fisher-Yates over a copy, driven by a seeded Rng so the order is replayable. */
function shuffled(items: readonly DailyObjectiveDef[], rng: Rng): DailyObjectiveDef[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const swap = out[i]!;
    out[i] = out[j]!;
    out[j] = swap;
  }
  return out;
}

/**
 * The three objectives for a day, derived from the day index alone.
 *
 * Deterministic, so the set is never persisted and can never drift out of sync
 * with the progress record. Adding a pool entry reshuffles future days, which
 * is fine — it does not corrupt anything stored.
 *
 * The tiers are shuffled separately, which is the whole reason `tier` exists:
 * a day is never all-blood or all-bastion, so a player who only wants to play
 * Moonlit Meadow can always clear two of three, and the third is the nudge.
 */
export function dailySet(day: number): DailyObjectiveDef[] {
  const rng = new Rng(day >>> 0);
  const core = shuffled(
    DAILY_POOL.filter((def) => def.tier === 'core'),
    rng,
  ).slice(0, CORE_PER_DAY);
  const flavour = shuffled(
    DAILY_POOL.filter((def) => def.tier === 'flavour'),
    rng,
  ).slice(0, FLAVOUR_PER_DAY);
  return [...core, ...flavour];
}

/**
 * Local day index: whole days since the epoch in the player's own timezone.
 *
 * Local rather than UTC on purpose — a player's "today" is the one on their
 * wall clock. `tzOffsetMinutes` follows Date#getTimezoneOffset (minutes *west*
 * of UTC) and is injectable so tests can fly the player between timezones
 * without touching the host clock.
 */
export function localDayIndex(
  now: number,
  tzOffsetMinutes: number = new Date(now).getTimezoneOffset(),
): number {
  return Math.floor((now - tzOffsetMinutes * 60_000) / DAY_MS);
}

/**
 * The monotonic floor, and it is the whole anti-cheat rule.
 *
 * A new set is granted only when the observed local day is *strictly above* the
 * stored one; the floor never descends.
 *
 * - **Clock forward to farm.** Jumping to day+1 grants one set immediately.
 *   Setting the clock back afterwards does nothing. To farm a third set the
 *   player must jump further forward, and every farmed set permanently raises
 *   their floor — so when they restore the real clock they get no dailies at
 *   all until real calendar time catches up. N farmed sets cost N real days of
 *   nothing. Self-limiting, self-punishing, no server required.
 * - **Clock backward.** Absorbed. Progress and claims untouched, no re-roll.
 * - **Honest timezone crossing.** Flying west can drop the observed index for
 *   the rest of that day; the floor swallows it and the player keeps the day
 *   they already had, advancing at their next local midnight. Flying east
 *   grants the next set a few hours early. The bounded cost to an honest
 *   traveller is at most one skipped set per westward flight — never a lost
 *   reward, never a reset bar. DST is a one-hour shift and cannot move a day
 *   index except across midnight, so it is a genuine non-event.
 *
 * Anything heavier — a signed server timestamp, an uptime accumulator, a
 * monotonic-clock shim — buys defence nobody needs for a soft currency in a
 * single-player game with no leaderboard, no PvP and no purchase path, and
 * costs the honest player real correctness. Proportionality is the argument.
 */
export function rolloverDaily(
  state: DailySave,
  now: number,
  tzOffsetMinutes?: number,
): { state: DailySave; rolled: boolean } {
  const observed = localDayIndex(now, tzOffsetMinutes);
  if (observed <= state.day) return { state, rolled: false };
  return {
    state: { day: observed, progress: {}, claimed: [], bonusClaimed: false },
    rolled: true,
  };
}

/** Per-run counters the Game accumulates from bus events while a run is open. */
export interface DailyRunTally {
  /** 'draft:picked' where kind is 'weapon' or 'passive'. */
  picks: number;
  /** 'blood:frenzy' count. */
  frenzy: number;
  /** Sum of 'blood:feast'.healed. */
  feastHealed: number;
  /** 'siege:defended' count. */
  sieges: number;
  /** 'weapon:evolved' count. */
  evolves: number;
}

/**
 * Subscribes the per-run tally to the bus and hands back readers for it.
 *
 * Lives here rather than in game.ts so the mapping from event vocabulary to
 * objective can be tested against a real EventBus: a renamed event or a moved
 * payload field fails a test instead of silently zeroing an objective forever.
 * Nothing new is emitted for the dailies — every signal below already existed.
 *
 * Attached once, for the life of the Game; `reset()` is what a new run calls.
 */
export interface DailyTally {
  /** The live tally. Valid until the next reset(). */
  tally: () => DailyRunTally;
  /** Zeroes it for a new run. */
  reset: () => void;
  /** Unsubscribes every handler (HMR dispose). */
  detach: () => void;
}

export function attachDailyTally(bus: EventBus<GameEvents>): DailyTally {
  let current = emptyTally();
  const offs = [
    bus.on('draft:picked', ({ kind }) => {
      // Heal and gold are consolation offers, not upgrades taken.
      if (kind === 'weapon' || kind === 'passive') current.picks++;
    }),
    bus.on('blood:frenzy', () => current.frenzy++),
    bus.on('blood:feast', ({ healed }) => {
      current.feastHealed += healed;
    }),
    bus.on('siege:defended', () => current.sieges++),
    bus.on('weapon:evolved', () => current.evolves++),
  ];
  return {
    tally: () => current,
    reset: () => {
      current = emptyTally();
    },
    detach: () => {
      for (const off of offs) off();
    },
  };
}

/** The 'run:ended' payload, as far as the dailies are concerned. */
export interface DailyRunSummary {
  kills: number;
  level: number;
  gold: number;
  survivedSeconds: number;
  structuresSpawned: number;
  structuresLost: number;
}

export function emptyTally(): DailyRunTally {
  return { picks: 0, frenzy: 0, feastHealed: 0, sieges: 0, evolves: 0 };
}

/**
 * One finished run, expressed as a contribution per objective id.
 *
 * Every pool id gets a key — a missing key and a zero would fold identically
 * for 'sum' but not for 'best', and an objective that silently never appears is
 * an objective that can never be completed.
 */
export function dailyDelta(
  tally: DailyRunTally,
  summary: DailyRunSummary,
): Record<string, number> {
  return {
    kills: summary.kills,
    level: summary.level,
    picks: tally.picks,
    gold: summary.gold,
    survive: summary.survivedSeconds,
    frenzy: tally.frenzy,
    feast: tally.feastHealed,
    siege: tally.sieges,
    evolve: tally.evolves,
    // Only a map that actually raised structures can hold them all.
    walls: summary.structuresSpawned > 0 && summary.structuresLost === 0 ? 1 : 0,
  };
}

export interface DailyPayout {
  /** Ids that completed on this fold, in set order. */
  completed: string[];
  /** Gold owed for those completions plus, if it closed, the all-three bonus. */
  gold: number;
}

/**
 * Folds one run's delta into the day's progress and settles what it earned.
 *
 * State is replaced, never mutated, in the same discipline MetaService uses —
 * a half-applied fold must never be persistable. Payout is scoped to today's
 * set: progress outside it is still recorded (so a set that comes back around
 * mid-day is not silently behind), but nothing off-set pays.
 */
export function foldDaily(
  state: DailySave,
  delta: Record<string, number>,
): { state: DailySave; completed: string[]; gold: number } {
  const progress: Record<string, number> = { ...state.progress };
  for (const [id, value] of Object.entries(delta)) {
    if (!POOL_IDS.has(id)) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    const def = dailyObjective(id)!;
    const current = progress[id] ?? 0;
    progress[id] = def.mode === 'sum' ? current + value : Math.max(current, value);
  }

  const set = dailySet(state.day);
  const claimed = new Set(state.claimed);
  const completed: string[] = [];
  for (const def of set) {
    if (claimed.has(def.id)) continue;
    if ((progress[def.id] ?? 0) < def.target) continue;
    claimed.add(def.id);
    completed.push(def.id);
  }

  let gold = completed.length * DAILY_OBJECTIVE_GOLD;
  const allDone = set.every((def) => claimed.has(def.id));
  const bonusClaimed = state.bonusClaimed || allDone;
  if (allDone && !state.bonusClaimed) gold += DAILY_BONUS_GOLD;

  return {
    state: { day: state.day, progress, claimed: [...claimed], bonusClaimed },
    completed,
    gold,
  };
}

/**
 * Coerces a persisted `daily` field of any vintage into a DailySave.
 *
 * Same defensive shape as the `sanctum` loop in migrate(): field by field, no
 * per-version branching, absent fields fall to defaults. Progress keys and
 * claimed ids are filtered against the known pool so a hand-edited save cannot
 * grow the record without bound.
 */
export function migrateDaily(raw: unknown): DailySave {
  const base = defaultDaily();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const rec = raw as Record<string, unknown>;

  const rawDay = rec['day'];
  const day =
    typeof rawDay === 'number' && Number.isInteger(rawDay) && rawDay >= 0 ? rawDay : base.day;

  const progress: Record<string, number> = {};
  const rawProgress = rec['progress'];
  if (typeof rawProgress === 'object' && rawProgress !== null && !Array.isArray(rawProgress)) {
    for (const [id, value] of Object.entries(rawProgress as Record<string, unknown>)) {
      if (!POOL_IDS.has(id)) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      progress[id] = value;
    }
  }

  const claimed: string[] = [];
  const rawClaimed = rec['claimed'];
  if (Array.isArray(rawClaimed)) {
    for (const id of rawClaimed as unknown[]) {
      if (typeof id !== 'string' || !POOL_IDS.has(id) || claimed.includes(id)) continue;
      claimed.push(id);
    }
  }

  return { day, progress, claimed, bonusClaimed: rec['bonusClaimed'] === true };
}
