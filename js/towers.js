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
    projectile: "shell", recoil: 6,
  },
  sniper: {
    name: "Sniper", cost: 200, range: 300, damage: 95, fireRate: 0.5,
    color: "#ef476f", desc: "Long range, heavy damage",
    projectile: "rail", recoil: 5,
  },
  frost: {
    name: "Frost", cost: 80, range: 110, damage: 3, fireRate: 0.8,
    color: "#90e0ef", desc: "Pulses: slows all in range",
    slowFactor: 0.45, slowDuration: 1.8,
    projectile: "pulse",
  },
};

// A patch of ground catching fire (flame tongues + rising smoke), spawned
// where a sniper round strikes. Particle data is built here; the simulation is
// purely a function of the effect's age, rendered in drawEffects.
function makeFire(x, y) {
  const dur = 1.8;
  const flames = [];
  for (let i = 0; i < 14; i++) {
    flames.push({
      dx: (Math.random() * 2 - 1) * 6,
      delay: Math.random() * 0.9,
      life: 0.35 + Math.random() * 0.25,
      r: 3 + Math.random() * 3,
      rise: 14 + Math.random() * 16,
    });
  }
  const smoke = [];
  for (let i = 0; i < 8; i++) {
    smoke.push({
      dx: (Math.random() * 2 - 1) * 5,
      delay: 0.15 + Math.random() * 0.7,
      life: 0.6 + Math.random() * 0.4,
      r: 3 + Math.random() * 2,
      rise: 18 + Math.random() * 14,
    });
  }
  return { kind: "fire", x, y, t: dur, dur, flames, smoke };
}

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
    this.recoil = 0; // 1 right after firing, decays to 0 (visual kickback)
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
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt / 0.22);

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
    } else if (this.def.projectile === "rail") {
      // Fast fire-round that may pierce through the enemies behind, and may
      // crit (stun). Flags decided per shot.
      const pierce = Math.random() < 0.25;
      const crit = Math.random() < 0.12;
      projectiles.push(new Projectile(this, target, 900, { pierce, crit }));
      this._ejectCasing(effects, { len: 5, sp: 55, vz: 95, color: "#caa84a", t: 1.1 });
      if (this.def.recoil) this.recoil = 1;
    } else if (this.def.projectile === "shell") {
      projectiles.push(new Projectile(this, target, 240));
      if (this.def.recoil) this.recoil = 1;
    } else {
      projectiles.push(new Projectile(this, target, 460));
      this._ejectCasing(effects);
    }
  }

  // Fling a spent casing out the side of the barrel. It arcs up and bounces on
  // the ground (simulated in drawEffects). Cosmetic only; `opts` lets a tower
  // tune the casing size/throw (e.g. the sniper's larger round).
  _ejectCasing(effects, opts = {}) {
    const side = this.angle + Math.PI / 2 + (Math.random() - 0.5) * 0.7;
    const sp = (opts.sp || 45) + Math.random() * 40;
    const t = opts.t || 0.9;
    effects.push({
      kind: "casing",
      x: this.x, y: this.y - 4,
      z: 5,                                  // height above ground
      vx: Math.cos(side) * sp,
      vy: Math.sin(side) * sp,
      vz: (opts.vz || 70) + Math.random() * 45, // initial upward velocity
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 26,
      len: opts.len || 3.2,
      color: opts.color || "#d9b44a",
      t, dur: t,
    });
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
    // Recoil kicks the structure back along the firing axis.
    const kick = this.recoil * (this.def.recoil || 0);
    const bx = -Math.cos(this.angle) * kick;
    const by = -Math.sin(this.angle) * kick;
    r.sprite(Tileset.TOWERS[this.type], this.cx * cs + off + bx, this.cy * cs + off - 2 + by, size, size);

    // Muzzle flash at the barrel tip in the moment after firing.
    if (kick > 0) {
      const ml = size * 0.5;
      r.glow(this.x + Math.cos(this.angle) * ml, this.y + Math.sin(this.angle) * ml,
        12 * this.recoil, "#ffd9a0", this.recoil * 0.8);
    }

    // Expanding pulse ring for the frost tower.
    if (this.def.projectile === "pulse" && this.pulseAnim > 0) {
      const t = 1 - this.pulseAnim / 0.4;
      r.ring(this.x, this.y, this.def.range * t, "#90e0ef", 3, 0.5 * (1 - t));
    }
  }
}

