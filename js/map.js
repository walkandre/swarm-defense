"use strict";

// Procedural map: one or more independent "lanes", each a random walk from
// the right edge to the left edge. A lane's spine only ever moves left or
// vertically within one column, so a lane can never self-intersect (lanes
// may cross each other, which just makes for busier chokepoints). The
// corridor is widened to 2 cells so enemies have room to swarm.
const GameMap = {
  CELL: 40,
  // How many entry/exit lanes a fresh map may have. Currently 1–2; widen
  // this range (e.g. [2, 4]) to generate busier maps without other changes.
  laneRange: [1, 2],
  cols: 0,
  rows: 0,
  grid: null,        // grid[x][y] = true if path (not buildable)
  towersAt: null,    // grid[x][y] = Tower or null
  paths: [],         // each: { waypoints: [...], remaining: [...] }
  seed: 0,

  generate(width, height, seed, laneCount) {
    const cs = this.CELL;
    this.pixelW = width;
    this.pixelH = height;
    this.cols = Math.floor(width / cs);
    this.rows = Math.floor(height / cs);
    this.seed = seed;
    const rng = mulberry32(seed);

    if (laneCount == null) laneCount = randInt(rng, this.laneRange[0], this.laneRange[1]);
    this.laneCount = laneCount;

    this.grid = [];
    this.towersAt = [];
    for (let x = 0; x < this.cols; x++) {
      this.grid.push(new Array(this.rows).fill(false));
      this.towersAt.push(new Array(this.rows).fill(null));
    }

    // Spread lane start rows across the map height so they don't stack.
    this.paths = [];
    const usable = this.rows - 4; // leave a top/bottom margin
    for (let lane = 0; lane < laneCount; lane++) {
      const band = usable / laneCount;
      const jitter = (rng() * 2 - 1) * band * 0.25;
      const startY = Math.round(2 + band * (lane + 0.5) + jitter);
      this.paths.push(this._buildLane(rng, startY));
    }

    this._buildWater(rng);
    this._buildDecoration(rng);
  },

  // Scatter lakes (elliptical blobs) and the occasional river across the open
  // grass. Water never overwrites the path, and lakes keep clear of it so the
  // shores stay tidy; a river may cross a road, leaving a natural-looking gap.
  _buildWater(rng) {
    this.water = [];
    for (let x = 0; x < this.cols; x++) this.water.push(new Array(this.rows).fill(false));

    // True if any path cell sits inside the lake's footprint plus a one-cell
    // shore buffer, so a placed lake never touches the road.
    const clearOfPath = (cx, cy, rx, ry) => {
      const ax = rx + 1, ay = ry + 1;
      for (let y = -ay; y <= ay; y++)
        for (let x = -ax; x <= ax; x++)
          if ((x * x) / (ax * ax) + (y * y) / (ay * ay) <= 1 && this.isPath(cx + x, cy + y))
            return false;
      return true;
    };

    let placed = 0;
    const lakeCount = Math.max(1, Math.round((this.cols * this.rows) / 380));
    for (let i = 0; i < lakeCount; i++) {
      const rx = randInt(rng, 2, 4), ry = randInt(rng, 2, 3);
      if (this.cols < 2 * rx + 4 || this.rows < 2 * ry + 4) continue;
      for (let tries = 0; tries < 50; tries++) {
        const cx = randInt(rng, rx + 1, this.cols - rx - 2);
        const cy = randInt(rng, ry + 1, this.rows - ry - 2);
        if (!clearOfPath(cx, cy, rx, ry)) continue;
        for (let y = -ry; y <= ry; y++) {
          for (let x = -rx; x <= rx; x++) {
            const nx = cx + x, ny = cy + y;
            if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) this.water[nx][ny] = true;
          }
        }
        placed++;
        break;
      }
    }

    // A river half the time — or always, if no lake found a home, so every map
    // gets some water.
    if (placed === 0 || rng() < 0.5) this._buildRiver(rng);
  },

  _buildRiver(rng) {
    const width = randInt(rng, 1, 2);
    if (rng() < 0.5) {
      let y = randInt(rng, 3, this.rows - 4);
      for (let x = 0; x < this.cols; x++) {
        if (rng() < 0.3) y += rng() < 0.5 ? -1 : 1;
        y = clamp(y, 2, this.rows - 3);
        for (let w = 0; w < width; w++) {
          const ny = y + w;
          if (ny >= 0 && ny < this.rows && !this.grid[x][ny]) this.water[x][ny] = true;
        }
      }
    } else {
      let x = randInt(rng, 3, this.cols - 4);
      for (let yy = 0; yy < this.rows; yy++) {
        if (rng() < 0.3) x += rng() < 0.5 ? -1 : 1;
        x = clamp(x, 2, this.cols - 3);
        for (let w = 0; w < width; w++) {
          const nx = x + w;
          if (nx >= 0 && nx < this.cols && !this.grid[nx][yy]) this.water[nx][yy] = true;
        }
      }
    }
  },

  // Pick a stable grass variant and optional tree overlay for every open grass
  // cell so the ground has texture and scattered woodland that doesn't flicker
  // each frame. Path and water cells carry no decoration.
  _buildDecoration(rng) {
    const V = Tileset.GRASS_VARIANTS;
    this.deco = [];
    for (let x = 0; x < this.cols; x++) {
      const col = [];
      for (let y = 0; y < this.rows; y++) {
        if (this.grid[x][y] || this.water[x][y]) { col.push(null); continue; }
        const r = rng();
        let overlay = null;
        if (r < 0.05) overlay = Tileset.FOREST;
        else if (r < 0.15) overlay = Tileset.TREE;
        col.push({ grass: V[(rng() * V.length) | 0], overlay });
      }
      this.deco.push(col);
    }
  },

  // Walk a single lane from the right edge to the left, widen it to two
  // cells, and return its corridor-center waypoints plus the cumulative
  // distance from each waypoint to the exit.
  _buildLane(rng, startY) {
    const cs = this.CELL;
    const minY = 1, maxY = this.rows - 3;
    const spine = [];
    let x = this.cols - 1;
    let y = clamp(startY, minY + 2, maxY - 2);
    spine.push({ x, y });

    let lastVertical = 0; // -1 up, 1 down, 0 none
    while (x > 0) {
      if (rng() < 0.45 && spine.length > 2) {
        // Vertical wiggle within this column.
        let dir = rng() < 0.5 ? -1 : 1;
        if (dir === -lastVertical) dir = -dir; // don't immediately undo the last wiggle
        let len = randInt(rng, 2, 5);
        for (let i = 0; i < len; i++) {
          const ny = y + dir;
          if (ny < minY || ny > maxY) break;
          y = ny;
          spine.push({ x, y });
        }
        lastVertical = dir;
      }
      // Always make leftward progress after a wiggle.
      const run = randInt(rng, 2, 4);
      for (let i = 0; i < run && x > 0; i++) {
        x--;
        spine.push({ x, y });
        lastVertical = 0;
      }
    }

    const waypoints = [];
    for (const c of spine) {
      this.grid[c.x][c.y] = true;
      this.grid[c.x][c.y + 1] = true;
      waypoints.push({ x: c.x * cs + cs / 2, y: (c.y + 1) * cs });
    }

    const n = waypoints.length;
    const remaining = new Array(n).fill(0);
    for (let i = n - 2; i >= 0; i--) {
      const a = waypoints[i], b = waypoints[i + 1];
      remaining[i] = remaining[i + 1] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    return { waypoints, remaining };
  },

  isPath(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return this.grid[cx][cy];
  },

  isWater(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return this.water[cx][cy];
  },

  canBuild(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return !this.grid[cx][cy] && !this.water[cx][cy] && !this.towersAt[cx][cy];
  },

  // Spawn just off the right edge, aligned with the given lane's entry.
  spawnPoint(pathIndex) {
    const w0 = this.paths[pathIndex].waypoints[0];
    return { x: w0.x + this.CELL * 2, y: w0.y };
  },

  // 4-bit mask (N=1 E=2 S=4 W=8) of which neighbours are also path; selects
  // the road tile that connects to them. Off the left/right edges the road is
  // treated as continuing (lanes enter at the right edge and exit at the left),
  // so boundary cells flow off-screen instead of getting a curb cap. The
  // top/bottom edges keep their curb since the corridor never reaches them.
  _roadMask(x, y) {
    const p = (nx, ny) => {
      if (nx < 0 || nx >= this.cols) return true;
      if (ny < 0 || ny >= this.rows) return false;
      return this.grid[nx][ny];
    };
    let m = 0;
    if (p(x, y - 1)) m |= 1;
    if (p(x + 1, y)) m |= 2;
    if (p(x, y + 1)) m |= 4;
    if (p(x - 1, y)) m |= 8;
    return m;
  },

  // Like _roadMask but for water: off-grid counts as grass so lakes get a
  // shore at the map edge instead of bleeding open water off-screen.
  _waterMask(x, y) {
    let m = 0;
    if (this.isWater(x, y - 1)) m |= 1;
    if (this.isWater(x + 1, y)) m |= 2;
    if (this.isWater(x, y + 1)) m |= 4;
    if (this.isWater(x - 1, y)) m |= 8;
    return m;
  },

  draw(ctx) {
    const cs = this.CELL;
    // Ground: grass over the whole canvas, including the remainder strip and
    // any partial row/column beyond the cell grid.
    const cols = Math.ceil(this.pixelW / cs);
    const rows = Math.ceil(this.pixelH / cs);
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        const d = (this.deco[x] && this.deco[x][y]) || null;
        Tileset.draw(ctx, d ? d.grass : Tileset.GRASS, x * cs, y * cs, cs, cs);
      }
    }

    // Water: lakes & rivers, auto-tiled with their own shores over the grass.
    for (let x = 0; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        if (!this.water[x][y]) continue;
        Tileset.draw(ctx, Tileset.WATER[this._waterMask(x, y)], x * cs, y * cs, cs, cs);
      }
    }

    // Roads: paint the asphalt base, then overlay the auto-tiled road sprite.
    ctx.fillStyle = Tileset.ROAD_BASE;
    for (let x = 0; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        if (this.grid[x][y]) ctx.fillRect(x * cs, y * cs, cs, cs);
      }
    }
    for (let x = 0; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        if (!this.grid[x][y]) continue;
        const m = this._roadMask(x, y);
        if (m === 15) continue; // fully surrounded: leave smooth asphalt
        Tileset.draw(ctx, Tileset.ROAD[m], x * cs, y * cs, cs, cs);
      }
    }

    // Extend each lane's entry corridor across the remainder strip to the edge.
    for (const path of this.paths) {
      const first = path.waypoints[0];
      const last = path.waypoints[path.waypoints.length - 1];
      const stripX = this.cols * cs;
      ctx.fillStyle = Tileset.ROAD_BASE;
      ctx.fillRect(stripX, first.y - cs, this.pixelW - stripX, cs * 2);
      for (let x = stripX; x < this.pixelW; x += cs) {
        Tileset.draw(ctx, Tileset.ROAD[14], x, first.y - cs, cs, cs); // top lane (E S W)
        Tileset.draw(ctx, Tileset.ROAD[11], x, first.y, cs, cs);      // bottom lane (N E W)
      }
      // Entry (right) / exit (left) markers.
      ctx.fillStyle = "rgba(239, 71, 111, 0.55)";
      ctx.fillRect(this.pixelW - 5, first.y - cs, 5, cs * 2);
      ctx.fillStyle = "rgba(79, 195, 247, 0.55)";
      ctx.fillRect(0, last.y - cs, 5, cs * 2);
    }

    // Tree overlays last so canopies sit above the ground and road edges.
    for (let x = 0; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        const d = this.deco[x][y];
        if (d && d.overlay) Tileset.draw(ctx, d.overlay, x * cs, y * cs, cs, cs);
      }
    }
  },
};
