import { describe, expect, it } from 'vitest';

import { UI_SCALE_MIN_COARSE } from './metrics.ts';

/**
 * Gates on the stylesheet's arithmetic and its cross-element clearances.
 *
 * The layout itself needs a browser and is checked by hand (see the manual pass
 * in the commit message), but two things about it are pure and were the source
 * of every collision this package fixed:
 *
 *  - the physical size a token resolves to on a phone, which is the whole
 *    reason the chrome unit exists and is nothing but arithmetic; and
 *  - whether a clearance is COMPOSED from what it has to clear or measured off
 *    a screenshot. `.hud-right: 22u` and `.structure-pips: 30u` were both
 *    hand-derived, and both had drifted to within a few points of the thing
 *    they were avoiding. A test that insists the expression mentions the token
 *    is what stops that happening a third time.
 */

const styleSheet = import.meta.glob('./style.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const css = styleSheet['./style.css'] ?? '';

/** The sheet with its comments removed — prose quotes the very things we gate. */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');

// --- a small evaluator for the token block ---------------------------------

/**
 * `:root`'s custom properties, as raw value strings.
 *
 * Deliberately not a general CSS parser: it reads the one block this file
 * reasons about, and `resolve` below throws on anything it does not understand
 * rather than guessing. A token written in a form this cannot read fails the
 * build loudly, which is the correct outcome — the alternative is a gate that
 * quietly stops checking the number it was written to check.
 */
function rootTokens(sheet: string): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(sheet);
  if (!block) throw new Error('no :root block found in the stylesheet');
  const tokens = new Map<string, string>();
  for (const [, name, value] of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(name!, value!.trim().replace(/\s+/g, ' '));
  }
  return tokens;
}

const TOKENS = rootTokens(declarations);

/**
 * Evaluates a CSS length to pixels with `--ui` pinned to `uiScale`.
 *
 * Understands the subset the token block is written in: numbers with an
 * optional `px`, `calc`, `max`, `min`, the four operators, parentheses, `var()`
 * with an optional fallback, and `env()` (always its fallback — device insets
 * are zero on the machine running this, and every rule here is written so the
 * design value wins when they are).
 */
