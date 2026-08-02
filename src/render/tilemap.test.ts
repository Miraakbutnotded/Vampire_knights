import { describe, expect, it } from 'vitest';

import { availableMaps, mapChoices, orderMaps } from './tilemap.ts';
import { waveTable } from '../gameplay/content.ts';

/**
 * The arena picker is the front door: the first entry is what a player who
 * presses start without reading gets, and the tags are the only place the game
 * says out loud that one of these nights is a defence. Both are content
 * decisions, so both are pinned here rather than left to whoever edits a map
 * file next.
 */
describe('arena picker order', () => {
  it('leads with the bastion', () => {
    const choices = mapChoices();
    expect(choices.length).toBeGreaterThanOrEqual(4);
    expect(choices[0]!.id).toBe('bastion');
    // Game seeds lastMapId from the same first entry, so leading here is the
    // same statement as defaulting the run.
    expect(availableMaps()[0]).toBe('bastion');
  });

  it('keeps the id list and the choice list the same list', () => {
    expect(availableMaps()).toEqual(mapChoices().map((choice) => choice.id));
    // Deterministic: a total sort, so two calls cannot disagree and the picker
    // cannot reshuffle between boots.
    expect(mapChoices()).toEqual(mapChoices());
  });

  it('gives every shipped map a name and a line of pitch', () => {
    for (const choice of mapChoices()) {
      expect(choice.name, `map "${choice.id}" has no name`).not.toBe(choice.id);
      expect(choice.blurb.length, `map "${choice.id}" has no blurb`).toBeGreaterThan(0);
    }
  });

  it('derives the defence tag from the structures a map actually stands up', () => {
    const byId = new Map(mapChoices().map((choice) => [choice.id, choice]));
    // The bastion is the only shipped map with walls, and it is the only one
    // allowed to advertise them.
    expect(byId.get('bastion')!.defends).toBe(true);
    for (const [id, choice] of byId) {
      if (id !== 'bastion') expect(choice.defends, `"${id}" advertises walls`).toBe(false);
    }
  });

  it('sorts by order, breaks ties alphabetically and puts undecorated maps last', () => {
    const choices = orderMaps([
      { id: 'zeta', json: { order: 1, name: 'Zeta', blurb: 'z' } },
      { id: 'nowhere', json: {} },
      { id: 'alpha', json: { order: 1, name: 'Alpha', blurb: 'a' } },
      { id: 'first', json: { order: 0, name: 'First', blurb: 'f', structures: [{ type: 'gate', x: 0, y: 0 }] } },
      { id: 'anywhere', json: {} },
    ]);
    expect(choices.map((c) => c.id)).toEqual(['first', 'alpha', 'zeta', 'anywhere', 'nowhere']);
    // A file that decorates nothing still appears and still starts.
    expect(choices[4]).toEqual({ id: 'nowhere', name: 'nowhere', blurb: '', defends: false });
    expect(choices[0]!.defends).toBe(true);
  });

  it('opens the bastion with a siege inside the first ninety seconds', () => {
    // The reason the bastion leads is that it is the mode nothing else does.
    // A player meets it in their first run or not at all, and a first run is
    // short — so the first siege has to land while they are still watching.
    const first = waveTable('bastion').sieges[0]!;
    expect(first.at).toBeLessThanOrEqual(90);
    // Small enough to be repelled by a level-2 loadout: this one teaches, the
    // 120s siege tests.
    expect(first.count).toBeLessThanOrEqual(8);
  });
});
