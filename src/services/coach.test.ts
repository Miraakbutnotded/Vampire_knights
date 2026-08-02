import { describe, expect, it } from 'vitest';

import { EventBus } from '../core/events.ts';
import type { GameEvents } from '../core/events.ts';
import {
  COACH_CUES,
  COACH_GAP_SECONDS,
  COACH_POOL,
  COACH_QUEUE_MAX,
  CoachDirector,
  attachCoachCues,
  coachPrompt,
  defaultCoach,
  migrateCoach,
} from './coach.ts';
import type { CoachAction, CoachConditions, CoachStep } from './coach.ts';
import { SAVE_VERSION, decodeSave, encodeSave, migrate } from './save.ts';
import type { SaveData } from './save.ts';
import { defaultSave } from './save.ts';
import { MetaService } from './meta.ts';
import { MemoryStorageAdapter } from './storage.ts';

/** Nothing in the way: no menu up, no danger. The ordinary in-run frame. */
const CALM: CoachConditions = { occluded: false, pressed: false };

/** Advances the director by `seconds` in 1/60 steps, collecting every step. */
function advance(
  director: CoachDirector,
  seconds: number,
  conditions: CoachConditions = CALM,
): CoachStep[] {
  const steps: CoachStep[] = [];
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) steps.push(director.update(dt, conditions));
  return steps;
}

const shows = (steps: CoachStep[]): string[] =>
  steps.flatMap((s) => (s.action?.kind === 'show' ? [s.action.id] : []));

const hides = (steps: CoachStep[]): number =>
  steps.filter((s) => s.action?.kind === 'hide').length;

const seenIn = (steps: CoachStep[]): string[] => steps.flatMap((s) => [...s.seen]);

const shownText = (steps: CoachStep[]): string[] =>
  steps.flatMap((s) => (s.action?.kind === 'show' ? [s.action.text] : []));

describe('coach pool', () => {
  it('has unique ids and only ever names cues that exist', () => {
    const ids = COACH_POOL.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of COACH_POOL) {
      expect(COACH_CUES).toContain(def.cue);
      if (def.retiredBy !== undefined) expect(COACH_CUES).toContain(def.retiredBy);
      // A prompt retired by its own cue could never be shown.
      expect(def.retiredBy).not.toBe(def.cue);
    }
  });

  it('gives every prompt a readable line and a finite schedule', () => {
    for (const def of COACH_POOL) {
      expect(def.text.length).toBeGreaterThan(0);
      // One line at the bottom of the screen. A paragraph is an overlay by
      // another name, so the length is a gate, not a guideline.
      expect(def.text.length).toBeLessThanOrEqual(72);
      if (def.touchText !== undefined) expect(def.touchText.length).toBeLessThanOrEqual(72);
      expect(Number.isFinite(def.delay) && def.delay >= 0).toBe(true);
      expect(Number.isFinite(def.hold) && def.hold > 0).toBe(true);
    }
  });

  it('orders by distinct priorities, so two armed prompts never tie', () => {
    const priorities = COACH_POOL.map((def) => def.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('teaches the six things the first run cannot show on its own', () => {
    expect(COACH_POOL.map((def) => def.id)).toEqual([
      'move',
      'auto',
      'blood',
      'ability',
      'focus',
      'siege',
    ]);
    expect(coachPrompt('auto')?.cue).toBe('kill');
    expect(coachPrompt('move')?.retiredBy).toBe('moved');
    expect(coachPrompt('ability')?.retiredBy).toBe('cast');
    expect(coachPrompt('nonesuch')).toBeNull();
  });
});

describe('CoachDirector — arming and delay', () => {
  it('says nothing at all until a cue arms something', () => {
    const director = new CoachDirector([], false);
    expect(shows(advance(director, 30))).toEqual([]);
  });

  it('holds a newly armed prompt for its delay, then shows it once', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    const def = coachPrompt('auto')!;
    expect(shows(advance(director, def.delay - 0.1))).toEqual([]);
    expect(shows(advance(director, 0.3))).toEqual(['auto']);
    // Shown once and only once, however long the run goes on.
    expect(shows(advance(director, 120))).toEqual([]);
  });

  it('takes the line down when the hold expires, not before', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    const def = coachPrompt('auto')!;
    advance(director, def.delay + 0.05);
    expect(hides(advance(director, def.hold - 0.2))).toBe(0);
    expect(hides(advance(director, 0.4))).toBe(1);
  });

  it('ignores a cue no prompt waits on', () => {
    const director = new CoachDirector([], false);
    director.raise('moved');
    expect(shows(advance(director, 60))).toEqual([]);
  });
});

