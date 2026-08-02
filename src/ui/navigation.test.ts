import { describe, expect, it } from 'vitest';

import { NUMBER_KEYS, choiceLabel, titleSelection, wrapIndex } from './navigation.ts';

describe('wrapIndex', () => {
  it('leaves an index that is already in range alone', () => {
    expect(wrapIndex(0, 5)).toBe(0);
    expect(wrapIndex(3, 5)).toBe(3);
    expect(wrapIndex(4, 5)).toBe(4);
  });

  it('wraps off either end, which is what the arrow keys rely on', () => {
    // Stepping right off the last choice lands on the first, and left off the
    // first lands on the last. Every screen's navigation is these two moves.
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(-1, 5)).toBe(4);
    expect(wrapIndex(-5, 5)).toBe(0);
    expect(wrapIndex(-6, 5)).toBe(4);
    expect(wrapIndex(12, 5)).toBe(2);
  });

  it('answers 0 for an empty or nonsense list rather than NaN', () => {
    // A NaN focus index compares false against every position, so the highlight
    // would silently vanish from a screen that still takes Enter.
    expect(wrapIndex(3, 0)).toBe(0);
    expect(wrapIndex(3, -1)).toBe(0);
    expect(wrapIndex(Number.NaN, 5)).toBe(0);
    expect(wrapIndex(Number.POSITIVE_INFINITY, 5)).toBe(0);
  });

  it('never leaves the range for any input, over the whole span a menu can hold', () => {
    for (let length = 1; length <= 12; length++) {
      for (let index = -30; index <= 30; index++) {
        const wrapped = wrapIndex(index, length);
        expect(Number.isInteger(wrapped)).toBe(true);
        expect(wrapped).toBeGreaterThanOrEqual(0);
        expect(wrapped).toBeLessThan(length);
      }
    }
  });
});

describe('choice numbering', () => {
  it('prints one-based positions', () => {
    expect(choiceLabel(0)).toBe('1');
    expect(choiceLabel(8)).toBe('9');
  });

  it('agrees with the key that selects it, for every key there is', () => {
    // The card prints `choiceLabel(i)` and `handleInput` fires on
    // `NUMBER_KEYS[i]`. If these two ever drift, a card reads "3" and answers
    // to a different key — a fault nobody reports and everybody works around.
    NUMBER_KEYS.forEach((code, index) => {
      expect(code).toBe(`Digit${choiceLabel(index)}`);
    });
  });

  it('stops at nine, which is why past the ninth card nothing is printed', () => {
    // The Sanctum has ten vows plus a Back button. A tenth card printing "10"
    // would advertise a key that does not exist.
    expect(NUMBER_KEYS).toHaveLength(9);
  });
});

describe('titleSelection', () => {
  // The shipping shape: four arenas, five survivors, then the Sanctum.
  const MAPS = 4;
  const CHARACTERS = 5;

  it('reads the arenas first, in picker order', () => {
    expect(titleSelection(0, MAPS, CHARACTERS)).toEqual({ kind: 'map', at: 0 });
    expect(titleSelection(3, MAPS, CHARACTERS)).toEqual({ kind: 'map', at: 3 });
  });

  it('reads the survivors next, rebased to their own list', () => {
    // The character at flat index 4 is characters[0] — the rebase is the part
    // that used to be spelled `index - mapCount` at the call site.
    expect(titleSelection(4, MAPS, CHARACTERS)).toEqual({ kind: 'character', at: 0 });
    expect(titleSelection(8, MAPS, CHARACTERS)).toEqual({ kind: 'character', at: 4 });
  });

  it('reads the Sanctum last and only at its own index', () => {
    expect(titleSelection(9, MAPS, CHARACTERS)).toEqual({ kind: 'sanctum' });
  });

  it('answers none rather than reaching past the end of a list', () => {
    // The old form fell through to the Sanctum for anything at or past the
    // last character, so an off-by-one anywhere in the render would have
    // silently opened a screen instead of failing visibly.
    expect(titleSelection(10, MAPS, CHARACTERS)).toEqual({ kind: 'none' });
    expect(titleSelection(-1, MAPS, CHARACTERS)).toEqual({ kind: 'none' });
    expect(titleSelection(1.5, MAPS, CHARACTERS)).toEqual({ kind: 'none' });
  });

  it('covers every index of the flat array exactly once', () => {
    // The whole contract: the array is flat and ordered, and the index is the
    // identity. Walking it must visit every map, every character and the
    // Sanctum, each once, with nothing missed and nothing doubled.
    for (let maps = 1; maps <= 5; maps++) {
      for (let characters = 1; characters <= 6; characters++) {
        const seen: string[] = [];
        for (let i = 0; i < maps + characters + 1; i++) {
          const choice = titleSelection(i, maps, characters);
          seen.push(choice.kind === 'sanctum' || choice.kind === 'none' ? choice.kind : `${choice.kind}:${choice.at}`);
        }
        const expected = [
          ...Array.from({ length: maps }, (_, i) => `map:${i}`),
          ...Array.from({ length: characters }, (_, i) => `character:${i}`),
          'sanctum',
        ];
        expect(seen).toEqual(expected);
      }
    }
  });

  it('survives a sixth survivor being added without renumbering the arenas', () => {
    // Adding a character must not move a map's index — that is what keeps a
    // saved habit ("2 is the bastion") true across a content change.
    for (let characters = 5; characters <= 6; characters++) {
      expect(titleSelection(1, MAPS, characters)).toEqual({ kind: 'map', at: 1 });
    }
    expect(titleSelection(9, MAPS, 6)).toEqual({ kind: 'character', at: 5 });
    expect(titleSelection(10, MAPS, 6)).toEqual({ kind: 'sanctum' });
  });

  it('degenerates safely when a list is empty', () => {
    // No maps discovered, or a content typo that filtered every character out:
    // the screen still has a Sanctum button and it must still be index 0.
    expect(titleSelection(0, 0, 0)).toEqual({ kind: 'sanctum' });
    expect(titleSelection(0, 0, 3)).toEqual({ kind: 'character', at: 0 });
  });
});