class Projectile {
  constructor(tower, target, speed, opts = {}) {
    this.x = tower.x;
    this.y = tower.y;
    this.speed = speed;
    this.damage = tower.def.damage;
    this.splash = tower.def.splash || 0;
    this.color = tower.def.color;
    this.kind = tower.def.projectile;
    this.target = target;
    // Bullets home; shells/rails fly straight to a led point.
    this.homing = !tower.def.splash && this.kind !== "rail";
    const lead = this.homing ? 0 : Math.hypot(target.x - this.x, target.y - this.y) / speed;
    this.tx = target.x + target.vx * lead;
    this.ty = target.y + target.vy * lead;
    this.done = false;
    this.trail = []; // flat [x,y,...] history for the bullet/shell trail

    // Fixed travel direction (shells fly straight) — used for the Mach cone.
    const ddx = this.tx - this.x, ddy = this.ty - this.y;
    const dl = Math.hypot(ddx, ddy) || 1;
    this.dirX = ddx / dl;
    this.dirY = ddy / dl;

    // Cannon shells have a chance to be an explosive (warp) round; on impact
    // they have a small chance to ricochet off the enemy instead of detonating.
    this.explosive = this.kind === "shell" && Math.random() < 0.22;
    this.ricochet = false;
    this.life = 0; // countdown once ricocheting

    // Sniper fire-round options.
    this.pierce = !!opts.pierce;
    this.crit = !!opts.crit;
    this.hitList = []; // enemies already struck (so a piercing round hits once each)
  }

  update(dt, enemies, effects) {
    // Sniper fire-round: fly straight at high speed, hit-testing the swept
    // segment so it can't tunnel. Pierces through enemies (each hit once) when
    // flagged; a crit stuns. Each hit catches fire.
    if (this.kind === "rail") {
      const px = this.x, py = this.y;
      this.x += this.dirX * this.speed * dt;
      this.y += this.dirY * this.speed * dt;
      this._recordTrail();
      for (const e of enemies) {
        if (e.dead || this.hitList.includes(e)) continue;
        const rad = e.radius + 3;
        if (segDist2(px, py, this.x, this.y, e.x, e.y) > rad * rad) continue;
        e.damage(this.crit ? this.damage * 1.5 : this.damage);
        e.addShake(2);
        if (this.crit) e.addStun(1.3);
        effects.push(makeFire(e.x, e.y));
        this.hitList.push(e);
        if (!this.pierce) { this.done = true; break; }
      }
      if (this.x < -40 || this.x > GameMap.pixelW + 40 ||
          this.y < -40 || this.y > GameMap.pixelH + 40) {
        this.done = true;
      }
      return;
    }

    // Spent ricochet: coast off-screen along the deflected heading, then expire.
    if (this.ricochet) {
      this.x += this.vrx * dt;
      this.y += this.vry * dt;
      this.life -= dt;
      this._recordTrail();
      if (this.life <= 0 ||
          this.x < -30 || this.x > GameMap.pixelW + 30 ||
          this.y < -30 || this.y > GameMap.pixelH + 30) {
        this.done = true;
      }
      return;
    }

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
    this._recordTrail();
  }

  // Bullets and shells keep a short position history for their trail visuals.
  _recordTrail() {
    if (this.kind !== "bullet" && this.kind !== "shell" && this.kind !== "rail") return;
    this.trail.push(this.x, this.y);
    const cap = this.kind === "rail" ? 20 : this.kind === "shell" ? 24 : 16;
    if (this.trail.length > cap) this.trail.splice(0, this.trail.length - cap);
  }

  explode(x, y, enemies, effects) {
    // Ricochet: a small chance the shell skips off the target, deals a glancing
    // hit, and flies off at an angle to fade out instead of detonating.
    if (this.kind === "shell" && Math.random() < 0.08) {
      if (!this.target.dead) { this.target.damage(this.damage * 0.5); this.target.addShake(2); }
      const inAng = Math.atan2(this.dirY, this.dirX);
      const ang = inAng + (Math.random() < 0.5 ? 1 : -1) *
        (Math.PI * 0.35 + Math.random() * Math.PI * 0.25);
      const sp = this.speed * 0.85;
      this.vrx = Math.cos(ang) * sp;
      this.vry = Math.sin(ang) * sp;
      this.ricochet = true;
      this.life = 0.5;
      effects.push({ kind: "blast", x, y, r: 14, t: 0.18, color: "#ffe1b0" });
      return;
    }

    this.done = true;
    if (this.splash > 0) {
      const radius = this.explosive ? this.splash * 1.5 : this.splash;
      const dmg = this.explosive ? this.damage * 1.5 : this.damage;
      const r2 = radius * radius;
      for (const e of enemies) {
        if (e.dead || dist2(x, y, e.x, e.y) > r2) continue;
        e.damage(dmg);
        e.addShake(2);          // hit units jolt a little
        if (this.explosive) e.addWarp(); // explosive rounds warp/displace them
      }
      if (this.explosive) {
        effects.push({ kind: "warp", x, y, t: 0.4, dur: 0.4, r: radius * 1.5, color: "#c08bff" });
      } else {
        effects.push({ kind: "blast", x, y, r: this.splash, t: 0.25, color: this.color });
      }
    } else if (!this.target.dead) {
      this.target.damage(this.damage);
    }
  }

