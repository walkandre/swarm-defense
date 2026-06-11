"use strict";

// Loads the Kenney tilemap (assets/tilemap.png) and exposes helpers for
// blitting individual 16x16 tiles. The sheet is 18x11 tiles with a 1px gap
// between tiles. Tiles are addressed as [col, row] (0-indexed).
const Tileset = {
  TILE: 16,
  GAP: 1,
  img: null,
  ready: false,

  // Asphalt base colour sampled from the road tiles; painted under the road
  // sprites so the curb-curled tile corners read as solid pavement instead of
  // showing grass through the gaps when the path corridor is two cells wide.
  ROAD_BASE: "#52607c",

  // Ground.
  GRASS: [0, 0],
  GRASS_VARIANTS: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [2, 0]],
  BUSH: [5, 0],
  TREE: [4, 5],     // single pine
  FOREST: [4, 6],   // pair of pines

  // Water auto-tiling (lakes & rivers). Key is a 4-bit mask of which
  // neighbours are also water: N=1 E=2 S=4 W=8. These tiles carry their own
  // grass/sand shore, so a water body blends into the grass it's drawn over.
  // Single-neighbour caps (1/2/4/8) and the isolated case fall back to a
  // straight/centre tile since the sheet has no dedicated cap.
  WATER: {
    0:  [1, 2],       // isolated (fallback: open water)
    1:  [3, 3],       // N        (fallback: vertical)
    2:  [1, 4],       // E        (fallback: horizontal)
    3:  [0, 3],       // N E  (SW outer corner)
    4:  [3, 3],       // S        (fallback: vertical)
    5:  [3, 3],       // N S  (vertical river)
    6:  [0, 1],       // E S  (NW outer corner)
    7:  [0, 2],       // N E S (W shore edge)
    8:  [1, 4],       // W        (fallback: horizontal)
    9:  [2, 3],       // N W  (SE outer corner)
    10: [1, 4],       // E W  (horizontal river)
    11: [1, 3],       // N E W (S shore edge)
    12: [2, 1],       // S W  (NE outer corner)
    13: [2, 2],       // N S W (E shore edge)
    14: [1, 1],       // E S W (N shore edge)
    15: [1, 2],       // open water
  },

  // Road auto-tiling. Key is a 4-bit mask of path neighbours: N=1 E=2 S=4 W=8.
  // Each tile's open sides (no curb) match its mask, so corridors of any shape
  // resolve to clean roads: curbs trace only the outer edge, corners round off.
  ROAD: {
    0:  [0, 6],            // isolated
    1:  [0, 9],            // N
    2:  [1, 6],            // E
    3:  [1, 9],            // N E  (corner)
    4:  [0, 7],            // S
    5:  [0, 8],            // N S  (vertical straight)
    6:  [1, 7],            // E S  (corner)
    7:  [1, 8],            // N E S (tee)
    8:  [3, 6],            // W
    9:  [3, 9],            // N W  (corner)
    10: [2, 6],            // E W  (horizontal straight)
    11: [2, 9],            // N E W (tee)
    12: [3, 7],            // S W  (corner)
    13: [3, 8],            // N S W (tee)
    14: [2, 7],            // E S W (tee)
    15: [2, 8],            // N E S W (cross)
  },

  // Tower structures, colour-matched to each tower's theme.
  TOWERS: {
    gunner: [12, 2],       // blue turret
    cannon: [14, 4],       // orange fort
    sniper: [13, 3],       // red missile launcher
    frost:  [9, 2],        // blue bunker
  },

  // Enemy units. `flip` mirrors the sprite so it faces left (the march
  // direction); the vehicle sprites already face left, the soldier faces right.
  ENEMIES: {
    grunt:     { tile: [8, 5] },              // grey tank
    runner:    { tile: [5, 7] },              // blue jeep
    tank:      { tile: [9, 8] },              // red heavy tank
    swarmling: { tile: [16, 6], flip: true }, // green soldier
  },

  load(onReady) {
    const img = new Image();
    img.onload = () => { this.ready = true; onReady(); };
    img.onerror = () => { console.error("Failed to load tilemap.png"); onReady(); };
    img.src = "assets/tilemap.png";
    this.img = img;
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
