# Build and release

Toolchain, every script and what it actually proves, the art pipeline, and the iOS path.

---

## Toolchain

| piece | version | role |
| --- | --- | --- |
| TypeScript | `~5.7.3` | **The gate.** There is no linter configured. |
| Vite | `^6.0.11` | Dev server and bundler. |
| Vitest | `^4.1.10` | Test runner. |
| Capacitor | `^8.x` | iOS shell (`core`, `ios`, `app`, `haptics`, `preferences`). |
| Python 3 | any | The art scripts. **Stdlib only** — no Pillow, no numpy. |

Runtime dependencies are the Capacitor packages and nothing else. **Every one of them is reached
through a dynamic import behind a fallback**, so the web build and the headless tests run
identically when none of them resolve.

### `tsconfig.json` — the settings that bite

`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
`verbatimModuleSyntax` (type-only imports must say `import type`), `allowImportingTsExtensions`
(imports carry the `.ts` extension), `resolveJsonModule` (content JSON is imported directly),
`noEmit` (Vite does the emitting).

`noUncheckedIndexedAccess` is **off**, which is why the ECS code indexes typed arrays with a
trailing `!` rather than drowning in guards.

### `vite.config.ts` — two non-defaults

- `assetsInlineLimit: 0` — sprite PNGs stay real files so they remain swappable in a built app.
- `test.css.include: [/style\.css/]` — Vitest replaces every CSS import with an empty string by
  default, `?raw` included, which would silently hand the art-unit gate in `ui/metrics.test.ts`
  an empty stylesheet to find no violations in. Scoped to the one file that gate reads.

### `.gitattributes`

`* text=auto eol=lf` normalizes line endings across Windows/macOS/Linux; every binary asset
extension is pinned `binary` so it is never converted. This matters on this repo specifically —
a line-ending-converted PNG is a corrupted PNG.

---

## Scripts

```bash
npm run dev        # Vite dev server at http://localhost:5173 (content JSON hot-reloads)
npm run typecheck  # tsc --noEmit — types only
npm run build      # typecheck, then vite build to dist/
npm test           # vitest run
npm run test:watch # vitest watch
npm run preview    # serve dist/ at :4173
npm run validate:art  # sprite strips vs. the canonical palette and frame rules
npm run cap:sync   # build, then copy dist/ + regenerate the SPM manifest for iOS
npm run verify:ios # cap:sync, then actually compile and link the iOS target
```

### Before pushing

```bash
npm run typecheck && npm test && npm run validate:art
```

Three gates, roughly 30 seconds. `npm run build` runs the typecheck itself, so it is the
superset when you also want a bundle.

---

## `cap:sync` and `verify:ios` are not the same gate

This distinction has cost real time, so it is worth stating plainly.

| | what it runs | what it proves |
| --- | --- | --- |
| `cap:sync` | `npm run build && npx cap sync ios` | The web assets copied and `ios/App/CapApp-SPM/Package.swift` was regenerated. **The Swift toolchain is never invoked.** |
| `verify:ios` | `cap:sync`, then `xcodebuild` for a device Release with signing off | The iOS target actually compiles and links. |

A plugin can appear in the SPM manifest while the target no longer builds. **"SPM picked it up" is
not "it compiles."**

`verify:ios` needs macOS and Xcode, so it is the one gate a non-Mac session cannot run. Say so
plainly rather than inferring the build from a successful sync.

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath ios/DerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

Signing is off because the gate answers "does it compile and link", not "is it distributable" —
that keeps it runnable on any Mac without provisioning profiles.

### `capacitor.config.ts`

| field | why |
| --- | --- |
| `appId: com.stimilon.vampireknights`, `appName: Vampire Knights` | Bundle identity. |
| `webDir: 'dist'` | What `cap sync` copies. |
| `backgroundColor: '#05060a'` | Matches the body background in `style.css`, so the letterbox and any pre-paint flash are the same black as the game's own frame. |
| `loggingBehavior: 'debug'` | Forwards the page console into the native log. Without it a device failure is a black box — the WebView has no inspector attached in the field. |
| `ios.contentInset: 'never'` | The canvas letterboxes itself; WKWebView must never add its own insets. |

---

## The art pipeline

Colour comes from [`../art/palette.md`](../art/palette.md) and nowhere else. **Never start a
second palette.**

Generated images come down through a script rather than being hand-placed, and every script
**quantises to the palette last**, so nothing downstream can undo it.

| script | use it for |
| --- | --- |
| `spritify.py in.png out.png --size 32` | A single generated figure → one game-ready frame. Keys the chroma-green field, crops to the subject, box-samples down, snaps to palette. |
| `sheetify.py sheet.png strip.png --frames 4 --size 32` | A generated multi-pose sheet → one aligned strip. Commits to **one** scale (from the tallest pose) and **one** baseline for every frame, and aligns horizontally by pixel centroid rather than bounding box — otherwise the character grows, shrinks and hops between frames. |
| `animate.py` | A looping walk derived from a *single* finished frame, by copying source pixels to whole-pixel offsets — no interpolation, no blending, no new colours. Frame 0 is byte-identical to the source. Modes: `walk` (scissor/lift/crouch/sway), `float`, `flap`, `blob`. |
| `tilify.py in.png tiles/x.png --size 16 --crop 0.25 --gain 0.72` | A generated texture → a **seamless** ground tile. Overscan folded back as a cross-fade before the palette snap, because `tilemap.ts` draws tiles edge to edge and any first-row/last-row mismatch prints a grid across the map. |
| `repalette.py path.png` | Art that arrived outside the pipeline. Deliberately the narrowest tool: same dimensions, same alpha, same silhouette, every opaque pixel moved to its nearest palette entry. It does **not** resize, crop, key or outline — art that needs that needs `spritify.py`. |
| `drawfx.py [--check]` | The geometric weapon FX — rings, beads, pools, crescents. **Edit this script, not the PNGs.** Their drawn edge *is* their collider, and `spriteScaleForRadius` fits the two together by width, so a ring whose stroke wanders by a pixel reads as a mis-sized hitbox. `--check` re-renders into memory and diffs against what is committed, so an edit that was never run shows up as a failure rather than as art silently disagreeing with its source. |
| `validate-art.py` | The gate — see below. |

Scripts are invoked through `scripts/python.mjs` from npm (`npm run validate:art`) or directly
with `python3 scripts/<name>.py` for the authoring tools.

### `npm run validate:art`

Four failure modes, none of which raise at runtime:

1. **Missing PNG.** A mistyped `src` falls back to a generated placeholder — the game still runs
   and the typo hides.
2. **Strip width not a whole multiple of frame width.** The last frame is silently half-cut.
3. **Off-palette pixel.** How a set drifts off-style one sprite at a time, each addition
   defensible on its own.
4. **A `walk` whose lower third is identical in every frame.** Flawless on the other three counts
   and played back as a character skating across the floor.

That last check is a **floor, not a proof**: it says the legs moved, never that they moved
coherently. Every strip in the repo passes today, the character sheets included — a failure is a
regression, never a pre-existing exception to wave through.

---

## Release checklist

```bash
npm run typecheck            # types
npm test                     # 20 files / 460 tests
npm run validate:art         # palette + frame rules
npm run build                # produces dist/
npm run preview              # sanity-check the built bundle at :4173
```

Then, on a Mac:

```bash
npm run verify:ios           # cap:sync + xcodebuild — the only thing that proves the target links
```

Manual passes the automated gates cannot make, because Renderer/Hud/Screens/TileMap/SpriteTable
need a browser (`npm run dev`):

- **Desktop window**, resized small and large — `--u` and `--ui` agree inside the clamp band, so
  this is the baseline read.
- **A phone in portrait and landscape** — landscape crosses `@media (max-height: 560px)` and turns
  every menu's two regions into lanes. Check that no menu clips.
- **A notched device** — the three DOM layers compose safe-area insets differently; `#ui`
  subtracts the letterbox offset and the other two do not.