function evaluate(expression: string, uiScale: number): number {
  let text = expression;
  // Substitute var() and env() to a fixed point. The token graph is shallow and
  // acyclic; the cap turns a cycle into a failure instead of a hang.
  for (let pass = 0; pass < 20 && /\b(?:var|env)\(/.test(text); pass++) {
    text = text.replace(/\b(var|env)\(\s*(--[\w-]+|[\w-]+)\s*(?:,\s*([^()]*?)\s*)?\)/g, (_all, fn, name, fallback) => {
      if (fn === 'env') return fallback ?? '0px';
      if (name === '--ui') return `${uiScale}px`;
      if (name === '--u') throw new Error('the art unit has no place in a chrome token');
      const value = TOKENS.get(name);
      if (value !== undefined) return `(${value})`;
      if (fallback !== undefined) return fallback;
      // --offset-x/y and --play-w/h are published by JS, never declared here;
      // every use in this sheet supplies a fallback, so reaching this is a bug.
      throw new Error(`unresolved custom property ${name}`);
    });
  }
  if (/\b(?:var|env)\(/.test(text)) throw new Error(`could not resolve: ${expression}`);

  const tokens = text.match(/\d*\.?\d+px|\d*\.?\d+|calc|max|min|[(),+\-*/]/g);
  if (!tokens) throw new Error(`nothing to evaluate in: ${expression}`);
  // Anything the tokenizer skipped over is something it does not model, and a
  // skipped unit is worse than a parse error: `calc(100% - 4px)` would come out
  // as 96 and be quietly asserted against as if it were pixels. Requiring the
  // tokens to account for the entire input turns that into a failure.
  if (tokens.join('') !== text.replace(/\s+/g, '')) {
    throw new Error(`unsupported syntax in: ${expression}`);
  }
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  function expr(): number {
    let value = term();
    for (let op = peek(); op === '+' || op === '-'; op = peek()) {
      take();
      value = op === '+' ? value + term() : value - term();
    }
    return value;
  }
  function term(): number {
    let value = factor();
    for (let op = peek(); op === '*' || op === '/'; op = peek()) {
      take();
      value = op === '*' ? value * factor() : value / factor();
    }
    return value;
  }
  function factor(): number {
    const token = take();
    if (token === undefined) throw new Error(`ran out of input in: ${expression}`);
    if (token === '-') return -factor();
    if (token === '(' || token === 'calc') {
      if (token === 'calc') expect(take()).toBe('(');
      const value = expr();
      expect(take()).toBe(')');
      return value;
    }
    if (token === 'max' || token === 'min') {
      expect(take()).toBe('(');
      const args = [expr()];
      while (peek() === ',') {
        take();
        args.push(expr());
      }
      expect(take()).toBe(')');
      return token === 'max' ? Math.max(...args) : Math.min(...args);
    }
    const numeric = Number.parseFloat(token);
    if (Number.isNaN(numeric)) throw new Error(`unexpected "${token}" in: ${expression}`);
    return numeric;
  }

  const result = expr();
  if (at !== tokens.length) throw new Error(`trailing input in: ${expression}`);
  return result;
}

/** A token's physical size on a phone, in points (1 CSS px = 1pt on iOS). */
function phonePt(name: string): number {
  const value = TOKENS.get(name);
  if (value === undefined) throw new Error(`no such token: ${name}`);
  return evaluate(value, UI_SCALE_MIN_COARSE);
}

/** Every rule in the sheet as [selector, declaration block], media-query safe. */
function rules(sheet: string): Array<[string, string]> {
  return Array.from(sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g), (match) => [
    // A rule nested in an at-block picks up "@media (...) {" and a stray "}"
    // from the rule before it; everything after the last brace is the selector.
    match[1]!.replace(/^[\s\S]*[{}]/, '').trim().replace(/\s+/g, ' '),
    match[2]!,
  ]);
}

function ruleBody(selector: string): string {
  const found = rules(declarations).find(([name]) => name === selector);
  if (!found) throw new Error(`no rule for selector: ${selector}`);
  return found[1];
}

// --- the gates --------------------------------------------------------------

describe('the evaluator itself', () => {
  it('reads the forms the token block is written in', () => {
    // If this drifts from CSS semantics every size assertion below is fiction.
    expect(evaluate('calc(var(--ui) * 4)', 3)).toBe(12);
    expect(evaluate('max(44px, calc(var(--ui) * 15))', 3)).toBe(45);
    expect(evaluate('max(44px, calc(var(--ui) * 15))', 2)).toBe(44);
    expect(evaluate('min(10px, 4px, 7px)', 3)).toBe(4);
    expect(evaluate('calc(var(--ui) * 8 + 2px)', 3)).toBe(26);
    expect(evaluate('calc(var(--safe-t) - var(--offset-y, 0px))', 3)).toBe(0);
  });

  it('refuses what it cannot read instead of guessing', () => {
    expect(() => evaluate('var(--nope)', 3)).toThrow();
    expect(() => evaluate('calc(var(--u) * 4)', 3)).toThrow();
    expect(() => evaluate('calc(100% - 4px)', 3)).toThrow();
  });
});

describe('touch targets on a phone', () => {
  // Apple's minimum. On iOS one CSS pixel is one point, so these are directly
  // comparable — and on a phone the chrome unit is pinned to 3, so there is a
  // single number to check rather than one per device.
  const HIG_MINIMUM_PT = 44;

  it.each([
    ['--tap-min', 'the floor every control is held to'],
    ['--tap-blood', 'Feast and Frenzy'],
    ['--tap-ability', 'the character ability'],
    ['--tap-pause', 'the pause control — touch-only, and the one that used to miss'],
  ])('%s clears the 44pt minimum (%s)', (token) => {
    expect(phonePt(token)).toBeGreaterThanOrEqual(HIG_MINIMUM_PT);
  });

  it('holds the floor even in a small desktop window', () => {
    // Below the coarse floor the unit keeps shrinking, so the raw-px term in
    // each token is what stops a control from following it down.
    for (const token of ['--tap-min', '--tap-blood', '--tap-ability', '--tap-pause']) {
      const value = TOKENS.get(token)!;
      expect(evaluate(value, 2)).toBeGreaterThanOrEqual(HIG_MINIMUM_PT);
    }
  });
});

describe('text on a phone', () => {
  // Below about 11pt a monospace face at this weight stops being comfortably
  // readable at arm's length on a handheld screen.
  const READABLE_PT = 11;

  /**
   * Selectors whose text is not rendered on a touch device, so the floor does
   * not apply. Both are keyboard affordances: `.coarse .key-hint` is
   * `display: none`, and the only text inside `.ability-btn` is one of those
   * hints. Anything else that wants to be smaller than the floor has to argue
   * its way onto this list.
   */
  const NOT_SHOWN_ON_TOUCH = ['.key-hint', '.ability-btn'];

  it('sizes every type step above the floor', () => {
    for (const [name] of TOKENS) {
      if (!name.startsWith('--text-')) continue;
      expect(phonePt(name), `${name} is too small to read on a phone`).toBeGreaterThanOrEqual(
        READABLE_PT,
      );
    }
    // Guard the loop: a renamed scale must not make this vacuously true.
    expect([...TOKENS.keys()].filter((n) => n.startsWith('--text-')).length).toBeGreaterThanOrEqual(8);
  });

  it('leaves no rule setting a size below the floor behind the scale\'s back', () => {
    // The type scale is only half the story — a rule can always write its own
    // `font-size`, and four of them do.
    const tooSmall = rules(declarations)
      .flatMap(([selector, body]) => {
        const declared = /font-size:\s*([^;]+);/.exec(body);
        if (!declared) return [];
        const pt = evaluate(declared[1]!, UI_SCALE_MIN_COARSE);
        return pt < READABLE_PT ? [`${selector} (${pt}pt)`] : [];
      })
      .filter((entry) => !NOT_SHOWN_ON_TOUCH.some((selector) => entry.startsWith(`${selector} `)));
    expect(tooSmall).toEqual([]);
  });
});

describe('clearances are composed, not measured', () => {
  it('reserves the thumb cluster from the controls actually in it', () => {
    // Not a literal: enlarging a blood button has to move everything that
    // reserves space against the cluster, in the same edit.
    const clusterWidth = TOKENS.get('--cluster-w')!;
    for (const part of ['--tap-blood', '--orb-size', '--tap-ability', '--cluster-gap']) {
      expect(clusterWidth).toContain(part);
    }
    // Feast + orb + Frenzy + ability + three gaps, on a phone.
    expect(phonePt('--cluster-w')).toBeCloseTo(48 * 2 + 66 + 54 + 9 * 3, 6);
  });

  it('keeps the joystick capture zone off the thumb cluster', () => {
    // The collision the stale comment in touch.ts used to deny. The zone's
    // width must be expressed in terms of the cluster, or the two can drift
    // back into each other with nothing to catch it.
    const zone = ruleBody('.coarse .touch-zone');
    expect(zone).toMatch(/width:/);
    expect(zone).toContain('--cluster-w');
    expect(zone).toContain('--play-w');
  });

  it('moves the cluster out of the joystick half on touch at all', () => {
    // The other half of that fix: reserving space is no use if the cluster is
    // still centred over the left thumb.
    const cluster = ruleBody('.coarse .blood-cluster');
    expect(cluster).toMatch(/right:/);
    expect(cluster).toMatch(/left:\s*auto/);
    expect(cluster).toMatch(/transform:\s*none/);
  });

  it('hangs the structure pips off the clock stack rather than a measured top', () => {
    const pips = ruleBody('.structure-pips');
    expect(pips).toContain('--hud-center-h');
    expect(pips).toContain('--hud-top');
    // The old 30u sat two units under a stack that ended at 28u. The composed
    // form is the stack plus a gutter that is visible in the expression.
    expect(evaluate(/top:\s*([^;]+);/.exec(pips)![1]!, UI_SCALE_MIN_COARSE)).toBeGreaterThanOrEqual(
      phonePt('--hud-top') + phonePt('--hud-center-h') + 8,
    );
  });

  it('steps the counter column left of the pause control it has to clear', () => {
    const right = ruleBody('.coarse .hud-right');
    expect(right).toContain('--pause-reserve');
    expect(TOKENS.get('--pause-reserve')).toContain('--tap-pause');
  });

  it('lifts the coaching strip clear of the bottom band on touch', () => {
    const coach = ruleBody('.coarse .coach-line');
    expect(coach).toContain('--bottom-band');
    expect(coach).toContain('--cluster-w');
  });
});

describe('the layers compose safe areas in their own frame', () => {
  // `#ui` is translated by the letterbox, so its children make up only the
  // difference: max(design, safe - offset). `#menu` and `#touch` span the
  // viewport and must NOT subtract the offset, or a notched phone under-insets
  // them by the width of the black bar. Getting this backwards is invisible on
  // every device without a notch, which is why it is worth a test.
  it.each([
    ['.screen', 'the menu scrim'],
    ['.coarse .touch-pause', 'the pause control'],
  ])('%s does not subtract the letterbox offset (%s)', (selector) => {
    const body = ruleBody(selector);
    expect(body).toMatch(/--safe-/);
    expect(body).not.toContain('--offset-');
  });

  it('still subtracts it in the HUD, where the letterbox has already moved things', () => {
    expect(ruleBody('.loadout')).toContain('--offset-');
    expect(ruleBody('.blood-cluster')).toContain('--offset-');
  });
});

describe('the sticky way out', () => {
  it('pins the closing row by a child combinator, not a descendant one', () => {
    // `.screen .button-row` also matched rows nested inside a picker or a lane,
    // handing them sticky positioning and a gradient they were never meant to
    // have. Harmless while every row was a direct child; a live defect as soon
    // as the short-viewport layout nests one.
    const selectors = rules(declarations).map(([selector]) => selector);
    expect(selectors).toContain('.screen-main > .button-row');
    expect(selectors).not.toContain('.screen .button-row');
  });
});

describe('motion and pointer classes', () => {
  it('lets the reader stop the two infinite pulses', () => {
    expect(declarations).toMatch(/@media[^{]*prefers-reduced-motion:\s*reduce/);
    const reduced = declarations.slice(declarations.indexOf('prefers-reduced-motion'));
    expect(reduced).toContain('.ability-btn.ready');
    expect(reduced).toContain('.blood-cluster.ready .blood-btn');
    expect(reduced).toMatch(/animation:\s*none/);
  });

  it('still keys every touch rule off the class Game writes', () => {
    // Restated from metrics.test.ts because this package added touch rules:
    // two sources of truth for "is this a touch device" is how a hybrid laptop
    // ends up with a pause button that is in the DOM but invisible.
    expect(declarations).not.toMatch(/@media[^{]*pointer:\s*coarse/);
    for (const selector of ['.coarse .touch-zone', '.coarse .blood-cluster', '.coarse .touch-hint']) {
      expect(rules(declarations).map(([name]) => name)).toContain(selector);
    }
  });

  it('gives touch players the hint that the keyboard players get', () => {
    // `.key-hint` is display:none on coarse, which used to leave every screen
    // on a phone explaining nothing at all.
    expect(ruleBody('.touch-hint')).toMatch(/display:\s*none/);
    expect(ruleBody('.coarse .touch-hint')).toMatch(/display:\s*block/);
  });
});

/**
 * A key legend is any class whose whole content is the name of a key to press:
 * `.key-hint` is the line under a screen, `.card-key` the number in a card's
 * corner. A touch device can send neither. `.key-hint` was switched off on
 * `.coarse` from the start; `.card-key` was not, so every arena, survivor,
 * draft card and vow on a phone printed a digit nothing could type.
 *
 * `appendCardKey` already bounds the badge at nine because `handleInput` only
 * maps Digit1..9 — that is a bound by COUNT, and the miss was that no bound by
 * DEVICE sat beside it. Hence the pairing this gates.
 */
describe('keys the device cannot send', () => {
  /** Read out of the sheet, not written down, so a third legend is gated too. */
  const legends = new Set<string>();
  for (const [selector] of rules(declarations)) {
    for (const [, cls] of selector.matchAll(/\.([\w-]*key[\w-]*)\b/g)) legends.add(cls!);
  }

  it('still finds the legends it is meant to be gating', () => {
    // Guards the loop below: renaming a class out of the pattern would
    // otherwise empty the set and pass vacuously.
    expect([...legends]).toEqual(expect.arrayContaining(['card-key', 'key-hint']));
  });

  it.each([...legends])('.%s is not rendered on a touch device', (legend) => {
    const hidden = rules(declarations).some(
      ([selector, body]) =>
        /(^|\s)\.coarse\s/.test(selector) &&
        selector.trimEnd().endsWith(`.${legend}`) &&
        /display:\s*none/.test(body),
    );
    expect(hidden, `.${legend} advertises a key a touch device cannot press`).toBe(true);
  });
});
