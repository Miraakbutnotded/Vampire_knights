import type { EventBus, GameEvents } from '../core/events.ts';

/**
 * The coach: the six things a first run cannot show on its own.
 *
 * Pure, in the same sense daily.ts is pure — plain data, no storage, no DOM, no
 * clock. Everything it needs arrives as arguments, so the whole schedule ("which
 * line, when, and has it been said before") is decided headlessly and tested.
 * game.ts owns the wiring; hud.ts owns the one strip of DOM it writes into.
 *
 * The design constraint that shapes every rule below: **a prompt that fires
 * mid-fight and covers the screen is worse than no prompt.** So a line is one
 * short sentence in a reserved strip, never a modal; only one is ever on screen;
 * a gap of silence separates them; a menu freezes the schedule outright; danger
 * defers it; and a lesson the player has already demonstrated is retired without
 * ever being spoken. Anything the game already teaches — the key hints printed
 * on the title, draft, pause and Sanctum screens, the FEAST/Q and FRENZY/E
 * labels under the blood orb, the boss and siege banners — is deliberately
 * absent from the pool. The coach only says what nothing else says.
 */

/**
 * Everything that can arm or retire a prompt.
 *
 * 'start', 'moved' and 'ability' come from game.ts (run lifecycle, input axis,
 * and whether this character even has a power). The rest come off the event bus
 * through attachCoachCues below.
 */
export const COACH_CUES = [
  'start',
  'moved',
  'kill',
  'blood',
  'ability',
  'cast',
  'levelup',
  'siege',
] as const;

export type CoachCue = (typeof COACH_CUES)[number];

export interface CoachPromptDef {
  id: string;
  /** The signal that arms it. */
  cue: CoachCue;
  /**
   * A signal that retires it unspoken: proof the player already knows. The
   * quietest possible prompt is the one that never had to be shown.
   */
  retiredBy?: CoachCue;
  /** Lower goes first when several are waiting. Distinct across the pool. */
  priority: number;
  /** Seconds between arming and speaking — long enough to watch the thing happen. */
  delay: number;
  /** Seconds on screen. */
  hold: number;
  text: string;
  /** Wording for a touch device, where there are no keys to name. */
  touchText?: string;
}

/** The persisted half. Owned by SaveData; migrated by migrateCoach below. */
export interface CoachSave {
  /** Prompt ids already spoken or retired. Always pool ids. */
  seen: string[];
}

/** Silence after a line comes down, before the next one may start. */
export const COACH_GAP_SECONDS = 4;

/**
 * Ceiling on prompts waiting to be spoken. Unreachable with a pool this size —
 * it exists so a cue raised every frame (the movement check is one) can never
 * grow the queue, however the wiring above changes.
 */
export const COACH_QUEUE_MAX = 8;

export const COACH_POOL: readonly CoachPromptDef[] = [
  {
    // The title screen prints the keys, but nothing prints the touch gesture,
    // and a first-timer reads neither. Retired by the first frame of input, so
    // in practice only a player who is genuinely stuck ever sees it.
    id: 'move',
    cue: 'start',
    retiredBy: 'moved',
    priority: 0,
    delay: 1.6,
    hold: 5,
    text: 'WASD or the arrow keys to move.',
    touchText: 'Drag the left of the screen to move.',
  },
  {
    // The genre's one genuinely counter-intuitive rule. A newcomer spends the
    // first minute hunting for an attack button; this is the line that stops it.
    id: 'auto',
    cue: 'kill',
    priority: 1,
    delay: 0.8,
    hold: 5,
    text: 'Your weapons swing themselves. All you choose is where to stand.',
  },
  {
    // The buttons under the orb already show FEAST/Q and FRENZY/E. What they do
    // not show is which one is the heal.
    id: 'blood',
    cue: 'blood',
    priority: 2,
    delay: 0.6,
    hold: 6,
    text: 'Orb full. FEAST turns blood into health, FRENZY into slaughter.',
  },
  {
    // Armed from startRun only when the character actually has a power, and
    // retired the moment one is cast. The key is printed nowhere else.
    id: 'ability',
    cue: 'ability',
    retiredBy: 'cast',
    priority: 3,
    delay: 6,
    hold: 5,
    text: 'SPACE calls the power your knight was born with.',
    touchText: 'The sigil by your blood orb calls your knight’s own power.',
  },
  {
    // The draft screen explains how to pick. It cannot explain what to pick,
    // and spreading thin is the mistake that ends a first run.
    id: 'focus',
    cue: 'levelup',
    priority: 4,
    delay: 0.6,
    hold: 6,
    text: 'One weapon carried to its limit beats five kept half-fed.',
  },
  {
    // The banner already shouts DEFEND THE BASTION. It does not say for how
    // long, or that surviving it pays. Delayed past the banner's own three
    // seconds so the two never share the screen.
    id: 'siege',
    cue: 'siege',
    priority: 5,
    delay: 3.4,
    hold: 6,
    text: 'Hold them off the walls until it breaks. Breaking a siege pays.',
  },
];

