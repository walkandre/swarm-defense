"use strict";

const TOWER_TYPES = {
  gunner: {
    name: "Gunner", cost: 50, range: 95, damage: 7, fireRate: 7,
    color: "#4fc3f7", desc: "Short range, rapid fire",
    projectile: "bullet",
  },
  cannon: {
    name: "Cannon", cost: 120, range: 160, damage: 32, fireRate: 0.9,
    color: "#ffa552", desc: "Mid range, splash damage", splash: 48,
    projectile: "shell",
  },
  sniper: {
    name: "Sniper", cost: 200, range: 300, damage: 95, fireRate: 0.5,
    color: "#ef476f", desc: "Long range, heavy damage",
    projectile: "beam",
  },
  frost: {
    name: "Frost", cost: 80, range: 110, damage: 3, fireRate: 0.8,
    color: "#90e0ef", desc: "Pulses: slows all in range",
    slowFactor: 0.45, slowDuration: 1.8,
    projectile: "pulse",
  },
};

class Tower {
  constructor(type, cx, cy) {
    this.type = type;
    this.def = TOWER_TYPES[type];
    this.cx = cx;
    this.cy = cy;
    const cs = GameMap.CELL;
    this.x = cx * cs + cs / 2;
    this.y = cy * cs + cs / 2;
    this.cooldown = 0;
    this.angle = Math.PI; // face left toward incoming enemies
    this.pulseAnim = 0;
  }

  // Target the enemy closest to the exit (the biggest threat).
  acquireTarget(enemies) {
    let best = null, bestRemaining = Infinity;
    const r2 = this.def.range * this.def.range;
    for (const e of enemies) {
      if (e.dead) continue;
      if (dist2(this.x, this.y, e.x, e.y) > r2) continue;
      const rem = e.remainingDist();
      if (rem < bestRemaining) { bestRemaining = rem; best = e; }
    }
    return best;
  }

  update(dt, enemies, projectiles, effects) {
    this.cooldown -= dt;
    if (this.pulseAnim > 0) this.pulseAnim -= dt;

    if (this.def.projectile === "pulse") {
      if (this.cooldown <= 0) {
        // Slow + chip everything in range; only fire if someone is there.
        let hit = false;
        const r2 = this.def.range * this.def.range;
        for (const e of enemies) {
          if (e.dead || dist2(this.x, this.y, e.x, e.y) > r2) continue;
          e.applySlow(this.def.slowFactor, this.def.slowDuration);
          e.damage(this.def.damage);
          hit = true;
        }
        if (hit) {
          this.cooldown = 1 / this.def.fireRate;
          this.pulseAnim = 0.4;
        }
      }
      return;
    }

    const target = this.acquireTarget(enemies);
    if (!target) return;
    this.angle = Math.atan2(target.y - this.y, target.x - this.x);
    if (this.cooldown > 0) return;
    this.cooldown = 1 / this.def.fireRate;

    if (this.def.projectile === "beam") {
      target.damage(this.def.damage);
      effects.push({ kind: "beam", x1: this.x, y1: this.y, x2: target.x, y2: target.y, t: 0.12, color: this.def.color });
    } else if (this.def.projectile === "shell") {
      projectiles.push(new Projectile(this, target, 240));
    } else {
      projectiles.push(new Projectile(this, target, 460));
    }
  }

  sellValue() {
    return Math.floor(this.def.cost * 0.7);
  }

  draw(r) {
    const cs = GameMap.CELL;
    // Structure sprite, drawn slightly larger than the cell so it reads as a
    // building sitting on the ground.
    const size = cs + 4;
    const off = (cs - size) / 2;
    r.sprite(Tileset.TOWERS[this.type], this.cx * cs + off, this.cy * cs + off - 2, size, size);

    // Expanding pulse ring for the frost tower.
    if (this.def.projectile === "pulse" && this.pulseAnim > 0) {
      const t = 1 - this.pulseAnim / 0.4;
      r.ring(this.x, this.y, this.def.range * t, "#90e0ef", 3, 0.5 * (1 - t));
    }
  }
}

class Projectile {
  constructor(tower, target, speed) {
    this.x = tower.x;
    this.y = tower.y;
    this.speed = speed;
    this.damage = tower.def.damage;
    this.splash = tower.def.splash || 0;
    this.color = tower.def.color;
    this.target = target;
    // Shells fly to a point (lead the target slightly); bullets home.
    this.homing = !tower.def.splash;
    const lead = this.homing ? 0 : Math.hypot(target.x - this.x, target.y - this.y) / speed;
    this.tx = target.x + target.vx * lead;
    this.ty = target.y + target.vy * lead;
    this.done = false;
  }

  update(dt, enemies, effects) {
    let tx = this.tx, ty = this.ty;
    if (this.homing) {
      if (this.target.dead || this.target.reachedEnd) { this.done = true; return; }
      tx = this.target.x; ty = this.target.y;
    }
    const dx = tx - this.x, dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    const step = this.speed * dt;
    if (d <= step + 2) {
      this.explode(tx, ty, enemies, effects);
      return;
    }
    this.x += (dx / d) * step;
    this.y += (dy / d) * step;
  }

  explode(x, y, enemies, effects) {
    this.done = true;
    if (this.splash > 0) {
      const r2 = this.splash * this.splash;
      for (const e of enemies) {
        if (!e.dead && dist2(x, y, e.x, e.y) <= r2) e.damage(this.damage);
      }
      effects.push({ kind: "blast", x, y, r: this.splash, t: 0.25, color: this.color });
    } else if (!this.target.dead) {
      this.target.damage(this.damage);
    }
  }

  draw(r) {
    r.disc(this.x, this.y, this.splash > 0 ? 5 : 3, this.color);
  }
}
