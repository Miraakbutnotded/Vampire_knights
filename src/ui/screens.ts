import { formatTime } from '../core/math.ts';
import type { Input } from '../core/input.ts';
import { META_LIST } from '../gameplay/content.ts';
import type { CharacterDef } from '../gameplay/content.ts';
import type { Offer } from '../gameplay/upgrades.ts';
import type { Run } from '../gameplay/run.ts';
import type { SpriteTable } from '../render/sprites.ts';

export type ScreenName = 'none' | 'title' | 'levelup' | 'pause' | 'results' | 'sanctum';

export interface ResultsData {
  victory: boolean;
  run: Run;
  /** Persistent wallet total after this run banked its gold. */
  walletGold: number;
}

/** Read-only meta the title screen renders from; owned by MetaService. */
export interface TitleMeta {
  gold: number;
  isUnlocked(character: CharacterDef): boolean;
}

export interface TitleCallbacks {
  onStart: (characterId: string, mapId: string) => void;
  onUnlock: (characterId: string) => void;
  onSanctum: () => void;
}

export interface PauseCallbacks {
  onResume: () => void;
  onRestart: () => void;
  onQuit: () => void;
}

export interface ResultsCallbacks {
  onRetry: () => void;
  onTitle: () => void;
}

/** Read-only meta the sanctum renders from; owned by MetaService. */
export interface SanctumMeta {
  gold: number;
  rankOf(nodeId: string): number;
}

export interface SanctumCallbacks {
  onBuy: (nodeId: string) => void;
  onBack: () => void;
}

const NUMBER_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * All full-screen menus: title, level-up draft, pause and results.
 *
 * Every screen reduces to the same interaction — a list of focusable choices
 * driven by either keyboard, gamepad or mouse — so navigation is implemented
 * once here and each screen just supplies its elements and a callback.
 */
export class Screens {
  readonly root: HTMLElement;

  private current: ScreenName = 'none';
  private panel: HTMLElement;

  private choices: HTMLElement[] = [];
  private focusIndex = 0;
  private onSelect: ((index: number) => void) | null = null;

  private selectedMap: string;
  private maps: string[];
  private characters: readonly CharacterDef[] = [];
  private titleCallbacks: TitleCallbacks | null = null;
  private titleMeta: TitleMeta | null = null;

  constructor(
    private sprites: SpriteTable,
    maps: string[],
  ) {
    this.maps = maps;
    this.selectedMap = maps[0] ?? 'meadow';
    this.root = el('div', 'screen');
    this.panel = el('div', 'picker');
    this.root.appendChild(this.panel);
  }

  get active(): ScreenName {
    return this.current;
  }

  get isOpen(): boolean {
    return this.current !== 'none';
  }

  hide(): void {
    this.current = 'none';
    this.root.classList.remove('visible');
    this.choices = [];
    this.onSelect = null;
  }

  // --- title --------------------------------------------------------------

  showTitle(characters: readonly CharacterDef[], meta: TitleMeta, callbacks: TitleCallbacks): void {
    this.characters = characters;
    this.titleMeta = meta;
    this.titleCallbacks = callbacks;
    this.renderTitle();
  }

