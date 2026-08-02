import { describe, expect, it } from 'vitest';

import { ANIMATING_STATES, FrameGate, isAnimating } from './repaint.ts';

// game.ts needs a browser, so the state walk below drives the gate directly and
// a source scan holds the one thing the walk cannot see: that game.ts really
// does route every entry through setState. Read as raw text — import.meta.glob
// is not a specifier position, so this does not trip the engine isolation gate.
const gameSource = (
  import.meta.glob(['../game.ts'], { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >
)['../game.ts']!;

/** The State union, read out of game.ts so the two can never drift apart. */
const STATES: string[] = Array.from(
  gameSource.match(/type State =([^;]+);/)![1]!.matchAll(/'([a-z]+)'/g),
  (m) => m[1]!,
);

/** A gate driven the way Game drives it: setState enters, render claims. */
function driver(state: string): {
  enter: (next: string) => void;
  frames: (count: number, needsRepaint?: boolean) => number;
} {
  const gate = new FrameGate();
  let current = state;
  return {
    enter: (next: string) => {
      current = next;
      gate.enter();
    },
    frames: (count: number, needsRepaint = false) => {
      let painted = 0;
      for (let i = 0; i < count; i++) if (gate.claim(current, needsRepaint)) painted++;
      return painted;
    },
  };
}

describe('frame gate', () => {
  it('covers every state the game can be in', () => {
    expect(STATES).toEqual([
      'title',
      'loading',
      'playing',
      'levelup',
      'paused',
      'dying',
      'results',
      'sanctum',
    ]);
  });

  it('paints the first frame of a run before anything has entered a state', () => {
    // The gate starts unlatched: boot must not leave the canvas blank.
    expect(driver('title').frames(1)).toBe(1);
  });

  it('draws a frozen state exactly once per entry, from every other state', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        if (isAnimating(to)) continue;
        const d = driver(from);
        d.frames(3); // settle wherever we started
        d.enter(to);
        expect(d.frames(60), `${from} -> ${to}`).toBe(1);
      }
    }
  });

  it('draws every frame of an animating state', () => {
    for (const state of ANIMATING_STATES) {
      const d = driver('title');
      d.frames(5);
      d.enter(state);
      expect(d.frames(60), state).toBe(60);
    }
  });

  it('draws a frame for a state re-entered without leaving it', () => {
    // The chained level-up draft: applyOffer runs, pendingLevelUps is still
    // positive, openLevelUp re-enters 'levelup'. The HUD's loadout strip, HP
    // bar and gold read-out all just changed, so that frame is not a duplicate.
    const d = driver('playing');
    d.enter('levelup');
    expect(d.frames(10)).toBe(1);
    d.enter('levelup');
    expect(d.frames(10)).toBe(1);
    d.enter('levelup');
    expect(d.frames(10)).toBe(1);
  });

  it('repaints once when the renderer loses the display canvas, then latches again', () => {
    const d = driver('paused');
    expect(d.frames(10)).toBe(1); // the entry frame
    // A resize or a visibility change while the game is frozen.
    expect(d.frames(1, true)).toBe(1);
    expect(d.frames(10)).toBe(0);
  });

  it('keeps painting through a resize in an animating state', () => {
    const d = driver('playing');
    expect(d.frames(4, true)).toBe(4);
  });

  it('walks a whole session — title to results — painting one frame per entry', () => {
    // Boot, browse, run, take two chained level-ups, pause, resume, die, settle.
    const d = driver('title');
    let painted = d.frames(30); // 1: the title
    for (const step of ['sanctum', 'title', 'loading'] as const) {
      d.enter(step);
      painted += d.frames(30); // 3
    }
    d.enter('playing');
    painted += d.frames(30); // 30 — the run itself
    for (const step of ['levelup', 'levelup', 'playing'] as const) {
      d.enter(step);
      painted += d.frames(step === 'playing' ? 1 : 30); // 1 + 1 + 1
    }
    d.enter('paused');
    painted += d.frames(30); // 1
    d.enter('playing');
    painted += d.frames(1); // 1
    d.enter('dying');
    painted += d.frames(20); // 20
    d.enter('results');
    painted += d.frames(30); // 1
    expect(painted).toBe(1 + 3 + 30 + 3 + 1 + 1 + 20 + 1);
  });
});

describe('game.ts state funnel', () => {
  it('assigns this.state in exactly one place, and that place enters the gate', () => {
    // Assignments only: the lookahead drops the `this.state === 'paused'`
    // comparisons, which are free to appear anywhere.
    const assignments = gameSource.match(/this\.state\s*=(?!=)/g) ?? [];
    expect(assignments.length, 'this.state must only be assigned by setState').toBe(1);
    expect(gameSource).toMatch(
      /private setState\(next: State\): void \{\s*this\.state = next;\s*this\.frame\.enter\(\);/,
    );
  });

  it('enters every state in the union through that funnel', () => {
    for (const state of STATES) {
      expect(gameSource, `${state} must be entered through setState`).toContain(
        `this.setState('${state}')`,
      );
    }
  });

  it('gates render on the frame gate rather than on a state comparison', () => {
    expect(gameSource).toContain('this.frame.claim(this.state, this.renderer.needsRepaint)');
  });
});
