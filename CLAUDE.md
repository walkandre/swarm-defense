# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Swarm Defense" — a single-page, vanilla-JavaScript canvas tower-defense game. No build step, no bundler, no package manager, no tests, no framework. Source is plain `<script>` files in `js/` plus one sprite sheet in `assets/tilemap.png`.

## Running

Open `index.html` in a browser, or serve the directory statically (e.g. `python3 -m http.server`) and open it. There is nothing to build, lint, or compile.

There is no test framework. To verify visual/gameplay changes you must run it in a browser. (Maps are seeded — see below — so behaviour is reproducible.)

## Code layout and load order

Everything lives in the **global scope**; files communicate through global objects/classes, not modules. The `<script>` order in `index.html` **is** the dependency order and must be preserved:

`util.js` → `tiles.js` → `map.js` → `enemies.js` → `towers.js` → `game.js`

- `util.js` — `mulberry32` (seeded RNG), `randInt`/`clamp`/`lerp`/`dist2`, `SpatialHash`.
- `tiles.js` — `Tileset`: loads the sheet and holds all tile-coordinate constants and autotile tables.
- `map.js` — `GameMap`: procedural terrain (paths, water, decoration) + rendering.
- `enemies.js` — `ENEMY_TYPES`, `Enemy`, and `resolveEnemyCollisions` (swarm separation).
- `towers.js` — `TOWER_TYPES`, `Tower`, `Projectile`.
- `game.js` — `Game` state object plus the loop, input, HUD, waves, and `init()` entry point.

## Architecture

**Game loop / entry.** `init()` (bottom of `game.js`) calls `Tileset.load(start)` — the loop only begins **after** the sprite sheet decodes, so every frame has its sprites. `frame()` runs `update(dt)` then `render()`. `Game` is a single mutable object holding all runtime state (gold, lives, wave, entities). Logic uses logical/CSS-pixel coordinates; the canvas backing store is scaled by `devicePixelRatio` (`Game.dpr`).

**Grid model.** The map is a cell grid (`GameMap.CELL` = 40px). Two boolean grids drive terrain:
- `grid[x][y]` — path/road (non-buildable).
- `water[x][y]` — lakes/rivers (non-buildable).

`canBuild(x,y)` rejects both plus occupied cells (`towersAt[x][y]`). Generation is fully seeded via `mulberry32`, so a given seed reproduces a map exactly.

**Paths.** Each "lane" is a random walk from the right edge to the left (`_buildLane`). The spine is widened to a **2-cell corridor**; `waypoints` trace the corridor centerline. Enemies spawn off the right edge and follow waypoints (`Enemy.update`), with a per-unit lateral offset so the swarm spreads across the corridor width. `path.remaining[]` (cumulative distance to exit) is what towers use to target the enemy closest to leaking.

**Tile rendering & autotiling (the non-obvious part).** The sheet is 18×11 tiles of 16px with a **1px gap** between tiles; `Tileset.draw(ctx, [col,row], …)` handles the addressing and optional horizontal flip. Roads and water are drawn by **4-bit neighbour-mask autotiling**: for each cell, build a mask of which orthogonal neighbours are the same terrain (`N=1 E=2 S=4 W=8`) and look it up in `Tileset.ROAD` / `Tileset.WATER`. These 16-entry tables were derived from the actual tile art (road curb lines; water shores), so **don't hand-edit a mask→tile entry without re-checking the sprite it points at** — a wrong entry shows up as curb/shore artifacts. Edge handling differs by terrain: `_roadMask` treats off-grid as road on the left/right (lanes flow off-screen at entry/exit) but as grass top/bottom; `_waterMask` treats all off-grid as grass so lakes get a shore at the map border. Roads also paint a solid asphalt base color under the tiles (`ROAD_BASE`) so 2-wide corridors read as solid pavement.

**Render order** (`GameMap.draw`, then `game.js render()`): grass ground → water → road base + road tiles → entry-strip extension + entry/exit markers → tree overlays → placement preview → towers → enemies → projectiles → effects → HUD overlays. Pixel-art crispness requires `ctx.imageSmoothingEnabled = false`, set every frame in `render()` because resizing the canvas resets it.

**Towers & combat.** `TOWER_TYPES` is data-driven (cost/range/damage/fireRate/projectile kind). `Tower.update` acquires the most-advanced in-range target and emits the right effect per `projectile` type: `beam` (instant), `shell` (splash `Projectile`), `bullet` (homing `Projectile`), or `pulse` (frost: AoE slow+chip, no projectile). The shop, hotkeys (1–4), and HUD are generated from `TOWER_TYPES` in `game.js`.

**Enemies.** `ENEMY_TYPES` is data-driven. `resolveEnemyCollisions` uses the `SpatialHash` for circle-vs-circle separation with mass-weighted pushback, giving the crowd/swarm feel.

## Conventions

- Adding a tower or enemy type = add an entry to `TOWER_TYPES` / `ENEMY_TYPES` (and a sprite mapping in `Tileset.TOWERS` / `Tileset.ENEMIES`). The shop/HUD/spawn code reads these maps, so no UI wiring is needed.
- New tile-coordinate references go in `tiles.js`, not scattered through the code.
- Keep the global-script model and the `index.html` load order; do not introduce ES modules, imports, or a bundler without converting all files together.