  private renderTitle(): void {
    this.current = 'title';
    this.root.classList.add('visible');
    this.root.replaceChildren();

    this.root.appendChild(el('h1', undefined, 'SURVIVORS'));
    this.root.appendChild(
      el('p', undefined, 'Stay alive for fifteen minutes. Pick up whatever will keep you standing.'),
    );
    this.root.appendChild(el('div', 'wallet', `VAULT ${this.titleMeta?.gold ?? 0} GOLD`));

    const focusables: HTMLElement[] = [];

    // Arena picker.
    const mapPicker = el('div', 'picker');
    mapPicker.appendChild(el('div', 'picker-label', 'ARENA'));
    const mapRow = el('div', 'button-row');
    for (const mapId of this.maps) {
      const button = el('button', 'btn');
      button.type = 'button';
      button.textContent = mapId;
      if (mapId === this.selectedMap) button.classList.add('primary');
      mapRow.appendChild(button);
      focusables.push(button);
    }
    mapPicker.appendChild(mapRow);
    this.root.appendChild(mapPicker);

    // Character picker: locked cards render greyed with their price and route
    // to the unlock flow instead of starting a run.
    const charPicker = el('div', 'picker');
    charPicker.appendChild(el('div', 'picker-label', 'SURVIVOR'));
    const cards = el('div', 'cards');
    for (let i = 0; i < this.characters.length; i++) {
      const character = this.characters[i]!;
      const locked = !(this.titleMeta?.isUnlocked(character) ?? true);
      const card = el('button', 'card');
      card.type = 'button';
      if (locked) card.classList.add('locked');

      const head = el('div', 'card-head');
      head.appendChild(this.sprites.iconCanvas(character.sprite, 32));
      const titles = el('div');
      titles.appendChild(el('div', 'card-title', character.name));
      titles.appendChild(
        el(
          'div',
          'card-tag',
          locked
            ? `LOCKED — ${character.unlock!.gold} GOLD`
            : `HP ${character.stats.maxHp} · SPD ${Math.round(character.stats.moveSpeed)}`,
        ),
      );
      head.appendChild(titles);
      card.appendChild(head);

      card.appendChild(el('div', 'card-body', character.description));
      card.appendChild(el('div', 'card-key', String(this.maps.length + i + 1)));

      cards.appendChild(card);
      focusables.push(card);
    }
    charPicker.appendChild(cards);
    this.root.appendChild(charPicker);

    // Sanctum entry — appended after the pickers so the map/character
    // number-key indices stay stable.
    const metaRow = el('div', 'button-row');
    const sanctumBtn = el('button', 'btn', 'THE SANCTUM');
    sanctumBtn.type = 'button';
    metaRow.appendChild(sanctumBtn);
    this.root.appendChild(metaRow);
    focusables.push(sanctumBtn);

    this.root.appendChild(
      el('div', 'hint', 'WASD or arrows to move · ESC to pause · number keys or click to choose'),
    );

    const mapCount = this.maps.length;
    const charCount = this.characters.length;
    this.setChoices(focusables, (index) => {
      if (index < mapCount) {
        this.selectedMap = this.maps[index]!;
        // Re-render so the highlighted arena updates, keeping focus in place.
        const keep = index;
        this.renderTitle();
        this.setFocus(keep);
        return;
      }
      if (index < mapCount + charCount) {
        const character = this.characters[index - mapCount];
        if (!character) return;
        if (!(this.titleMeta?.isUnlocked(character) ?? true)) {
          this.titleCallbacks?.onUnlock(character.id);
          return;
        }
        this.titleCallbacks?.onStart(character.id, this.selectedMap);
        return;
      }
      this.titleCallbacks?.onSanctum();
    });
    // Default focus to the first character rather than the arena buttons, since
    // starting a run is what the player is here to do.
    this.setFocus(mapCount);
  }

  // --- level-up draft -----------------------------------------------------

  showLevelUp(offers: Offer[], onPick: (offer: Offer) => void): void {
    this.current = 'levelup';
    this.root.classList.add('visible');
    this.root.replaceChildren();

    this.root.appendChild(el('h2', undefined, 'LEVEL UP'));

    const cards = el('div', 'cards');
    const focusables: HTMLElement[] = [];

    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i]!;
      const card = el('button', 'card');
      card.type = 'button';
      if (offer.isNew) card.classList.add('is-new');

      const head = el('div', 'card-head');
      if (offer.sprite) head.appendChild(this.sprites.iconCanvas(offer.sprite, 32));
      const titles = el('div');
      titles.appendChild(el('div', 'card-title', offer.name));
      const tag =
        offer.level === 0
          ? offer.kind === 'heal'
            ? 'RECOVER'
            : 'REWARD'
          : offer.isNew
            ? 'NEW'
            : `LEVEL ${offer.level}`;
      titles.appendChild(el('div', 'card-tag', tag));
      head.appendChild(titles);
      card.appendChild(head);

      card.appendChild(el('div', 'card-body', offer.description));

