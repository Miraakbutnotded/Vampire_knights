import { formatTime } from '../core/math.ts';
import { MAX_PASSIVE_SLOTS, MAX_WEAPON_SLOTS } from '../gameplay/run.ts';
import type { Run } from '../gameplay/run.ts';
import type { SpriteTable } from '../render/sprites.ts';

/** How long a boss-arrival banner stays on screen. */
const BANNER_SECONDS = 3;

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
 * The in-run overlay: health, experience, timer, counters and loadout.
 *
 * DOM nodes are built once and only their text and widths are written each
 * frame. Rebuilding the loadout rows on every frame would thrash layout, so
 * those are rebuilt only when the loadout actually changes — tracked with a
 * cheap signature string.
 */
export class Hud {
  readonly root: HTMLElement;

  private xpFill: HTMLElement;
  private hpFill: HTMLElement;
  private hpText: HTMLElement;
  private timer: HTMLElement;
  private levelChip: HTMLElement;
  private killsValue: HTMLElement;
  private goldValue: HTMLElement;
  private weaponRow: HTMLElement;
  private passiveRow: HTMLElement;
  private banner: HTMLElement;

  private loadoutSignature = '';
  private bannerTimer = 0;

  /**
   * Last written value for each text node. Assigning `textContent` replaces the
   * node even when the string is identical, which dirties layout; the timer only
   * changes once a second and the counters change rarely, so guarding these
   * removes most of the HUD's per-frame cost.
   */
  private cache = { hp: '', xp: -1, time: '', level: '', kills: '', gold: '' };

  constructor(private sprites: SpriteTable) {
    this.root = el('div', 'hud');

    const xpTrack = el('div', 'xp-track');
    this.xpFill = el('div', 'xp-fill');
    xpTrack.appendChild(this.xpFill);

    // Left: health.
    const left = el('div', 'hud-row hud-left');
    const hpTrack = el('div', 'hp-track');
    this.hpFill = el('div', 'hp-fill');
    this.hpText = el('div', 'hp-text', '100 / 100');
    hpTrack.append(this.hpFill, this.hpText);
    left.appendChild(hpTrack);

    // Centre: clock and level.
    const center = el('div', 'hud-row hud-center');
    this.timer = el('div', 'timer', '00:00');
    this.levelChip = el('div', 'level-chip', 'LV 1');
    center.append(this.timer, this.levelChip);

    // Right: counters.
    const right = el('div', 'hud-row hud-right');
    const killsStat = el('div', 'stat');
    this.killsValue = el('b', undefined, '0');
    killsStat.append(document.createTextNode('KILLS '), this.killsValue);
    const goldStat = el('div', 'stat gold');
    this.goldValue = el('b', undefined, '0');
    goldStat.append(document.createTextNode('GOLD '), this.goldValue);
    right.append(killsStat, goldStat);

    // Bottom-left: loadout.
    const loadout = el('div', 'loadout');
    this.weaponRow = el('div', 'slot-row');
    this.passiveRow = el('div', 'slot-row');
    loadout.append(this.weaponRow, this.passiveRow);

    this.banner = el('div', 'boss-banner');

    this.root.append(xpTrack, left, center, right, loadout, this.banner);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
  }

  showBanner(text: string): void {
    this.banner.textContent = text;
    this.banner.classList.add('show');
    this.bannerTimer = BANNER_SECONDS;
  }

  /** Called once per rendered frame. `hp` is passed in since it lives on the entity. */
  update(run: Run, hp: number, frameDt: number): void {
    const maxHp = run.stats.maxHp;
    const hpPercent = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 0;
    const hpLabel = `${Math.ceil(Math.max(0, hp))} / ${Math.round(maxHp)}`;
    if (hpLabel !== this.cache.hp) {
      this.cache.hp = hpLabel;
      this.hpFill.style.width = `${hpPercent}%`;
      this.hpText.textContent = hpLabel;
    }

    // Quantised to whole percent: sub-pixel bar changes aren't visible anyway.
    const xpPercent = Math.round(run.xpFraction * 100);
    if (xpPercent !== this.cache.xp) {
      this.cache.xp = xpPercent;
      this.xpFill.style.width = `${xpPercent}%`;
    }

    const time = formatTime(run.time);
    if (time !== this.cache.time) {
      this.cache.time = time;
      this.timer.textContent = time;
    }

    const level = `LV ${run.level}`;
    if (level !== this.cache.level) {
      this.cache.level = level;
      this.levelChip.textContent = level;
    }

    const kills = String(run.kills);
    if (kills !== this.cache.kills) {
      this.cache.kills = kills;
      this.killsValue.textContent = kills;
    }

    const gold = String(run.gold);
    if (gold !== this.cache.gold) {
      this.cache.gold = gold;
      this.goldValue.textContent = gold;
    }

    if (this.bannerTimer > 0) {
      this.bannerTimer -= frameDt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    }

    this.syncLoadout(run);
  }

  /**
   * Rebuilds the icon rows only when something changed. The signature captures
   * every id and level, which is all the rows display.
   */
  private syncLoadout(run: Run): void {
    const signature =
      run.weapons.map((w) => `${w.def.id}:${w.level}`).join(',') +
      '|' +
      run.passives.map((p) => `${p.def.id}:${p.level}`).join(',');
    if (signature === this.loadoutSignature) return;
    this.loadoutSignature = signature;

    this.weaponRow.replaceChildren();
    for (const weapon of run.weapons) {
      const slot = el('div', 'slot');
      if (weapon.level >= weapon.def.maxLevel) slot.classList.add('maxed');
      slot.title = `${weapon.def.name} — level ${weapon.level}/${weapon.def.maxLevel}`;
      slot.appendChild(this.sprites.iconCanvas(weapon.def.sprite, 32));
      slot.appendChild(this.pips(weapon.level, weapon.def.maxLevel));
      this.weaponRow.appendChild(slot);
    }
    for (let i = run.weapons.length; i < MAX_WEAPON_SLOTS; i++) {
      this.weaponRow.appendChild(el('div', 'slot'));
    }

    this.passiveRow.replaceChildren();
    for (const passive of run.passives) {
      const slot = el('div', 'slot');
      if (passive.level >= passive.def.maxLevel) slot.classList.add('maxed');
      slot.title = `${passive.def.name} — level ${passive.level}/${passive.def.maxLevel}`;
      // Passives have no art of their own; an initial reads well at this size.
      slot.appendChild(el('span', 'initial', passive.def.name.charAt(0).toUpperCase()));
      slot.appendChild(this.pips(passive.level, passive.def.maxLevel));
      this.passiveRow.appendChild(slot);
    }
    for (let i = run.passives.length; i < MAX_PASSIVE_SLOTS; i++) {
      this.passiveRow.appendChild(el('div', 'slot'));
    }
  }

  private pips(level: number, maxLevel: number): HTMLElement {
    const wrap = el('div', 'pips');
    for (let i = 0; i < maxLevel; i++) {
      wrap.appendChild(el('span', i < level ? 'pip on' : 'pip'));
    }
    return wrap;
  }
}