- **Audio unlock** — the AudioContext starts on first pointer/touch/**keydown**. Start a run with
  the keyboard only and confirm there is sound.
- **Background and resume** — auto-pause must land on the pause screen and never un-pause itself.

---

## Failure modes worth recognising

| symptom | cause |
| --- | --- |
| Black screen on device, no error | A Capacitor plugin promise that never resolves. Every bridge call in `main.ts` races a 2500 ms deadline for exactly this reason; if you add one, deadline it. See also the thenable-proxy note below. |
| Hangs forever awaiting a plugin | `registerPlugin` returns a Proxy whose get-trap manufactures a method for **any** name, `then` included — so it is accidentally a thenable. **`await` the module namespace and destructure the plugin only afterwards.** `storage.test.ts` pins it. |
| Inputs fire twice after a hot reload | The HMR `dispose()` wiring in `main.ts` was bypassed. It is load-bearing. |
| A grid appears across a map | A tile whose first and last row disagree — it did not go through `tilify.py`. |
| A sprite streaks in from (0,0) | A spawn wrote `x`/`y` directly instead of `world.place(id, x, y)`. |
| A recycled entity carries a stale value | A new component array without a matching reset line in `World.create()`. |
| Content change had no effect | `content.ts` is warn-don't-throw. Check the console: an unknown behavior skips the weapon, an unknown enemy id is filtered from the wave. |
| A `SaveData` field never persists | It was added to the interface but not to `encodeSave`'s explicit literal *and* `migrate()`. |
