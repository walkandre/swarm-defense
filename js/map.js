"use strict";

// Procedural map: a random walk from the right edge to the left edge.
// The path "spine" only ever moves left or vertically within one column,
// so it can never self-intersect. The corridor is widened to 2 cells so
// enemies have room to swarm.
const GameMap = {
  CELL: 40,
  cols: 0,
  rows: 0,
  grid: null,        // grid[x][y] = true if path (not buildable)
  towersAt: null,    // grid[x][y] = Tower or null
  waypoints: [],     // corridor-center points, right to left
  remaining: [],     // remaining[i] = path distance from waypoint i to the exit
  seed: 0,

  generate(width, height, seed) {
    const cs = this.CELL;
    this.cols = Math.floor(width / cs);
    this.rows = Math.floor(height / cs);
    this.seed = seed;
    const rng = mulberry32(seed);

    this.grid = [];
    this.towersAt = [];
    for (let x = 0; x < this.cols; x++) {
      this.grid.push(new Array(this.rows).fill(false));
      this.towersAt.push(new Array(this.rows).fill(null));
    }

    // Spine walk: y is the top row of the 2-cell-wide corridor.
    const minY = 1, maxY = this.rows - 3;
    const spine = [];
    let x = this.cols - 1;
    let y = randInt(rng, minY + 2, maxY - 2);
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

    // Widen to 2 cells and build waypoints at the corridor center.
    this.waypoints = [];
    for (const c of spine) {
      this.grid[c.x][c.y] = true;
      this.grid[c.x][c.y + 1] = true;
      this.waypoints.push({ x: c.x * cs + cs / 2, y: (c.y + 1) * cs });
    }

    // Cumulative distance from each waypoint to the exit (used for
    // "closest to exit" targeting).
    const n = this.waypoints.length;
    this.remaining = new Array(n).fill(0);
    for (let i = n - 2; i >= 0; i--) {
      const a = this.waypoints[i], b = this.waypoints[i + 1];
      this.remaining[i] = this.remaining[i + 1] + Math.hypot(b.x - a.x, b.y - a.y);
    }
  },

  isPath(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return this.grid[cx][cy];
  },

  canBuild(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return !this.grid[cx][cy] && !this.towersAt[cx][cy];
  },

  spawnPoint() {
    const w0 = this.waypoints[0];
    return { x: w0.x + this.CELL * 2, y: w0.y };
  },

  draw(ctx) {
    const cs = this.CELL;
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
    // Direction chevrons along the corridor.
    ctx.strokeStyle = "rgba(138, 147, 166, 0.25)";
    ctx.lineWidth = 2;
    for (let i = 4; i < this.waypoints.length - 1; i += 6) {
      const a = this.waypoints[i], b = this.waypoints[i + 1];
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
    // Entry / exit markers.
    const first = this.waypoints[0];
    const last = this.waypoints[this.waypoints.length - 1];
    ctx.fillStyle = "rgba(239, 71, 111, 0.35)";
    ctx.fillRect(this.cols * cs - 6, (first.y - cs), 6, cs * 2);
    ctx.fillStyle = "rgba(79, 195, 247, 0.35)";
    ctx.fillRect(0, (last.y - cs), 6, cs * 2);
  },
};