describe('CoachDirector — the noise rules', () => {
  /**
   * The whole point of the queue: a prompt that fires on top of another one is
   * an overlay, not a lesson. Cues raised together are spoken in turn.
   */
  it('shows one line at a time, never two, however many cues arrive at once', () => {
    const director = new CoachDirector([], false);
    director.raise('siege');
    director.raise('blood');
    director.raise('kill');
    const steps = advance(director, 60);
    // Every show is bracketed by its own hide: two lines are never up together.
    const sequence = steps.flatMap((s) => (s.action ? [s.action.kind] : []));
    expect(sequence).toEqual(['show', 'hide', 'show', 'hide', 'show', 'hide']);
    expect(shows(steps).sort()).toEqual(['auto', 'blood', 'siege']);
  });

  /**
   * Readiness first, priority only as the tie-break. A prompt still watching its
   * own delay run out holds no place in the queue, so a long-delayed lesson can
   * never starve one that is ready now.
   */
  it('speaks whichever prompt is ready, and uses priority only to break a tie', () => {
    const byReadiness = new CoachDirector([], false);
    byReadiness.raise('kill'); // priority 1, delay 0.8
    byReadiness.raise('blood'); // priority 2, delay 0.6 — ready sooner, so first
    expect(shows(advance(byReadiness, 5))).toEqual(['blood']);

    const byPriority = new CoachDirector([], false);
    byPriority.raise('kill'); // priority 1
    byPriority.raise('siege'); // priority 5, delay 3.4
    // Both ready by 3.4s, so the tie falls to priority.
    expect(shows(advance(byPriority, 5))).toEqual(['auto']);
  });

  it('leaves a gap of silence between consecutive lines', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    director.raise('blood');
    const steps = advance(director, 60);
    const hideAt = steps.findIndex((s) => s.action?.kind === 'hide');
    const nextShowAt = steps.findIndex(
      (s, i) => i > hideAt && s.action?.kind === 'show',
    );
    const gapSeconds = (nextShowAt - hideAt) / 60;
    expect(gapSeconds).toBeGreaterThanOrEqual(COACH_GAP_SECONDS);
    // And the second prompt's own delay is not double-counted into the gap.
    expect(gapSeconds).toBeLessThan(COACH_GAP_SECONDS + coachPrompt('blood')!.delay + 0.5);
  });

  /**
   * A level-up draft, the pause screen and the Sanctum all cover the HUD strip.
   * A line whose hold burns down behind a modal was never read, so time stops.
   */
  it('freezes entirely while a menu covers the strip', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    const def = coachPrompt('auto')!;
    advance(director, def.delay + 0.05);

    const occluded: CoachConditions = { occluded: true, pressed: false };
    expect(hides(advance(director, 60, occluded))).toBe(0);
    // The line is still there, with its hold intact, once the menu closes.
    expect(hides(advance(director, def.hold - 0.3))).toBe(0);
    expect(hides(advance(director, 0.5))).toBe(1);
  });

  it('never starts a line behind a menu', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    expect(shows(advance(director, 60, { occluded: true, pressed: false }))).toEqual([]);
    expect(shows(advance(director, 5))).toEqual(['auto']);
  });

  /**
   * Low health is the one moment when reading anything is actively wrong. The
   * prompt defers — it is never dropped, because the lesson is still owed.
   */
  it('defers while the player is under pressure, and never drops the lesson', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    const pressed: CoachConditions = { occluded: false, pressed: true };
    expect(shows(advance(director, 120, pressed))).toEqual([]);
    expect(shows(advance(director, 5))).toEqual(['auto']);
  });

  it('does not yank a line off the screen the moment danger starts', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    const def = coachPrompt('auto')!;
    advance(director, def.delay + 0.05);
    const pressed: CoachConditions = { occluded: false, pressed: true };
    // Already readable when the fight turns: it runs its hold out normally.
    expect(hides(advance(director, def.hold - 0.3, pressed))).toBe(0);
    expect(hides(advance(director, 0.5, pressed))).toBe(1);
  });

  it('bounds the queue, so a cue storm cannot grow it without limit', () => {
    const director = new CoachDirector([], false);
    for (let i = 0; i < 500; i++) {
      director.raise('kill');
      director.raise('blood');
      director.raise('siege');
      director.raise('levelup');
    }
    expect(director.pending).toBeLessThanOrEqual(COACH_QUEUE_MAX);
    // Each distinct cue still arms exactly one prompt: the bound is a ceiling,
    // not a dropped lesson.
    expect(director.pending).toBe(4);
  });
});

