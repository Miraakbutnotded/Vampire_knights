# Drop your art here

Every path below is already referenced by `src/content/sprites.json` and the map files. Until a PNG
exists at one of these paths, the game paints an animated placeholder shape instead — so it stays
playable while you work. Add the file and it takes over on the next reload. No code or JSON change.

**Sheets are horizontal strips of equal frames.** Frames are assumed *square*, sized by image height,
so a 128×32 PNG is read as four 32×32 frames automatically. Only set `frameW`/`frameH` in
`sprites.json` if your frames aren't square.

Transparency is respected. Keep the art small — the game renders at 480×270 internally, so a 32px
character is already large on screen.

```
player/
  idle.png            walk.png

enemies/
  bat.png             bat_fly.png
  zombie.png          zombie_walk.png
  skeleton.png        skeleton_walk.png
  brute.png           brute_walk.png
  reaper.png          reaper_walk.png
  ghost.png           slime.png          wisp.png
  swarmling.png       warden.png

pickups/
  gem_small.png       gem_med.png        gem_large.png
  coin.png            meat.png           magnet.png        chest.png

weapons/
  slash.png           bolt.png           knife.png         aura.png
  tome.png            fire.png           strike.png        star.png
  enemy_shot.png

tiles/
  grass.png    grass_b.png   grass_c.png   dirt.png        (meadow)
  stone.png    stone_b.png   stone_cracked.png  moss.png   (crypt)
  floor.png    floor_alt.png wall.png                      (arena)
  tree.png     rock.png      grave.png     bush.png
  flower.png   puddle.png
```

Tiles must be exactly the map's `tileSize` square — 16×16 for the meadow and crypt, 32×32 for the
arena. They're drawn as single frames, not strips.

To add a sprite that isn't listed, add an entry to `src/content/sprites.json` naming your file. See the
README at the project root for the full field reference.
