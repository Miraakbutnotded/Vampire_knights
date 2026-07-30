import { normalize } from './math.ts';

const MOVE_KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
} as const;

/**
 * Keyboard + gamepad input. Movement is exposed as a normalized axis pair so
 * diagonal movement isn't faster than cardinal.
 *
 * `pressed` is edge-triggered: it reports keys that went down since the last
 * `endFrame()`, which is what menus want. `held` is level-triggered for movement.
 */
export class Input {
  private held = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private consumed = new Set<string>();

  axisX = 0;
  axisY = 0;

  private gamepadIndex: number | null = null;
  private detach: () => void;

  constructor(target: EventTarget = window) {
    const onKeyDown = (ev: Event) => {
      const e = ev as KeyboardEvent;
      // Stop the browser from scrolling the page with arrows/space during play.
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.held.add(e.code);
      this.pressedThisFrame.add(e.code);
    };
    const onKeyUp = (ev: Event) => {
      const e = ev as KeyboardEvent;
      this.held.delete(e.code);
    };
    // Releasing keys on blur avoids the classic "player walks forever" bug
    // when the user alt-tabs mid-run.
    const onBlur = () => {
      this.held.clear();
      this.pressedThisFrame.clear();
    };
    const onGamepad = (ev: Event) => {
      this.gamepadIndex = (ev as GamepadEvent).gamepad.index;
    };

    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('gamepadconnected', onGamepad);

    this.detach = () => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('gamepadconnected', onGamepad);
    };
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  /** Edge-triggered, and single-use: the first caller this frame consumes it. */
  wasPressed(code: string): boolean {
    if (!this.pressedThisFrame.has(code) || this.consumed.has(code)) return false;
    this.consumed.add(code);
    return true;
  }

  anyPressed(): boolean {
    return this.pressedThisFrame.size > 0;
  }

  /** Call once per frame, before systems read input. */
  beginFrame(): void {
    let x = 0;
    let y = 0;
    for (const code of MOVE_KEYS.left) if (this.held.has(code)) x -= 1;
    for (const code of MOVE_KEYS.right) if (this.held.has(code)) x += 1;
    for (const code of MOVE_KEYS.up) if (this.held.has(code)) y -= 1;
    for (const code of MOVE_KEYS.down) if (this.held.has(code)) y += 1;

    x = Math.sign(x);
    y = Math.sign(y);

    const pad = this.readGamepad();
    if (pad) {
      x += pad[0];
      y += pad[1];
    }

    const [nx, ny] = normalize(x, y);
    this.axisX = nx;
    this.axisY = ny;
  }

  /** Call once per frame, after systems read input. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.consumed.clear();
  }

  private readGamepad(): [number, number] | null {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    if (!pad) return null;

    const deadzone = 0.22;
    let x = pad.axes[0] ?? 0;
    let y = pad.axes[1] ?? 0;
    if (Math.hypot(x, y) < deadzone) {
      x = 0;
      y = 0;
    }

    // D-pad, on the standard mapping.
    if (pad.buttons[14]?.pressed) x -= 1;
    if (pad.buttons[15]?.pressed) x += 1;
    if (pad.buttons[12]?.pressed) y -= 1;
    if (pad.buttons[13]?.pressed) y += 1;

    // Surface face/start buttons to menu code as synthetic key presses.
    if (pad.buttons[0]?.pressed) this.pressedThisFrame.add('Enter');
    if (pad.buttons[9]?.pressed) this.pressedThisFrame.add('Escape');

    return [x, y];
  }

  dispose(): void {
    this.detach();
  }
}
