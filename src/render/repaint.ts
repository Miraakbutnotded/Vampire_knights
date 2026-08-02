/**
 * Whether the frame in front of us has to be drawn at all.
 *
 * The world only advances in 'playing' and 'dying'; every other state freezes
 * the sim, the fx pool and the camera alike, so a repaint there would reproduce
 * the pixels already on the display canvas and the DOM screens draw themselves
 * over a still frame. Three things still force one: the state having just been
 * entered (the first frozen frame is a real frame and nobody has drawn it yet),
 * the renderer having lost the display canvas to a resize or a suspend, and —
 * implicitly — every frame of an active run.
 *
 * "Entered" is the load-bearing word, and it is why this is a latch rather than
 * a `state !== lastPainted` comparison. A chained level-up draft re-enters
 * 'levelup' without ever leaving it: the pick applied, the HUD's loadout strip,
 * HP bar and gold read-out all changed, and the next frame has to carry them.
 * Comparing state against state would call that frame a duplicate and freeze
 * the HUD behind the second draft until the whole chain ended.
 *
 * The type is `string` rather than Game's State union for the same reason
 * platform/lifecycle.ts takes one: this is a leaf that game.ts depends on, not
 * the other way round.
 */

/** The states in which update() advances the world, so every frame is new. */
export const ANIMATING_STATES: readonly string[] = ['playing', 'dying'];

export function isAnimating(state: string): boolean {
  return ANIMATING_STATES.includes(state);
}

export class FrameGate {
  private painted = false;

  /**
   * Called on every state entry, re-entry into the current state included.
   * Game.setState() is the single funnel that does it — see the source-scan
   * gate in repaint.test.ts.
   */
  enter(): void {
    this.painted = false;
  }

  /**
   * True when this frame must be drawn, and records that it was. Animating
   * states never latch; a renderer that wants a repaint overrides the latch
   * for exactly the one frame it asks for.
   */
  claim(state: string, needsRepaint: boolean): boolean {
    if (this.painted && !needsRepaint && !isAnimating(state)) return false;
    this.painted = true;
    return true;
  }
}
