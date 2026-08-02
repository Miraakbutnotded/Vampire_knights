/**
 * Menu navigation arithmetic, kept away from the DOM so it can be tested.
 *
 * `Screens` needs a browser and has no coverage. The two things in it most
 * likely to break silently when a screen is re-laid-out are, however, pure: how
 * a wrapping cursor moves, and what a given index of the title screen's one
 * flat choice array actually means. Both live here, and `navigation.test.ts`
 * pins them.
 *
 * The contract they serve: `setChoices` takes a FLAT ORDERED ARRAY and the
 * index is the semantic identity of a choice. Which lane an element is painted
 * in, or whether the screen is a column or two columns, must never change what
 * selecting it does — so the mapping from index to meaning is written once,
 * here, instead of being re-derived inside a render function that also has a
 * layout to worry about.
 */

/**
 * The keys that pick a choice directly, in the order they select.
 *
 * Paired with `choiceLabel` below: `NUMBER_KEYS[i]` is the key for the choice
 * whose card prints `choiceLabel(i)`. A test asserts the two never drift, since
 * a card printing "3" that answers to a different key is the kind of fault
 * nobody reports and everybody works around.
 */
export const NUMBER_KEYS = [
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
] as const;

/**
 * Wraps `index` into `[0, length)`, so stepping off either end comes back on
 * the other. Empty lists answer 0 rather than NaN — the caller checks for empty
 * before using it, and a NaN focus index silently unfocuses everything.
 */
export function wrapIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || length <= 0) return 0;
  return ((Math.trunc(index) % length) + length) % length;
}

/**
 * The number a choice prints, derived from its position in the flat array.
 *
 * Callers pass the index the element is *about* to occupy, which makes the
 * printed number correct by construction rather than by an arithmetic that has
 * to be kept in step with the push order. The title screen used to compute its
 * character numbers as `maps.length + i + 1`, which is the same answer only for
 * as long as nothing is ever inserted between the two pickers.
 */
export function choiceLabel(index: number): string {
  return String(index + 1);
}

/** What one index of the title screen's flat choice array refers to. */
export type TitleSelection =
  | { kind: 'map'; at: number }
  | { kind: 'character'; at: number }
  | { kind: 'sanctum' }
  | { kind: 'none' };

/**
 * Resolves an index of the title screen's flat choice array.
 *
 * The order is every map, then every character, then the Sanctum, and it is the
 * order `renderTitle` pushes them in. Total by construction: an index outside
 * the array answers `none` rather than reaching past the end of a list, because
 * the alternative is a non-null assertion on `maps[index]` that holds only
 * while the two orders agree.
 */
export function titleSelection(
  index: number,
  mapCount: number,
  characterCount: number,
): TitleSelection {
  if (!Number.isInteger(index) || index < 0) return { kind: 'none' };
  if (index < mapCount) return { kind: 'map', at: index };
  if (index < mapCount + characterCount) return { kind: 'character', at: index - mapCount };
  if (index === mapCount + characterCount) return { kind: 'sanctum' };
  return { kind: 'none' };
}