describe('CoachDirector — retirement on evidence', () => {
  it('never explains moving to a player who already moved', () => {
    const director = new CoachDirector([], false);
    director.raise('start');
    // The very first frame of input is proof enough.
    director.raise('moved');
    const steps = advance(director, 60);
    expect(shows(steps)).toEqual([]);
    // Retired, not forgotten: it is marked seen so it cannot come back next run.
    expect(seenIn(steps)).toEqual(['move']);
  });

  it('does explain moving to a player who sits still', () => {
    const director = new CoachDirector([], false);
    director.raise('start');
    expect(shows(advance(director, 5))).toEqual(['move']);
  });

  it('takes the line down the moment the player proves they understood', () => {
    const director = new CoachDirector([], false);
    director.raise('start');
    const def = coachPrompt('move')!;
    advance(director, def.delay + 0.05);
    director.raise('moved');
    // Down on the next frame, not after the full hold.
    expect(hides(advance(director, 0.05))).toBe(1);
    expect(hides(advance(director, def.hold))).toBe(0);
  });

  it('reports a prompt seen exactly once, whether it was shown or retired', () => {
    const shown = new CoachDirector([], false);
    shown.raise('start');
    expect(seenIn(advance(shown, 60))).toEqual(['move']);

    const retired = new CoachDirector([], false);
    retired.raise('start');
    const early = advance(retired, 0.5);
    retired.raise('moved');
    expect(seenIn([...early, ...advance(retired, 60)])).toEqual(['move']);
  });

  it('does not re-report a prompt that was retired while it was on screen', () => {
    const director = new CoachDirector([], false);
    director.raise('start');
    const first = advance(director, coachPrompt('move')!.delay + 0.05);
    director.raise('moved');
    expect(seenIn([...first, ...advance(director, 60)])).toEqual(['move']);
  });
});

describe('CoachDirector — seen once, forever', () => {
  it('stays silent about anything the save says was already seen', () => {
    const director = new CoachDirector(COACH_POOL.map((def) => def.id), false);
    for (const cue of COACH_CUES) director.raise(cue);
    const steps = advance(director, 300);
    expect(shows(steps)).toEqual([]);
    expect(seenIn(steps)).toEqual([]);
  });

  it('ignores ids in the save that are not prompts any more', () => {
    const director = new CoachDirector(['ghost-of-a-removed-prompt'], false);
    director.raise('kill');
    expect(shows(advance(director, 5))).toEqual(['auto']);
  });

  it('carries seen ids across runs but forgets the run-scoped schedule', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    expect(shows(advance(director, 5))).toEqual(['auto']);
    director.raise('blood');

    // A new run starts while 'blood' is still queued and 'auto' still on screen.
    director.beginRun();
    expect(hides(advance(director, 60))).toBe(0);
    expect(shows(advance(director, 60))).toEqual([]);

    // 'auto' was already spoken; 'blood' was never spoken, so it is still owed.
    director.raise('kill');
    director.raise('blood');
    expect(shows(advance(director, 10))).toEqual(['blood']);
  });
});

describe('CoachDirector — platform wording', () => {
  it('speaks about keys on a keyboard and about the screen on a touch device', () => {
    const keyboard = new CoachDirector([], false);
    keyboard.raise('start');
    const keyLine = shownText(advance(keyboard, 5))[0]!;

    const touch = new CoachDirector([], true);
    touch.raise('start');
    const touchLine = shownText(advance(touch, 5))[0]!;

    expect(keyLine).not.toBe(touchLine);
    expect(keyLine).toMatch(/WASD|arrow/i);
    expect(touchLine).not.toMatch(/WASD/i);
    expect(touchLine).toMatch(/drag/i);
  });

  it('falls back to the shared line when a prompt has no touch wording', () => {
    const keyboard = new CoachDirector([], false);
    const touch = new CoachDirector([], true);
    keyboard.raise('kill');
    touch.raise('kill');
    expect(shownText(advance(touch, 5))).toEqual(shownText(advance(keyboard, 5)));
  });
});

