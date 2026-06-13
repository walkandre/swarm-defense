"use strict";

// Loads the Kenney tilemap (assets/tilemap.png) and exposes helpers for
// blitting individual 16x16 tiles. The sheet is 18x11 tiles with a 1px gap
// between tiles. Tiles are addressed as [col, row] (0-indexed).
//
// Tile coordinates are keyed by NAME and resolved through the atlas
// (assets/tilemap.atlas.json) when it can be fetched — i.e. when the page is
// served over http (local server, GitHub Pages). The NAMED table below is the
// built-in fallback used when the atlas is unreachable, notably when index.html
// is opened directly via file:// where fetch() is blocked. The atlas overrides
// these by name, so re-pointing a tile in tools/atlas.html re-points it in the
// game without any code change — edit the atlas, tell Claude the name.
const Tileset = {
  TILE: 16,
  GAP: 1,
  img: null,
  ready: false,

  // Selectable sheets (same 18x11 layout, so all tile-coordinate tables apply
  // to either). `src` is the active one; `version` bumps on every successful
  // (re)load so the WebGL renderer knows to re-upload its cached texture.
  SHEETS: ["assets/tilemap.png", "assets/tilemap_space.png"],
  src: "assets/tilemap.png",
  version: 0,

  // The atlas: human-authored tile annotations (name/category/desc per cell),
  // shared by both sheets. Fetched once; `byName` is the resolved name->[col,row]
  // lookup the game reads through, `_flip` carries per-tile mirror hints.
  ATLAS_SRC: "assets/tilemap.atlas.json",
  atlas: null,
  byName: {},
  _flip: {},

  // Asphalt base colour sampled from the road tiles; painted under the road
  // sprites so the curb-curled tile corners read as solid pavement instead of
  // showing grass through the gaps when the path corridor is two cells wide.
  ROAD_BASE: "#52607c",

  // Built-in fallback tile coordinates, mirroring assets/tilemap.atlas.json.
  // The atlas overrides any of these by name once it loads.
  NAMED: {
    // Ground / decoration.
    grass: [0, 0], grass_variant_a: [1, 0], grass_variant_b: [2, 0],
    bush: [5, 0], tree: [4, 5], forest: [4, 6],
    // Airbase units (drawn rotated to heading; art points west).
    plane: [10, 6], heli: [12, 6],
    // Water shores (see WATER_NAMES for the mask->name autotiling map).
    water_open: [1, 2], water_vertical: [3, 3], water_horizontal: [1, 4],
    water_corner_nw: [0, 1], water_corner_ne: [2, 1],
    water_corner_sw: [0, 3], water_corner_se: [2, 3],
    water_shore_n: [1, 1], water_shore_e: [2, 2],
    water_shore_s: [1, 3], water_shore_w: [0, 2],
    // Road pieces (see ROAD_NAMES for the mask->name autotiling map).
    road_isolated: [0, 6],
    road_cap_n: [0, 9], road_cap_e: [1, 6], road_cap_s: [0, 7], road_cap_w: [3, 6],
    road_vertical: [0, 8], road_horizontal: [2, 6],
    road_corner_ne: [1, 9], road_corner_es: [1, 7],
    road_corner_sw: [3, 7], road_corner_nw: [3, 9],
    road_tee_nes: [1, 8], road_tee_esw: [2, 7],
    road_tee_nsw: [3, 8], road_tee_new: [2, 9],
    road_cross: [2, 8],
    // Towers.
    tower_gunner: [12, 2], tower_cannon: [14, 4], tower_sniper: [13, 3],
    tower_frost: [9, 2], tower_airbase: [9, 1],
    // Enemies.
    enemy_grunt: [8, 5], enemy_runner: [5, 7], enemy_tank: [9, 8], enemy_swarmling: [16, 6],
  },

  // --- Declarative specs: map game concepts to atlas tile names. ------------
  // Resolved to [col,row] (or arrays/objects of them) by _resolve().

  // Random ground variants: mostly plain grass with a couple of detailed tiles.
  GRASS_NAMES: ["grass", "grass", "grass", "grass", "grass", "grass",
                "grass_variant_a", "grass_variant_b"],

  // Water auto-tiling (lakes & rivers). Key is a 4-bit mask of which neighbours
  // are also water: N=1 E=2 S=4 W=8. These tiles carry their own grass/sand
  // shore. Single-neighbour caps (1/2/4/8) and the isolated case fall back to a
  // straight/centre tile since the sheet has no dedicated cap.
  WATER_NAMES: {
    0: "water_open",       1: "water_vertical",    2: "water_horizontal",
    3: "water_corner_sw",  4: "water_vertical",    5: "water_vertical",
    6: "water_corner_nw",  7: "water_shore_w",     8: "water_horizontal",
    9: "water_corner_se", 10: "water_horizontal", 11: "water_shore_s",
    12: "water_corner_ne", 13: "water_shore_e",   14: "water_shore_n",
    15: "water_open",
  },

  // Road auto-tiling. Key is a 4-bit mask of path neighbours: N=1 E=2 S=4 W=8.
  // Each tile's open sides (no curb) match its mask, so corridors of any shape
  // resolve to clean roads: curbs trace only the outer edge, corners round off.
  ROAD_NAMES: {
    0: "road_isolated",    1: "road_cap_n",     2: "road_cap_e",      3: "road_corner_ne",
    4: "road_cap_s",       5: "road_vertical",  6: "road_corner_es",  7: "road_tee_nes",
    8: "road_cap_w",       9: "road_corner_nw", 10: "road_horizontal", 11: "road_tee_new",
    12: "road_corner_sw", 13: "road_tee_nsw",  14: "road_tee_esw",   15: "road_cross",
  },

  // Tower structures, colour-matched to each tower's theme.
  TOWER_NAMES: {
    gunner: "tower_gunner", cannon: "tower_cannon", sniper: "tower_sniper",
    frost: "tower_frost", airbase: "tower_airbase",
  },

  // Enemy units. `flip` mirrors the sprite to face left (the march direction);
  // the vehicle sprites already face left, the swarmling soldier faces right.
  ENEMY_NAMES: {
    grunt: { name: "enemy_grunt" },
    runner: { name: "enemy_runner" },
    tank: { name: "enemy_tank" },
    swarmling: { name: "enemy_swarmling", flip: true },
  },

  // --- Resolved tables (filled by _resolve(); read by the rest of the game) -
  // Initialised by the _resolve() call at the bottom of this file, then rebuilt
  // when the atlas loads. Declared here so the shapes are documented in one spot.
  GRASS: null, GRASS_VARIANTS: null, BUSH: null, TREE: null, FOREST: null,
  PLANE: null, HELI: null, WATER: null, ROAD: null, TOWERS: null, ENEMIES: null,

  // Resolve a tile name to its [col,row]. Falls back to grass with a warning so
  // a typo or missing atlas entry shows up loudly rather than crashing.
  tile(name) {
    const c = this.byName[name];
    if (c) return c;
    console.warn("Tileset: unknown tile name '" + name + "'");
    return this.byName.grass || [0, 0];
  },

  // (Re)build byName from the NAMED fallback plus any atlas overrides, then
  // rebuild the resolved tables the game reads.
  _resolve() {
    const byName = {};
    for (const k in this.NAMED) byName[k] = this.NAMED[k];
    const flip = {};
    if (this.atlas && this.atlas.tiles) {
      for (const key in this.atlas.tiles) {
        const t = this.atlas.tiles[key];
        const parts = key.split(",");
        const col = parseInt(parts[0], 10), row = parseInt(parts[1], 10);
        if (!t || !t.name || isNaN(col) || isNaN(row)) continue;
        byName[t.name] = [col, row];
        if (t.flip) flip[t.name] = true;
      }
    }
    this.byName = byName;
    this._flip = flip;

    const at = (n) => this.tile(n);

    this.GRASS = at("grass");
    this.BUSH = at("bush");
    this.TREE = at("tree");
    this.FOREST = at("forest");
    this.PLANE = at("plane");
    this.HELI = at("heli");
    this.GRASS_VARIANTS = this.GRASS_NAMES.map(at);

    this.WATER = {};
    for (const m in this.WATER_NAMES) this.WATER[m] = at(this.WATER_NAMES[m]);
    this.ROAD = {};
    for (const m in this.ROAD_NAMES) this.ROAD[m] = at(this.ROAD_NAMES[m]);

    this.TOWERS = {};
    for (const k in this.TOWER_NAMES) this.TOWERS[k] = at(this.TOWER_NAMES[k]);

    this.ENEMIES = {};
    for (const k in this.ENEMY_NAMES) {
      const spec = this.ENEMY_NAMES[k];
      this.ENEMIES[k] = { tile: at(spec.name), flip: !!(spec.flip || flip[spec.name]) };
    }
  },

  // Load the sprite sheet and the atlas in parallel; `onReady` fires once both
  // settle (the atlas is optional — failure just keeps the built-in coords).
  load(onReady) {
    let pending = 2;
    const done = () => { if (--pending === 0 && onReady) onReady(); };
    this._loadAtlas(done);
    this._loadSrc(this.src, done);
  },

  // Swap to the next sheet in SHEETS and reload. `onReady` fires once it
  // decodes; the canvas renderer picks up `img` automatically, the WebGL
  // renderer re-uploads when it sees `version` change. The atlas is shared by
  // both sheets, so it is not re-fetched here.
  swap(onReady) {
    const next = (this.SHEETS.indexOf(this.src) + 1) % this.SHEETS.length;
    this.src = this.SHEETS[next];
    this._loadSrc(this.src, onReady);
  },

  _loadAtlas(done) {
    fetch(this.ATLAS_SRC)
      .then((r) => (r.ok ? r.json() : Promise.reject("HTTP " + r.status)))
      .then((json) => { this.atlas = json; })
      .catch((err) => {
        console.warn("Tileset: could not load " + this.ATLAS_SRC +
          " (" + err + "); using built-in tile coordinates.");
      })
      .finally(() => { this._resolve(); if (done) done(); });
  },

  _loadSrc(src, onReady) {
    const img = new Image();
    img.onload = () => { this.img = img; this.ready = true; this.version++; if (onReady) onReady(); };
    img.onerror = () => { console.error("Failed to load " + src); if (onReady) onReady(); };
    img.src = src;
  },

  // Blit tile [col,row] into the destination rect. `flip` mirrors horizontally.
  draw(ctx, tile, dx, dy, dw, dh, flip) {
    if (!this.ready) return;
    const step = this.TILE + this.GAP;
    const sx = tile[0] * step;
    const sy = tile[1] * step;
    if (flip) {
      ctx.save();
      ctx.translate(dx + dw, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(this.img, sx, sy, this.TILE, this.TILE, 0, 0, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(this.img, sx, sy, this.TILE, this.TILE, dx, dy, dw, dh);
    }
  },
};

// Resolve the built-in coordinates immediately so every table is valid before
// the sheet/atlas finish loading; _loadAtlas() re-resolves with overrides later.
Tileset._resolve();
