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

  canBuild(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return !this.grid[cx][cy] && !this.towersAt[cx][cy];
  },

  // Spawn just off the right edge, aligned with the given lane's entry.
  spawnPoint(pathIndex) {
    const w0 = this.paths[pathIndex].waypoints[0];
    return { x: w0.x + this.CELL * 2, y: w0.y };
  },

  draw(ctx) {
    const cs = this.CELL;
    // Base fill so the remainder strip beyond the grid blends in.
    ctx.fillStyle = "#1a1e25";
    ctx.fillRect(0, 0, this.pixelW, this.pixelH);
    // Buildable ground with a subtle checker.
    for (let x = 0; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        if (this.grid[x][y]) continue;
        ctx.fillStyle = (x + y) % 2 === 0 ? "#1c2027" : "#1a1e25";
        ctx.fillRect(x * cs, y * cs, cs, cs);
      }
    }
    // Path corridor.
    for (let x = 0; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        if (!this.grid[x][y]) continue;
        ctx.fillStyle = "#2e3445";
        ctx.fillRect(x * cs, y * cs, cs, cs);
      }
    }
    // Per-lane decoration: chevrons, entry corridor extension, and markers.
    for (const path of this.paths) {
      const wps = path.waypoints;
      ctx.strokeStyle = "rgba(138, 147, 166, 0.25)";
      ctx.lineWidth = 2;
      for (let i = 4; i < wps.length - 1; i += 6) {
        const a = wps[i], b = wps[i + 1];
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.save();
        ctx.translate(a.x, a.y);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(6, -7);
        ctx.lineTo(-4, 0);
        ctx.lineTo(6, 7);
        ctx.stroke();
        ctx.restore();
      }
      const first = wps[0];
      const last = wps[wps.length - 1];
      // Extend the entry corridor across the remainder strip to the edge.
      ctx.fillStyle = "#2e3445";
      ctx.fillRect(this.cols * cs, first.y - cs, this.pixelW - this.cols * cs, cs * 2);
      // Entry (right) / exit (left) markers.
      ctx.fillStyle = "rgba(239, 71, 111, 0.35)";
      ctx.fillRect(this.pixelW - 6, first.y - cs, 6, cs * 2);
      ctx.fillStyle = "rgba(79, 195, 247, 0.35)";
      ctx.fillRect(0, last.y - cs, 6, cs * 2);
    }
  },
};