describe('attachCoachCues — the real bus signals, not a paraphrase of them', () => {
  /**
   * Lives beside the pool rather than in game.ts for the reason attachDailyTally
   * does: a renamed event or a moved payload field fails here instead of
   * silently muting a lesson forever.
   */
  it('maps each gameplay signal onto the prompt it arms', () => {
    const cases: { emit: () => void; expected: string }[] = [];
    const make = (): { bus: EventBus<GameEvents>; director: CoachDirector } => {
      const bus = new EventBus<GameEvents>();
      const director = new CoachDirector([], false);
      attachCoachCues(bus, director);
      return { bus, director };
    };

    const kill = make();
    cases.push({
      emit: () => kill.bus.emit('enemy:killed', { x: 0, y: 0, kills: 1 }),
      expected: 'auto',
    });
    const blood = make();
    cases.push({ emit: () => blood.bus.emit('blood:ready', undefined), expected: 'blood' });
    const level = make();
    cases.push({ emit: () => level.bus.emit('player:levelup', { level: 2 }), expected: 'focus' });
    const siege = make();
    cases.push({ emit: () => siege.bus.emit('siege:started', { duration: 30 }), expected: 'siege' });

    for (const [i, entry] of cases.entries()) {
      const director = [kill, blood, level, siege][i]!.director;
      entry.emit();
      expect(shows(advance(director, 15))).toEqual([entry.expected]);
    }
  });

  it('treats a cast ability as proof the player found the button', () => {
    const bus = new EventBus<GameEvents>();
    const director = new CoachDirector([], false);
    attachCoachCues(bus, director);
    director.raise('ability');
    bus.emit('ability:used', { name: 'Crimson Nova', kind: 'nova', cooldown: 12 });
    const steps = advance(director, 60);
    expect(shows(steps)).toEqual([]);
    expect(seenIn(steps)).toEqual(['ability']);
  });

  it('detaches cleanly, so a torn-down game cannot keep coaching', () => {
    const bus = new EventBus<GameEvents>();
    const director = new CoachDirector([], false);
    attachCoachCues(bus, director).detach();
    bus.emit('enemy:killed', { x: 0, y: 0, kills: 1 });
    expect(shows(advance(director, 30))).toEqual([]);
  });
});

describe('the first ninety seconds, end to end', () => {
  /**
   * The shape of a real opening: the player grabs the stick at once, kills
   * something, fills the orb, levels up — and never casts. Four lines land, one
   * at a time, none on top of another, and the last is done inside ninety
   * seconds. The fifth was retired the moment they moved.
   */
  it('teaches a first-time player without ever stacking two lines', () => {
    const bus = new EventBus<GameEvents>();
    const director = new CoachDirector([], false);
    attachCoachCues(bus, director);

    director.beginRun();
    director.raise('start');
    director.raise('ability');
    director.raise('moved'); // they picked up the stick immediately

    const steps: CoachStep[] = [];
    let open = 0;
    let maxOpen = 0;
    let elapsed = 0;
    let lastShowAt = 0;
    const tick = (seconds: number): void => {
      for (const step of advance(director, seconds)) {
        elapsed += 1 / 60;
        steps.push(step);
        if (step.action?.kind === 'show') {
          open++;
          lastShowAt = elapsed;
        }
        if (step.action?.kind === 'hide') open--;
        maxOpen = Math.max(maxOpen, open);
      }
    };

    tick(3);
    bus.emit('enemy:killed', { x: 0, y: 0, kills: 1 });
    tick(20);
    bus.emit('blood:ready', undefined);
    tick(20);
    bus.emit('player:levelup', { level: 2 });
    tick(45);

    expect(maxOpen).toBe(1);
    expect(shows(steps)).toEqual(['auto', 'ability', 'blood', 'focus']);
    // 'move' was retired unspoken; every other lesson was paid out.
    expect(seenIn(steps)).toEqual(['move', 'auto', 'ability', 'blood', 'focus']);
    expect(director.pending).toBe(0);
    expect(lastShowAt).toBeLessThan(90);
  });

  it('goes completely silent on the second run', () => {
    const seen = COACH_POOL.map((def) => def.id);
    const bus = new EventBus<GameEvents>();
    const director = new CoachDirector(seen, false);
    attachCoachCues(bus, director);
    director.beginRun();
    director.raise('start');
    director.raise('ability');
    bus.emit('enemy:killed', { x: 0, y: 0, kills: 1 });
    bus.emit('blood:ready', undefined);
    bus.emit('player:levelup', { level: 2 });
    bus.emit('siege:started', { duration: 30 });
    const steps = advance(director, 300);
    expect(steps.every((s) => s.action === null && s.seen.length === 0)).toBe(true);
    expect(director.pending).toBe(0);
  });
});

