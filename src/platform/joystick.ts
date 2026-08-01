/**
 * Pure math for the floating touch joystick. Direction-only on purpose: like
 * the keyboard, the stick controls heading, never speed — `Input` runs the
 * result through the same `normalize()` the arrow keys use, so movement is
 * always full speed and diagonal isn't faster than cardinal. Distances are in
 * CSS pixels (Touch.clientX space).
 */

/**
 * Touch point → movement direction. Inside `deadzone` px of the anchor the
 * stick is neutral; beyond it, the unit vector from anchor to touch.
 */
export function joystickVector(
  baseX: number,
  baseY: number,
  curX: number,
  curY: number,
  deadzone: number,
): [number, number] {
  const dx = curX - baseX;
  const dy = curY - baseY;
  const len = Math.hypot(dx, dy);
  if (len < deadzone) return [0, 0];
  return [dx / len, dy / len];
}

/**
 * Visual nub position relative to the joystick base: the raw finger offset,
 * clamped to `radius` px so the nub never escapes the base ring.
 */
export function nubOffset(
  baseX: number,
  baseY: number,
  curX: number,
  curY: number,
  radius: number,
): [number, number] {
  const dx = curX - baseX;
  const dy = curY - baseY;
  const len = Math.hypot(dx, dy);
  if (len <= radius) return [dx, dy];
  return [(dx / len) * radius, (dy / len) * radius];
}