  draw(r) {
    if (this.kind === "bullet") { this._drawTracer(r); return; }
    if (this.kind === "shell") { this._drawShell(r); return; }
    if (this.kind === "rail") { this._drawRail(r); return; }
    r.disc(this.x, this.y, this.splash > 0 ? 5 : 3, this.color);
  }

  // Sniper round: a blazing fire trail (wide orange under a thin yellow core)
  // capped by a hot, glowing head.
  _drawRail(r) {
    const t = this.trail;
    const n = t.length / 2;
    for (let i = 1; i < n; i++) {
      const a = i / n;
      r.line(t[(i - 1) * 2], t[(i - 1) * 2 + 1], t[i * 2], t[i * 2 + 1],
        "#ff5a1f", 1 + 4 * a, 0.45 * a, true);
    }
    for (let i = 1; i < n; i++) {
      const a = i / n;
      r.line(t[(i - 1) * 2], t[(i - 1) * 2 + 1], t[i * 2], t[i * 2 + 1],
        "#ffd76b", 0.5 + 2 * a, 0.6 * a, true);
    }
    r.glow(this.x, this.y, 9, "#ff8a3c", 0.8);
    r.disc(this.x, this.y, 2.4, "#fff1c0", 1, true);
  }

  // Cannon shell: a supersonic round with a pale vapor trail and a Mach cone of
  // displaced air at its nose. Explosive rounds carry a violet charge aura;
  // ricocheting rounds tumble away and fade.
  _drawShell(r) {
    const fade = this.ricochet ? Math.max(0, Math.min(1, this.life / 0.5)) : 1;
    const t = this.trail;
    const n = t.length / 2;
    // Pale supersonic vapor trail.
    for (let i = 1; i < n; i++) {
      const a = i / n;
      r.line(t[(i - 1) * 2], t[(i - 1) * 2 + 1], t[i * 2], t[i * 2 + 1],
        "#dfe7ef", 3 * a, 0.14 * a * fade);
    }
    // Mach cone: two faint shock lines fanning back from the nose (air being
    // shoved aside). Suppressed once the round is a spent, tumbling ricochet.
    if (!this.ricochet) {
      const bx = -this.dirX, by = -this.dirY;
      const ca = Math.cos(0.32), sa = Math.sin(0.32), L = 16;
      r.line(this.x, this.y, this.x + (bx * ca - by * sa) * L, this.y + (bx * sa + by * ca) * L,
        "#ffffff", 1.5, 0.16);
      r.line(this.x, this.y, this.x + (bx * ca + by * sa) * L, this.y + (-bx * sa + by * ca) * L,
        "#ffffff", 1.5, 0.16);
    }
    if (this.explosive) r.glow(this.x, this.y, 9, "#c08bff", 0.6 * fade);
    // Shell body: metallic core with a warm tip.
    r.disc(this.x, this.y, 4, this.color, fade);
    r.disc(this.x, this.y, 2, "#ffe1b0", fade);
  }

  // Gunner bullet: a glowing tracer with a fading trail and a ground shadow
  // offset slightly below (as if flying a little above the ground).
  _drawTracer(r) {
    const SO = 5; // shadow offset (px below the bullet)
    const t = this.trail;
    const n = t.length / 2;
    // Soft shadow following the trail.
    for (let i = 1; i < n; i++) {
      const a = i / n;
      r.line(t[(i - 1) * 2], t[(i - 1) * 2 + 1] + SO, t[i * 2], t[i * 2 + 1] + SO,
        "#000000", 2.5 * a, 0.15 * a);
    }
    // Glowing tracer streak (additive), brightening toward the head.
    for (let i = 1; i < n; i++) {
      const a = i / n;
      r.line(t[(i - 1) * 2], t[(i - 1) * 2 + 1], t[i * 2], t[i * 2 + 1],
        this.color, 1 + 2 * a, 0.5 * a, true);
    }
    // Head: ground shadow, bloom, hot core.
    r.disc(this.x, this.y + SO, 2.2, "#000000", 0.22);
    r.glow(this.x, this.y, 7, this.color, 0.5);
    r.disc(this.x, this.y, 2.2, "#eaf6ff");
  }
}