const POOL_IDS: ReadonlySet<string> = new Set(COACH_POOL.map((def) => def.id));

export function defaultCoach(): CoachSave {
  return { seen: [] };
}

export function coachPrompt(id: string): CoachPromptDef | null {
  return COACH_POOL.find((def) => def.id === id) ?? null;
}

/** What the HUD should do with its one strip this frame. */
export type CoachAction = { kind: 'show'; id: string; text: string } | { kind: 'hide' };

export interface CoachConditions {
  /**
   * A full-screen menu is up — draft, pause, Sanctum. The strip is not visible,
   * so the schedule stops dead rather than burning a hold nobody can read.
   */
  occluded: boolean;
  /**
   * The player is under enough pressure that a new line would be noise. Blocks
   * starting one; deliberately does not cut short one already being read.
   */
  pressed: boolean;
}

export interface CoachStep {
  /** The DOM change to apply, or null for "nothing happened". */
  action: CoachAction | null;
  /** Ids that became permanently seen this step. Persist them. */
  seen: readonly string[];
}

/** Shared so the common "nothing happened" step allocates nothing. */
const NO_SEEN: readonly string[] = Object.freeze([]);
const IDLE: CoachStep = Object.freeze({ action: null, seen: NO_SEEN });

interface ArmedPrompt {
  def: CoachPromptDef;
  /** Counts down to zero, at which point the prompt becomes eligible. */
  delay: number;
}

/**
 * Decides which line to speak and when. One instance per Game, constructed from
 * the persisted seen-list; `beginRun()` clears the run-scoped schedule and keeps
 * the seen-list, which is what makes the second run silent.
 */
export class CoachDirector {
  private readonly seen: Set<string>;
  private armed: ArmedPrompt[] = [];
  private visible: CoachPromptDef | null = null;
  private hold = 0;
  private gap = 0;
  /** Ids that became seen since the last update() drained them. */
  private freshlySeen: string[] = [];

  constructor(seen: Iterable<string>, private readonly touch: boolean) {
    // Filtered on the way in, the same way migrateCoach filters on the way out:
    // an id from a removed prompt must not keep a live prompt company forever.
    this.seen = new Set([...seen].filter((id) => POOL_IDS.has(id)));
  }

  /** How many prompts are waiting to be spoken. Tests and the debug overlay. */
  get pending(): number {
    return this.armed.length;
  }

  /**
   * Clears the run-scoped schedule. The seen-list survives, because a lesson is
   * learned once and not once per run.
   */
  beginRun(): void {
    this.armed = [];
    this.visible = null;
    this.hold = 0;
    this.gap = 0;
    this.freshlySeen = [];
  }

  /**
   * A signal happened. Arms whatever waits on it and retires whatever it
   * disproves. Cheap and idempotent, so a caller may raise the same cue every
   * frame — the movement check does exactly that.
   */
  raise(cue: CoachCue): void {
    for (const def of COACH_POOL) {
      // Retirement is tested before the seen-guard on purpose: a prompt is
      // marked seen the instant it appears, so a guard here would make the
      // line on screen the one thing the player's own proof could not take
      // down — exactly the case retirement exists for.
      if (def.retiredBy === cue) {
        this.retire(def);
        continue;
      }
      if (this.seen.has(def.id)) continue;
      if (def.cue !== cue) continue;
      if (this.visible?.id === def.id) continue;
      if (this.armed.some((entry) => entry.def.id === def.id)) continue;
      if (this.armed.length >= COACH_QUEUE_MAX) continue;
      this.armed.push({ def, delay: def.delay });
    }
  }