describe('migrateCoach', () => {
  it('falls to defaults for anything that is not a record', () => {
    for (const junk of [undefined, null, 7, 'seen', [], true]) {
      expect(migrateCoach(junk)).toEqual(defaultCoach());
    }
  });

  it('filters seen ids to the known pool and collapses duplicates', () => {
    expect(migrateCoach({ seen: ['auto', 'auto', 'nope', 5, null, 'blood'] })).toEqual({
      seen: ['auto', 'blood'],
    });
  });

  it('accepts a record with no seen list at all', () => {
    expect(migrateCoach({})).toEqual(defaultCoach());
    expect(migrateCoach({ seen: 'auto' })).toEqual(defaultCoach());
  });
});

describe('coach persistence', () => {
  it('round-trips through the save codec', () => {
    const data: SaveData = { ...defaultSave(), coach: { seen: ['move', 'auto'] } };
    expect(decodeSave(encodeSave(data))).toEqual(data);
  });

  /** The encodeSave trap again: a field on SaveData missing from the literal. */
  it('writes coach into the encoded payload rather than dropping it', () => {
    const data: SaveData = { ...defaultSave(), coach: { seen: ['blood'] } };
    const payload = JSON.parse(JSON.parse(encodeSave(data)).payload as string) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual(Object.keys(data).sort());
    expect(payload['coach']).toEqual(data.coach);
  });

  it('migrates a real v2 save forward, adopting an empty coach record', () => {
    const v2 = {
      version: 2,
      gold: 900,
      unlockedCharacters: [],
      sanctum: {},
      daily: { day: 20447, progress: { kills: 5 }, claimed: [], bonusClaimed: false },
    };
    const migrated = migrate(v2)!;
    expect(migrated.version).toBe(SAVE_VERSION);
    expect(migrated.coach).toEqual(defaultCoach());
    expect(migrated.daily.day).toBe(20447);
  });

  it('records a prompt as seen, once, and keeps it across a reload', async () => {
    const adapter = new MemoryStorageAdapter();
    const meta = new MetaService(adapter);
    await meta.load();
    expect(meta.coachState.seen).toEqual([]);

    meta.markCoachSeen('auto');
    meta.markCoachSeen('auto');
    meta.markCoachSeen('blood');
    expect(meta.coachState.seen).toEqual(['auto', 'blood']);
    await meta.flush();

    const reloaded = new MetaService(adapter);
    await reloaded.load();
    expect(reloaded.coachState.seen).toEqual(['auto', 'blood']);
  });

  it('refuses to store an id that is not a prompt', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.markCoachSeen('not-a-prompt');
    expect(meta.coachState.seen).toEqual([]);
  });

  it('never mutates the record it replaces', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    const before = meta.coachState;
    meta.markCoachSeen('auto');
    expect(before.seen).toEqual([]);
    expect(meta.coachState).not.toBe(before);
  });
});

describe('the action vocabulary', () => {
  it('never emits a show and a hide in the same step', () => {
    const director = new CoachDirector([], false);
    director.raise('kill');
    director.raise('blood');
    director.raise('siege');
    for (const step of advance(director, 90)) {
      const action: CoachAction | null = step.action;
      if (action === null) continue;
      expect(action.kind === 'show' || action.kind === 'hide').toBe(true);
    }
  });
});
