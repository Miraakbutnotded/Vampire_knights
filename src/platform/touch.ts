import type { Input } from '../core/input.ts';

import { joystickVector, nubOffset } from './joystick.ts';

/** Neutral zone around the anchor, CSS px — small flicks shouldn't move. */
const DEADZONE_PX = 10;

/**
 * Floating virtual joystick + pause button, DOM-over-canvas like all UI.
 *
 * Left half of the play area: the first touch anchors the joystick base under
 * the thumb; dragging yields a unit direction. Right-thumb taps (ability,
 * Feast/Frenzy, pause) are ordinary DOM buttons — the HUD already owns the
 * ability/blood buttons, this layer adds only the joystick and pause.
 *
 * Ownership: the joystick tracks its Touch.identifier, so a second finger on
 * a button can never steal or recenter the stick, and the stick never eats
 * button taps (they happen outside the left zone).
 *
 * Feeds Input through its two seams and nothing else: implements AxisSource
 * ({axisX, axisY}, read in Input.beginFrame ahead of normalize) and calls
 * injectPress('Escape') for pause — so ordering, consumption and menu
 * semantics are byte-identical to keyboard play.
 */
export class TouchControls {
  axisX = 0;
  axisY = 0;

  readonly root: HTMLElement;

  private joyId: number | null = null;
  private baseX = 0;
  private baseY = 0;
  private clampRadius = 48;
  private enabled = false;

  private readonly zone: HTMLElement;
  private readonly base: HTMLElement;
  private readonly nub: HTMLElement;
  private readonly detach: () => void;

  constructor(private readonly input: Input) {
    this.root = document.createElement('div');
    // Seeded `disabled` to match `enabled = false`: setEnabled short-circuits on
    // an unchanged value, so Game's first `setEnabled(false)` on the title
    // screen is a no-op and would leave a live capture zone over the menus.
    this.root.className = 'touch-layer disabled';

    this.zone = document.createElement('div');
    this.zone.className = 'touch-zone';

    this.base = document.createElement('div');
    this.base.className = 'joy-base';
    this.nub = document.createElement('div');
    this.nub.className = 'joy-nub';
    this.base.appendChild(this.nub);

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'touch-pause';
    pauseBtn.textContent = 'II';
    pauseBtn.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      // Through the synthetic-press seam: consumed in Game.beforeFrame exactly
      // like keyboard Escape — including being ignored on the level-up draft.
      this.input.injectPress('Escape');
    });

    this.root.append(this.zone, this.base, pauseBtn);

    const onStart = (ev: TouchEvent) => {
      if (!this.enabled) return;
      ev.preventDefault();
      if (this.joyId !== null) return;
      const touch = ev.changedTouches[0];
      if (!touch) return;
      this.joyId = touch.identifier;
      this.baseX = touch.clientX;
      this.baseY = touch.clientY;
      // Anchor the visual base under the thumb; radius follows the CSS size.
      this.base.style.left = `${touch.clientX}px`;
      this.base.style.top = `${touch.clientY}px`;
      this.base.classList.add('active');
      this.clampRadius = this.base.clientWidth / 2 || 48;
      this.moveNub(touch.clientX, touch.clientY);
    };
    const onMove = (ev: TouchEvent) => {
      if (this.joyId === null) return;
      ev.preventDefault();
      for (const touch of Array.from(ev.changedTouches)) {
        if (touch.identifier !== this.joyId) continue;
        const [x, y] = joystickVector(this.baseX, this.baseY, touch.clientX, touch.clientY, DEADZONE_PX);
        this.axisX = x;
        this.axisY = y;
        this.moveNub(touch.clientX, touch.clientY);
      }
    };
    const onEnd = (ev: TouchEvent) => {
      for (const touch of Array.from(ev.changedTouches)) {
        if (touch.identifier === this.joyId) this.reset();
      }
    };
    // Mirrors Input's blur handler: a hidden tab must not keep walking.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.reset();
    };

    this.zone.addEventListener('touchstart', onStart, { passive: false });
    this.zone.addEventListener('touchmove', onMove, { passive: false });
    this.zone.addEventListener('touchend', onEnd);
    this.zone.addEventListener('touchcancel', onEnd);
    document.addEventListener('visibilitychange', onVisibility);

    this.detach = () => {
      this.zone.removeEventListener('touchstart', onStart);
      this.zone.removeEventListener('touchmove', onMove);
      this.zone.removeEventListener('touchend', onEnd);
      this.zone.removeEventListener('touchcancel', onEnd);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  /**
   * Gameplay-only visibility: Game flips this per frame from its state, so
   * menus and drafts never show a joystick zone (Screens are plain DOM and
   * remain tappable through the disabled layer).
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.root.classList.toggle('disabled', !on);
    if (!on) this.reset();
  }

  private moveNub(curX: number, curY: number): void {
    const [nx, ny] = nubOffset(this.baseX, this.baseY, curX, curY, this.clampRadius);
    this.nub.style.transform = `translate(${nx}px, ${ny}px)`;
  }

  private reset(): void {
    this.joyId = null;
    this.axisX = 0;
    this.axisY = 0;
    this.base.classList.remove('active');
    this.nub.style.transform = 'translate(0px, 0px)';
  }

  dispose(): void {
    this.detach();
    this.root.remove();
  }
}
