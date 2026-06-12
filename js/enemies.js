"use strict";

// How long an impact jolt / explosive warp lasts on a hit enemy.
const SHAKE_DUR = 0.18;
const WARP_DUR = 0.4;

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
    this.shakeT = 0;    // impact jolt timer
    this.shakeMag = 0;
    this.warpT = 0;     // explosive-round warp timer
    this.stunT = 0;     // critical-hit disable timer (can't move while > 0)
    this.animClock = 0; // local time accumulator for effect animation phase
    this.dead = false;
    this.reachedEnd = false;
    this.wobble = rng() * Math.PI * 2;
  }

  // Critical hit: freeze the enemy in place for `dur` seconds.
  addStun(dur) {
    this.stunT = Math.max(this.stunT, dur);
  }

  // Brief positional jitter from a hit (kept to the strongest pending jolt).
  addShake(mag) {
    this.shakeT = SHAKE_DUR;
    this.shakeMag = Math.max(this.shakeMag, mag);
  }

  // Explosive round: squash/stretch + violent jolt, as if warped/displaced.
  addWarp() {
    this.warpT = WARP_DUR;
    this.addShake(3);
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
    // Stunned (critical hit): hold position — still tick timers and absorb
    // shoves from the swarm via resolveEnemyCollisions, just don't advance.
    if (this.stunT > 0) {
      this.tickTimers(dt);
      return;
    }

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
    if (this.shakeT > 0) this.shakeT -= dt;
    if (this.warpT > 0) this.warpT -= dt;
    if (this.stunT > 0) this.stunT -= dt;
    this.animClock += dt;
  }

  draw(rd) {
    const r = this.radius;
    const sprite = Tileset.ENEMIES[this.type];
    const size = r * 2.6;

    // Impact shake offsets the whole unit; an explosive warp also squashes and
    // stretches the sprite (non-uniform scale) for a displaced look.
    let ox = 0, oy = 0, sw = size, sh = size;
    if (this.shakeT > 0) {
      const m = this.shakeMag * (this.shakeT / SHAKE_DUR);
      ox += (Math.random() * 2 - 1) * m;
      oy += (Math.random() * 2 - 1) * m;
    }
    if (this.warpT > 0) {
      const wf = this.warpT / WARP_DUR;
      const osc = Math.sin((WARP_DUR - this.warpT) * 46);
      sw = size * (1 + osc * 0.55 * wf);
      sh = size * (1 - osc * 0.55 * wf);
    }
    const x = this.x + ox, y = this.y + oy;
    // Freezing strength while slowed (fades out over the last 0.8s of the slow).
    const frz = this.slowTimer > 0 ? Math.min(1, this.slowTimer / 0.8) : 0;

    rd.sprite(sprite.tile, x - sw / 2, y - sh / 2, sw, sh, sprite.flip);
    // Freeze: icy body tint + frost rim + a couple of glinting crystals.
    if (frz > 0) {
      rd.disc(x, y, r * 1.15, "#a9dcff", 0.42 * frz);
      rd.ring(x, y, r + 2, "#dff4ff", 1.5, 0.5 * frz, true);
      for (let k = 0; k < 2; k++) {
        const a = this.animClock * 5 + k * 3.14159;
        rd.disc(x + Math.cos(a) * r, y + Math.sin(a) * r, 1, "#ffffff", 0.7 * frz, true);
      }
    }
    // Warp aura while displaced.
    if (this.warpT > 0) {
      rd.glow(x, y, r + 6, "#c08bff", 0.5 * (this.warpT / WARP_DUR));
    }
    // Stun crackle: a pulsing ring plus little sparks orbiting overhead.
    if (this.stunT > 0) {
      const c = this.animClock;
      rd.ring(x, y, r + 4, "#ffe066", 1.5, 0.4 + 0.4 * Math.sin(c * 18), true);
      for (let k = 0; k < 3; k++) {
        const ang = c * 7 + k * 2.094;
        rd.disc(x + Math.cos(ang) * (r + 4), y - r - 4 + Math.sin(ang) * 2.5,
          1.4, "#fff2a0", 0.9, true);
      }
    }
    // Brief white flash when hit.
    if (this.hitFlash > 0) {
      rd.disc(x, y, r, "#ffffff", Math.min(1, this.hitFlash / 0.1) * 0.55, true);
    }
    // Health bar (only when damaged).
    if (this.hp < this.maxHp) {
      const w = r * 2.2;
      const frac = Math.max(0, this.hp / this.maxHp);
      rd.rect(x - w / 2, y - r - 7, w, 4, "rgba(0,0,0,0.6)");
      rd.rect(x - w / 2, y - r - 7, w * frac, 4,
        frac > 0.5 ? "#7ae582" : frac > 0.25 ? "#ffd166" : "#ef476f");
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
