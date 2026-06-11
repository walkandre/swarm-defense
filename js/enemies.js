"use strict";

const ENEMY_TYPES = {
  grunt:     { hp: 42,  speed: 55,  radius: 9,  gold: 5,  color: "#e07a5f", mass: 1.0 },
  runner:    { hp: 22,  speed: 105, radius: 7,  gold: 6,  color: "#f2cc8f", mass: 0.6 },
  tank:      { hp: 210, speed: 30,  radius: 14, gold: 16, color: "#9b5de5", mass: 3.0 },
  swarmling: { hp: 10,  speed: 85,  radius: 5,  gold: 2,  color: "#80ed99", mass: 0.3 },
};

class Enemy {
  constructor(type, hpScale, rng, pathIndex = 0) {
    const def = ENEMY_TYPES[type];
    this.type = type;
    this.def = def;
    this.maxHp = Math.round(def.hp * hpScale);
    this.hp = this.maxHp;
    this.radius = def.radius;
    this.mass = def.mass;
    this.baseSpeed = def.speed * (0.9 + rng() * 0.2);

    // Which lane (entry→exit) this enemy follows.
    this.pathIndex = Math.min(pathIndex, GameMap.paths.length - 1);
    this.path = GameMap.paths[this.pathIndex];

    const sp = GameMap.spawnPoint(this.pathIndex);
    const cs = GameMap.CELL;
    this.x = sp.x + rng() * cs;
    this.y = sp.y + (rng() * 2 - 1) * (cs * 0.7);
    this.vx = -this.baseSpeed;
    this.vy = 0;

    // Personal lateral offset from the corridor centerline — spreads the
    // swarm across the path width instead of single-file.
    this.lateral = (rng() * 2 - 1) * (cs * 0.55);
    this.wpIndex = 0;
    this.slowTimer = 0;
    this.slowFactor = 1;
    this.hitFlash = 0;
    this.dead = false;
    this.reachedEnd = false;
    this.wobble = rng() * Math.PI * 2;
  }

  speed() {
    return this.baseSpeed * (this.slowTimer > 0 ? this.slowFactor : 1);
  }

  applySlow(factor, duration) {
    // Keep the strongest slow currently applied.
    if (this.slowTimer <= 0 || factor < this.slowFactor) this.slowFactor = factor;
    this.slowTimer = Math.max(this.slowTimer, duration);
  }

  damage(amount) {
    this.hp -= amount;
    this.hitFlash = 0.1;
    if (this.hp <= 0) this.dead = true;
  }

  // Path distance left to the exit; lower = closer to leaking.
  remainingDist() {
    const wps = this.path.waypoints;
    const i = Math.min(this.wpIndex, wps.length - 1);
    const wp = wps[i];
    return this.path.remaining[i] + Math.hypot(wp.x - this.x, wp.y - this.y);
  }

  update(dt) {
    const wps = this.path.waypoints;

    if (this.wpIndex >= wps.length) {
      // Past the last waypoint: run straight off the left edge.
      this.vx = lerp(this.vx, -this.speed(), 0.2);
      this.vy = lerp(this.vy, 0, 0.2);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (this.x < -20) this.reachedEnd = true;
      this.tickTimers(dt);
      return;
    }

    const wp = wps[this.wpIndex];
    // Aim at the waypoint shifted by our personal lateral offset,
    // perpendicular to the travel direction.
    const next = wps[Math.min(this.wpIndex + 1, wps.length - 1)];
    let dirX = next.x - wp.x, dirY = next.y - wp.y;
    const dl = Math.hypot(dirX, dirY) || 1;
    dirX /= dl; dirY /= dl;
    const targetX = wp.x - dirY * this.lateral;
    const targetY = wp.y + dirX * this.lateral;

    let dx = targetX - this.x, dy = targetY - this.y;
    const d = Math.hypot(dx, dy) || 1;

    const sp = this.speed();
    const desiredX = (dx / d) * sp;
    const desiredY = (dy / d) * sp;
    // Steering: blend velocity toward desired. Stronger correction when
    // off the path (after being shoved around by the swarm).
    const onPath = GameMap.isPath(Math.floor(this.x / GameMap.CELL), Math.floor(this.y / GameMap.CELL));
    const steer = onPath ? 4 : 10;
    this.vx += (desiredX - this.vx) * Math.min(1, steer * dt);
    this.vy += (desiredY - this.vy) * Math.min(1, steer * dt);

    // Tiny wobble so identical units don't move in lockstep.
    this.wobble += dt * 5;
    this.x += this.vx * dt + Math.cos(this.wobble) * 1.5 * dt;
    this.y += this.vy * dt + Math.sin(this.wobble * 1.3) * 1.5 * dt;

    if (d < GameMap.CELL * 0.9) this.wpIndex++;
    this.tickTimers(dt);
  }