      if (offer.maxLevel > 0) {
        const pips = el('div', 'card-pips');
        for (let p = 0; p < offer.maxLevel; p++) {
          pips.appendChild(el('span', p < offer.level ? 'pip on' : 'pip'));
        }
        card.appendChild(pips);
      }

      card.appendChild(el('div', 'card-key', String(i + 1)));
      cards.appendChild(card);
      focusables.push(card);
    }

    this.root.appendChild(cards);
    this.root.appendChild(el('div', 'hint', 'Arrows to move · Enter to choose · 1-3 for a direct pick'));

    this.setChoices(focusables, (index) => {
      const offer = offers[index];
      if (offer) onPick(offer);
    });
    this.setFocus(0);
  }

  // --- pause --------------------------------------------------------------

  showPause(run: Run, callbacks: PauseCallbacks): void {
    this.current = 'pause';
    this.root.classList.add('visible');
    this.root.replaceChildren();

    this.root.appendChild(el('h2', undefined, 'PAUSED'));

    const summary = el('dl', 'results');
    appendResult(summary, 'Time', formatTime(run.time));
    appendResult(summary, 'Level', String(run.level));
    appendResult(summary, 'Kills', String(run.kills));
    appendResult(summary, 'Gold', String(run.gold));
    this.root.appendChild(summary);

    const loadout = run.weapons.map((w) => `${w.def.name} ${w.level}`).join(' · ');
    if (loadout) this.root.appendChild(el('p', undefined, loadout));

    const row = el('div', 'button-row');
    const resume = el('button', 'btn primary', 'Resume');
    resume.type = 'button';
    const restart = el('button', 'btn', 'Restart run');
    restart.type = 'button';
    const quit = el('button', 'btn', 'Quit to title');
    quit.type = 'button';
    row.append(resume, restart, quit);
    this.root.appendChild(row);
    this.root.appendChild(el('div', 'hint', 'ESC to resume'));

    this.setChoices([resume, restart, quit], (index) => {
      if (index === 0) callbacks.onResume();
      else if (index === 1) callbacks.onRestart();
      else callbacks.onQuit();
    });
    this.setFocus(0);
  }

  // --- results ------------------------------------------------------------

  showResults(data: ResultsData, callbacks: ResultsCallbacks): void {
    this.current = 'results';
    this.root.classList.add('visible');
    this.root.replaceChildren();

    const { run, victory } = data;
    this.root.appendChild(el('h1', undefined, victory ? 'YOU SURVIVED' : 'YOU DIED'));
    this.root.appendChild(
      el(
        'p',
        undefined,
        victory
          ? 'The night broke and you were still standing.'
          : 'The horde closed in. Try a different build.',
      ),
    );

    const summary = el('dl', 'results');
    appendResult(summary, 'Survived', formatTime(run.time));
    appendResult(summary, 'Level reached', String(run.level));
    appendResult(summary, 'Enemies slain', String(run.kills));
    appendResult(summary, 'Gold collected', String(run.gold));
    appendResult(summary, 'Sanctum vault', String(data.walletGold));
    this.root.appendChild(summary);

    const loadout = run.weapons.map((w) => `${w.def.name} ${w.level}`).join(' · ');
    if (loadout) this.root.appendChild(el('p', undefined, loadout));

    const row = el('div', 'button-row');
    const retry = el('button', 'btn primary', 'Run again');
    retry.type = 'button';
    const title = el('button', 'btn', 'Title screen');
    title.type = 'button';
    row.append(retry, title);
    this.root.appendChild(row);

    this.setChoices([retry, title], (index) => {
      if (index === 0) callbacks.onRetry();
      else callbacks.onTitle();
    });
    this.setFocus(0);
  }

  // --- sanctum ------------------------------------------------------------

  showSanctum(meta: SanctumMeta, callbacks: SanctumCallbacks, focus = 0): void {
    this.current = 'sanctum';
    this.root.classList.add('visible');
    this.root.replaceChildren();

    this.root.appendChild(el('h2', undefined, 'THE SANCTUM'));
    this.root.appendChild(
      el('p', undefined, 'Gold spent between nights stays spent. These vows persist.'),
    );
    this.root.appendChild(el('div', 'wallet', `VAULT ${meta.gold} GOLD`));

    const cards = el('div', 'cards sanctum-cards');
    const focusables: HTMLElement[] = [];

    for (const node of META_LIST) {
      const rank = meta.rankOf(node.id);
      const maxed = rank >= node.maxRank;
      const cost = maxed ? null : node.costs[rank]!;

      const card = el('button', 'card');
      card.type = 'button';
      if (maxed) card.classList.add('maxed');
      else if (cost !== null && cost > meta.gold) card.classList.add('poor');

      const head = el('div', 'card-head');
      const titles = el('div');
      titles.appendChild(el('div', 'card-title', node.name));
      titles.appendChild(el('div', 'card-tag', maxed ? 'MAX' : `RANK ${rank}/${node.maxRank}`));
      head.appendChild(titles);
      card.appendChild(head);

      card.appendChild(el('div', 'card-body', node.description));

      const pips = el('div', 'card-pips');
      for (let p = 0; p < node.maxRank; p++) {
        pips.appendChild(el('span', p < rank ? 'pip on' : 'pip'));
      }
      card.appendChild(pips);

      card.appendChild(el('div', 'card-cost', maxed ? 'COMPLETE' : `${cost} GOLD`));

      cards.appendChild(card);
      focusables.push(card);
    }
    this.root.appendChild(cards);

    const row = el('div', 'button-row');
    const back = el('button', 'btn primary', 'Back to title');
    back.type = 'button';
    row.appendChild(back);
    this.root.appendChild(row);
    focusables.push(back);

    this.root.appendChild(el('div', 'hint', 'Arrows to move · Enter to buy · ESC to leave'));

    this.setChoices(focusables, (index) => {
      if (index < META_LIST.length) {
        // A failed buy (too poor / maxed) re-renders unchanged — the dimmed
        // cost is its own feedback at v1.
        callbacks.onBuy(META_LIST[index]!.id);
        return;
      }
      callbacks.onBack();
    });
    this.setFocus(focus);
  }

  // --- navigation ---------------------------------------------------------

  private setChoices(elements: HTMLElement[], onSelect: (index: number) => void): void {
    this.choices = elements;
    this.onSelect = onSelect;
    elements.forEach((element, index) => {
      element.addEventListener('click', () => this.onSelect?.(index));
      element.addEventListener('mouseenter', () => this.setFocus(index));
    });
  }

  private setFocus(index: number): void {
    if (this.choices.length === 0) return;
    const wrapped = ((index % this.choices.length) + this.choices.length) % this.choices.length;
    this.focusIndex = wrapped;
    this.choices.forEach((element, i) => element.classList.toggle('focused', i === wrapped));
  }

  /**
   * Polls navigation for the open screen. Called from the game loop rather than
   * bound to DOM events so menu input shares the same edge-detection as
   * gameplay and can't fire twice for one key press.
   */
  handleInput(input: Input): void {
    if (!this.isOpen || this.choices.length === 0) return;

    if (input.wasPressed('ArrowRight') || input.wasPressed('KeyD')) this.setFocus(this.focusIndex + 1);
    if (input.wasPressed('ArrowLeft') || input.wasPressed('KeyA')) this.setFocus(this.focusIndex - 1);
    // Up/down step by one too: the layout wraps, so a strict grid walk would
    // need to know the column count and it isn't worth the coupling.
    if (input.wasPressed('ArrowDown') || input.wasPressed('KeyS')) this.setFocus(this.focusIndex + 1);
    if (input.wasPressed('ArrowUp') || input.wasPressed('KeyW')) this.setFocus(this.focusIndex - 1);

    for (let i = 0; i < NUMBER_KEYS.length && i < this.choices.length; i++) {
      if (input.wasPressed(NUMBER_KEYS[i]!)) {
        this.setFocus(i);
        this.onSelect?.(i);
        return;
      }
    }

    if (input.wasPressed('Enter') || input.wasPressed('Space')) {
      this.onSelect?.(this.focusIndex);
    }
  }
}

function appendResult(list: HTMLElement, label: string, value: string): void {
  list.appendChild(el('dt', undefined, label));
  list.appendChild(el('dd', undefined, value));
}
