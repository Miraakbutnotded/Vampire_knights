import { formatTime } from '../core/math.ts';
import { BLOOD_CONFIG } from '../gameplay/content.ts';
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
 * A keyboard shortcut printed on a control.
 *
 * Hidden from assistive tech: the button already announces what it does, and
 * `.coarse .key-hint` is `display: none` anyway, so on the device where these
 * buttons are the only way to act the letter is not there at all.
 */
function keyHint(key: string): HTMLElement {
  const hint = el('span', 'key-hint', key);
  hint.setAttribute('aria-hidden', 'true');
  return hint;
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
  private structureRow: HTMLElement;
  private coachLine: HTMLElement;
  private structurePips: { wrap: HTMLElement; fill: HTMLElement }[] = [];
  private bloodWrap: HTMLElement;
  private bloodFill: HTMLElement;
  private bloodIntentCb: ((intent: 'heal' | 'burst') => void) | null = null;
  private bloodReady = false;
  private abilityBtn: HTMLButtonElement;
  private abilityIcon: HTMLElement;
  private abilityCd: HTMLElement;
  private abilityCb: (() => void) | null = null;
  private abilityIconName = '';
  private abilityActive = false;
  private abilityHidden = false;

  private loadoutSignature = '';
  private bannerTimer = 0;

  /**
   * Last written value for each text node. Assigning `textContent` replaces the
   * node even when the string is identical, which dirties layout; the timer only
   * changes once a second and the counters change rarely, so guarding these
   * removes most of the HUD's per-frame cost.
   */
  private cache = { hp: '', xp: -1, time: '', level: '', kills: '', gold: '', blood: -1, abilityCd: -1 };

  constructor(private sprites: SpriteTable) {
    this.root = el('div', 'hud');

    // Decorative bars and meters carry `aria-hidden` throughout this file. Each
    // one duplicates something already exposed as text — the xp track is the
    // level chip, the blood orb is the Feast/Frenzy buttons' enabled state, the
    // pip rows are the level in a slot's own title — and a screen reader
    // reading a silent fill percentage on every frame is worse than silence.
    const xpTrack = el('div', 'xp-track');
    xpTrack.setAttribute('aria-hidden', 'true');
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

    // The two things in the HUD that speak rather than display. Both are
    // polite: they arrive between other events and neither is worth cutting
    // off whatever is being read. Their text changes rarely — the banner on a
    // boss event, the coach when the director allows it — so neither turns
    // into a live region that fires every frame.
    this.banner = el('div', 'boss-banner');
    this.banner.setAttribute('role', 'status');
    this.banner.setAttribute('aria-live', 'polite');
    this.structureRow = el('div', 'structure-pips');
    this.coachLine = el('div', 'coach-line');
    this.coachLine.setAttribute('role', 'status');
    this.coachLine.setAttribute('aria-live', 'polite');

    // Bottom-centre thumb zone: the blood orb flanked by Feast / Frenzy taps.
    this.bloodWrap = el('div', 'blood-cluster');
    const feastBtn = el('button', 'blood-btn feast');
    feastBtn.append(el('span', 'blood-btn-label', 'FEAST'), keyHint('Q'));
    const orb = el('div', 'blood-orb');
    orb.setAttribute('aria-hidden', 'true');
    this.bloodFill = el('div', 'blood-fill');
    orb.appendChild(this.bloodFill);
    const frenzyBtn = el('button', 'blood-btn frenzy');
    frenzyBtn.append(el('span', 'blood-btn-label', 'FRENZY'), keyHint('E'));
    this.bloodWrap.append(feastBtn, orb, frenzyBtn);

    const press = (intent: 'heal' | 'burst') => (ev: PointerEvent) => {
      // Primary button/touch only — right/middle click must not latch an
      // intent (and preventDefault here would not suppress the context
      // menu anyway). Not ev.isPrimary: a second simultaneous thumb has
      // isPrimary=false but button=0, and two-thumb presses must work.
      if (ev.button !== 0) return;
      // pointerdown, not click: kills the iOS tap delay/double-fire.
      // stopPropagation keeps this touch away from the future virtual
      // joystick that will share the bottom band (design §8 risk 1).
      ev.preventDefault();
      ev.stopPropagation();
      this.bloodIntentCb?.(intent);
    };
    feastBtn.addEventListener('pointerdown', press('heal'));
    frenzyBtn.addEventListener('pointerdown', press('burst'));

    // Ability button rides the same thumb cluster as the blood taps.
    this.abilityBtn = el('button', 'ability-btn');
    // Icon-only in every state, so its name has to come from somewhere. The
    // label is written alongside `title` in update(), once per ability change.
    this.abilityBtn.setAttribute('aria-label', 'Ability');
    this.abilityIcon = el('div', 'ability-icon');
    this.abilityIcon.setAttribute('aria-hidden', 'true');
    this.abilityCd = el('div', 'ability-cd');
    this.abilityCd.setAttribute('aria-hidden', 'true');
    this.abilityBtn.append(this.abilityIcon, this.abilityCd, keyHint('SPACE'));
    this.abilityBtn.addEventListener('pointerdown', (ev: PointerEvent) => {
      // Same rules as the blood buttons: primary button only, pointerdown not
      // click (kills the iOS tap delay), stopPropagation away from the future
      // virtual joystick sharing the bottom band.
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.abilityCb?.();
    });
    this.bloodWrap.appendChild(this.abilityBtn);

    this.root.append(
      xpTrack,
      left,
      center,
      right,
      loadout,
      this.bloodWrap,
      this.banner,
      this.structureRow,
      this.coachLine,
    );
  }

  /**
   * Puts one coaching line in the strip along the bottom.
   *
   * Deliberately not a banner and never a modal: the strip is a fixed lane
   * between the loadout column and the blood orb, it takes no pointer events,
   * and it holds exactly one short sentence. Nothing about showing a line can
   * cover the fight or swallow a tap. CoachDirector decides *when*; this only
   * decides *where*, and the answer is "out of the way".
   */
  showCoach(text: string): void {
    this.coachLine.textContent = text;
    this.coachLine.classList.add('show');
  }

  hideCoach(): void {
    this.coachLine.classList.remove('show');
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
  }

  showBanner(text: string): void {
    this.banner.textContent = text;
    this.banner.classList.add('show');
    this.bannerTimer = BANNER_SECONDS;
  }

  /**
   * Takes the banner down now, timer and all.
   *
   * The countdown only advances in `update`, which stops being called the
   * moment the HUD is hidden — so a run that ends inside a banner's three
   * seconds (a boss that kills you, a wall that falls as you do) leaves the
   * text parked on a hidden HUD, and the *next* run opens under it. Same
   * reasoning as hideCoach, and startRun calls the pair together.
   */
  hideBanner(): void {
    this.banner.classList.remove('show');
    this.bannerTimer = 0;
  }

  /** Game injects the callback; the HUD never touches gameplay state itself. */
  bindBloodButtons(cb: (intent: 'heal' | 'burst') => void): void {
    this.bloodIntentCb = cb;
  }

  /** Game injects the callback; the HUD never touches gameplay or Input itself. */
  bindAbilityButton(cb: () => void): void {
    this.abilityCb = cb;
  }

  /**
   * Builds one HP pip per structure at run start (Game calls this from
   * startRun — creation has no gameplay event; updates are event-driven).
   * An empty list hides the row: structure-less maps show nothing new.
   */
  setStructurePips(structures: { name: string; hp: number }[]): void {
    this.structurePips = [];
    this.structureRow.replaceChildren();
    this.structureRow.classList.toggle('visible', structures.length > 0);
    for (const s of structures) {
      const wrap = el('div', 'structure-pip');
      wrap.title = s.name;
      const fill = el('div', 'structure-pip-fill');
      wrap.appendChild(fill);
      this.structureRow.appendChild(wrap);
      this.structurePips.push({ wrap, fill });
    }
  }

  /** Driven by the structure:damaged event, like hp-fill. */
  updateStructurePip(index: number, hp: number, maxHp: number): void {
    const pip = this.structurePips[index];
    if (!pip) return;
    const percent = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 0;
    pip.fill.style.width = `${percent}%`;
  }

  /** Driven by the structure:destroyed event. The slot stays, marked lost. */
  destroyStructurePip(index: number): void {
    const pip = this.structurePips[index];
    if (!pip) return;
    pip.fill.style.width = '0%';
    pip.wrap.classList.add('lost');
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

    // Quantised to whole percents, same guard as the hp bar.
    const bloodPercent = Math.round((run.blood / run.bloodMax) * 100);
    if (bloodPercent !== this.cache.blood) {
      this.cache.blood = bloodPercent;
      this.bloodFill.style.height = `${bloodPercent}%`;
    }
    const ready = run.blood >= BLOOD_CONFIG.threshold;
    if (ready !== this.bloodReady) {
      this.bloodReady = ready;
      this.bloodWrap.classList.toggle('ready', ready);
    }

    // Ability button: poll run.ability, cache-guarded to whole percents like
    // every other per-frame write in this class.
    const ability = run.ability;
    const hidden = ability === null;
    if (hidden !== this.abilityHidden) {
      this.abilityHidden = hidden;
      this.abilityBtn.hidden = hidden;
    }
    if (ability) {
      if (ability.def.icon !== this.abilityIconName) {
        this.abilityIconName = ability.def.icon;
        const described = `${ability.def.name} — ${ability.def.description}`;
        this.abilityBtn.title = described;
        // `title` is a tooltip and not reliably announced; the label is what
        // actually names an icon-only button.
        this.abilityBtn.setAttribute('aria-label', described);
        this.abilityIcon.replaceChildren(this.sprites.iconCanvas(ability.def.icon, 32));
      }
      const cdPercent =
        ability.def.cooldown > 0
          ? Math.round((ability.cooldownLeft / ability.def.cooldown) * 100)
          : 0;
      if (cdPercent !== this.cache.abilityCd) {
        this.cache.abilityCd = cdPercent;
        this.abilityCd.style.setProperty('--cd', `${cdPercent}%`);
        this.abilityBtn.classList.toggle('ready', cdPercent === 0);
      }
      const active = ability.activeLeft > 0;
      if (active !== this.abilityActive) {
        this.abilityActive = active;
        this.abilityBtn.classList.toggle('active', active);
      }
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
    // The slot's own title already says "Whip — level 3/8"; a row of unlabelled
    // dots underneath it is decoration.
    wrap.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < maxLevel; i++) {
      wrap.appendChild(el('span', i < level ? 'pip on' : 'pip'));
    }
    return wrap;
  }
}