  /**
   * Advances the schedule by one frame and returns what the HUD should do.
   *
   * Frame time, not simulation time: this describes reading, not physics, and
   * it has to keep working on a frame where the sim ticked zero times.
   */
  update(dt: number, conditions: CoachConditions): CoachStep {
    // A menu covers the strip: nothing ticks, nothing starts, nothing ends. A
    // line shown half a second before a level-up is still fully readable after
    // the draft closes.
    if (conditions.occluded) return this.drain(null);

    for (const entry of this.armed) entry.delay = Math.max(0, entry.delay - dt);

    if (this.visible) {
      this.hold -= dt;
      if (this.hold > 0) return this.drain(null);
      this.visible = null;
      this.gap = COACH_GAP_SECONDS;
      return this.drain({ kind: 'hide' });
    }

    if (this.gap > 0) {
      this.gap = Math.max(0, this.gap - dt);
      return this.drain(null);
    }
    // Deferred, never dropped: the prompt stays armed and speaks once the
    // pressure lifts.
    if (conditions.pressed) return this.drain(null);

    const next = this.takeEligible();
    if (!next) return this.drain(null);

    this.visible = next;
    this.hold = next.hold;
    // Marked seen on show rather than on hide, so quitting mid-line does not
    // buy the lesson a second airing.
    this.markSeen(next.id);
    return this.drain({ kind: 'show', id: next.id, text: this.textFor(next) });
  }

  /**
   * Lowest priority among prompts whose delay has run out, removed from the queue.
   *
   * Readiness first, priority only to break the tie. Priority does not reserve a
   * place in the queue, so a prompt with a long delay can never starve one that
   * is ready now — and in play the cues arrive far enough apart that the tie is
   * hypothetical anyway.
   */
  private takeEligible(): CoachPromptDef | null {
    let bestIndex = -1;
    for (let i = 0; i < this.armed.length; i++) {
      const entry = this.armed[i]!;
      if (entry.delay > 0) continue;
      if (bestIndex >= 0 && entry.def.priority >= this.armed[bestIndex]!.def.priority) continue;
      bestIndex = i;
    }
    if (bestIndex < 0) return null;
    const [taken] = this.armed.splice(bestIndex, 1);
    return taken!.def;
  }

  /**
   * The player proved they already know. Drops it from the queue and, if it is
   * the line currently on screen, expires it on the next frame — no jarring
   * mid-frame teardown, just a hold that has run out.
   */
  private retire(def: CoachPromptDef): void {
    if (this.visible?.id === def.id) this.hold = 0;
    // Guarded rather than unconditional because 'moved' is raised on every
    // frame the stick is off centre: the steady state has to be free.
    if (this.armed.some((entry) => entry.def.id === def.id)) {
      this.armed = this.armed.filter((entry) => entry.def.id !== def.id);
    }
    this.markSeen(def.id);
  }

  private markSeen(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.freshlySeen.push(id);
  }

  private textFor(def: CoachPromptDef): string {
    return this.touch ? (def.touchText ?? def.text) : def.text;
  }

  private drain(action: CoachAction | null): CoachStep {
    if (this.freshlySeen.length === 0) return action === null ? IDLE : { action, seen: NO_SEEN };
    const seen = this.freshlySeen;
    this.freshlySeen = [];
    return { action, seen };
  }
}

export interface CoachCueBinding {
  /** Unsubscribes every handler (HMR dispose). */
  detach: () => void;
}

/**
 * Wires the bus vocabulary to the cues.
 *
 * Lives beside the pool rather than in game.ts for the reason attachDailyTally
 * does: a renamed event or a moved payload field fails a test here instead of
 * silently muting a lesson forever. Nothing new is emitted for the coach —
 * every signal below already existed.
 */
export function attachCoachCues(
  bus: EventBus<GameEvents>,
  director: CoachDirector,
): CoachCueBinding {
  const offs = [
    // The first kill is also the first proof that a weapon fired on its own.
    bus.on('enemy:killed', () => director.raise('kill')),
    bus.on('blood:ready', () => director.raise('blood')),
    // Casting one is proof the button was found; the prompt retires unspoken.
    bus.on('ability:used', () => director.raise('cast')),
    bus.on('player:levelup', () => director.raise('levelup')),
    bus.on('siege:started', () => director.raise('siege')),
  ];
  return {
    detach: () => {
      for (const off of offs) off();
    },
  };
}

/**
 * Coerces a persisted `coach` field of any vintage into a CoachSave.
 *
 * Same defensive shape as migrateDaily and the `sanctum` loop before it: field
 * by field, no per-version branching, absent fields fall to defaults. Ids are
 * filtered against the known pool and de-duplicated so a hand-edited save cannot
 * grow the record without bound.
 */
export function migrateCoach(raw: unknown): CoachSave {
  const base = defaultCoach();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const rec = raw as Record<string, unknown>;

  const rawSeen = rec['seen'];
  if (!Array.isArray(rawSeen)) return base;

  const seen: string[] = [];
  for (const id of rawSeen as unknown[]) {
    if (typeof id !== 'string' || !POOL_IDS.has(id) || seen.includes(id)) continue;
    seen.push(id);
  }
  return { seen };
}