  tickTimers(dt) {
    if (this.slowTimer > 0) this.slowTimer -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
  }

  draw(ctx) {
    const r = this.radius;
    const sprite = Tileset.ENEMIES[this.type];
    const size = r * 2.6;
    // Slow tint ring (drawn under the sprite).
    if (this.slowTimer > 0) {
      ctx.beginPath();
      ctx.arc(this.x, this.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(120, 200, 255, 0.85)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    Tileset.draw(ctx, sprite.tile, this.x - size / 2, this.y - size / 2, size, size, sprite.flip);
    // Brief white flash when hit.
    if (this.hitFlash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, this.hitFlash / 0.1) * 0.55;
      ctx.globalCompositeOperation = "lighter";
      ctx.beginPath();
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.restore();
    }
    // Health bar (only when damaged).
    if (this.hp < this.maxHp) {
      const w = r * 2.2;
      const frac = Math.max(0, this.hp / this.maxHp);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(this.x - w / 2, this.y - r - 7, w, 4);
      ctx.fillStyle = frac > 0.5 ? "#7ae582" : frac > 0.25 ? "#ffd166" : "#ef476f";
      ctx.fillRect(this.x - w / 2, this.y - r - 7, w * frac, 4);
    }
  }
}

// Swarm physics: pairwise circle separation via spatial hash. Overlapping
// enemies push each other apart (positional) and trade a little momentum,
// so dense groups jostle and flow like a crowd.
const enemyHash = new SpatialHash(40);

function resolveEnemyCollisions(enemies) {
  enemyHash.clear();
  for (const e of enemies) enemyHash.insert(e);

  for (const e of enemies) {
    enemyHash.queryNeighborhood(e.x, e.y, (other) => {
      if (other === e) return;
      // Process each pair once.
      if (other.x < e.x || (other.x === e.x && other.y <= e.y)) return;
      const minDist = e.radius + other.radius;
      const d2 = dist2(e.x, e.y, other.x, other.y);
      if (d2 >= minDist * minDist || d2 === 0) return;

      const d = Math.sqrt(d2);
      const nx = (other.x - e.x) / d;
      const ny = (other.y - e.y) / d;
      const overlap = minDist - d;
      // Positional correction split by mass: heavy tanks plow through.
      const total = e.mass + other.mass;
      const pushE = overlap * (other.mass / total);
      const pushO = overlap * (e.mass / total);
      e.x -= nx * pushE; e.y -= ny * pushE;
      other.x += nx * pushO; other.y += ny * pushO;
      // Soft momentum exchange along the normal for a bumpy feel.
      const rvx = other.vx - e.vx, rvy = other.vy - e.vy;
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        const imp = vn * 0.35;
        e.vx += nx * imp * (other.mass / total);
        e.vy += ny * imp * (other.mass / total);
        other.vx -= nx * imp * (e.mass / total);
        other.vy -= ny * imp * (e.mass / total);
      }
    });
  }
}
