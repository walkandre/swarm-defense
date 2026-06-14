"use strict";

// Base towers. Any base may carry a `variants` map of advanced versions: same
// category/sprite, different stats and behaviour. The shop shows the base in the
// bar and the variants in a hover popover. Variants are flattened into
// TOWER_DEFS below so the rest of the game can treat any tower id uniformly.
const TOWER_TYPES = {
  gunner: {
    name: "Gunner", cost: 50, range: 95, damage: 7, fireRate: 7,
    color: "#4fc3f7", desc: "Short range, rapid fire",
    projectile: "bullet",
    variants: {
      "gunner-twin": {
        name: "Twin Gunner", cost: 85, range: 90, damage: 5, fireRate: 12,
        color: "#7fd8ff", desc: "Two barrels: fast, scattering fire — sprays bullets, misses more",
        projectile: "bullet", barrels: 2, spread: 0.22,
      },
    },
  },
  cannon: {
    name: "Cannon", cost: 120, range: 160, damage: 32, fireRate: 0.9,
    color: "#ffa552", desc: "Mid range, splash damage", splash: 48,
    projectile: "shell", recoil: 6,
    variants: {
      "cannon-barrage": {
        name: "Missile Barrage", cost: 200, range: 175, damage: 13, fireRate: 0.22,
        color: "#ff7043", desc: "Locks on and salvos 5–10 curving homing missiles",
        splash: 34, projectile: "missile",
      },
    },
  },
  sniper: {
    name: "Sniper", cost: 200, range: 300, damage: 95, fireRate: 0.5,
    color: "#ef476f", desc: "Long range, heavy damage",
    projectile: "rail", recoil: 5,
    variants: {
      "sniper-laser": {
        name: "Laser Marksman", cost: 300, range: 340, damage: 120, fireRate: 0.4,
        color: "#ff2d55", desc: "Paints a target with a tracking laser; criticals freeze it solid",
        projectile: "snipe", recoil: 5,
        charge: 1.1, critChance: 0.35, freeze: 2.2,
      },
    },
  },
  frost: {
    name: "Frost", cost: 80, range: 110, damage: 3, fireRate: 0.8,
    color: "#90e0ef", desc: "Pulses: slows all in range",
    slowFactor: 0.45, slowDuration: 1.8,
    projectile: "pulse",
  },
  airbase: {
    name: "Airbase", cost: 240, range: 210, damage: 36, fireRate: 0.25,
    color: "#9ccc65", desc: "Scrambles a flight of jets that circle, then strafe the lane with bombs",
    splash: 44, projectile: "airstrike", air: "jets",
    variants: {
      "airbase-apache": {
        name: "Apache Wing", cost: 340, range: 230, damage: 36, fireRate: 0.2,
        color: "#aed581", desc: "Deploys an Apache gunship that holds station and rockets the swarm",
        splash: 44, projectile: "airstrike", air: "heli",
      },
    },
  },
};

// Flat registry of every placeable tower — bases plus advanced variants —
// keyed by id. Anything that resolves a tower's definition (placement, the
// Tower instance, the preview) looks here; the shop bar/hotkeys still iterate
// TOWER_TYPES so only the bases get a slot. A variant records its `base` so it
// can borrow the base sprite (Tileset.TOWERS) without its own art.
const TOWER_DEFS = {};
for (const [id, def] of Object.entries(TOWER_TYPES)) {
  def.id = id;
  TOWER_DEFS[id] = def;
  if (def.variants) {
    for (const [vid, vdef] of Object.entries(def.variants)) {
      vdef.id = vid;
      vdef.base = id;
      TOWER_DEFS[vid] = vdef;
    }
  }
}

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

// Red targeting reticle the missile launcher paints on a locked enemy: a ring
// with four corner brackets that sweeps in from wide and tightens as the launch
// approaches (p: 0 → 1), so the lock visibly "finds" its target.
function drawReticle(r, x, y, radius, p) {
  const lock = radius + 5;
  const rad = lock + (1 - p) * 20;
  const al = 0.35 + 0.5 * p;
  r.ring(x, y, rad, "#ff3b3b", 1.4, al);
  const spin = p * 1.6;
  for (let k = 0; k < 4; k++) {
    const a = spin + k * (Math.PI / 2);
    const c = Math.cos(a), s = Math.sin(a);
    const bx = x + c * rad, by = y + s * rad;
    r.line(bx, by, bx - s * 4, by + c * 4, "#ff5b5b", 1.6, al, true); // tangential
    r.line(bx, by, bx - c * 4, by - s * 4, "#ff5b5b", 1.6, al, true); // radial
  }
  if (p > 0.96) r.disc(x, y, 1.6, "#ff3b3b", 0.85, true); // locked
}

// An enemy boiled away by the laser: a brief hot flash, rising vapor wisps, and
// (fed separately in render) a burst of heat-haze that warps the scene where the
// body was — the same shimmer the charging emitter gives off. Particle data is
// built once; the simulation is a pure function of the effect's age.
function makeEvaporate(x, y, radius) {
  const dur = 0.75;
  const wisps = [];
  for (let i = 0; i < 11; i++) {
    wisps.push({
      dx: (Math.random() * 2 - 1) * radius * 0.9,
      delay: Math.random() * 0.22,
      life: 0.35 + Math.random() * 0.3,
      r: radius * 0.35 + Math.random() * radius * 0.5,
      rise: radius * 1.6 + Math.random() * radius * 2.2,
    });
  }
  return { kind: "evaporate", x, y, t: dur, dur, radius, wisps };
}

class Tower {
  constructor(type, cx, cy) {
    this.type = type;
    this.def = TOWER_DEFS[type];
    this.spriteKey = this.def.base || type; // variants reuse the base sprite
    this.cx = cx;
    this.cy = cy;
    const cs = GameMap.CELL;
    this.x = cx * cs + cs / 2;
    this.y = cy * cs + cs / 2;
    this.cooldown = 0;
    // Structures can now be shot by armed enemies. HP scales with cost (a
    // def.hp override wins if present); destroyed towers are removed in update().
    this.maxHp = this.def.hp || Math.round(60 + this.def.cost * 0.8);
    this.hp = this.maxHp;
    this.hitFlash = 0; // brief white/red flash when struck
    this.dead = false;
    this.angle = Math.PI; // face left toward incoming enemies
    this.pulseAnim = 0;
    this.recoil = 0; // 1 right after firing, decays to 0 (visual kickback)
    this.muzzle = 0; // 1 right after a scatter shot, for the twin-barrel flash
    this.freeze = 0; // frost field strength 0..1 (builds while in action)
    this.clock = 0;  // local time accumulator for aura animation
    this.barrage = null; // active missile salvo state (barrage cannon only)
    this.aim = null;     // active charge-and-fire lock (laser marksman only)
    this.planes = [];    // jets in the air (airbase only): circle → strafe run
    this.bombs = [];     // bombs falling from those jets (airbase only)
    this.heli = null;    // rare Apache gunship hovering in front (airbase only)
    this.heliShots = []; // small missiles fired by that gunship
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

  // Pick a random live enemy inside range (the salvo scatters across the swarm
  // rather than dogpiling the single most-advanced target).
  _randTargetInRange(enemies, r2) {
    const pool = [];
    for (const e of enemies) {
      if (e.dead || e.reachedEnd) continue;
      if (dist2(this.x, this.y, e.x, e.y) > r2) continue;
      pool.push(e);
    }
    return pool.length ? pool[(Math.random() * pool.length) | 0] : null;
  }

  // Missile-barrage cannon. Each firing schedules a salvo of 5–10 missiles that
  // launch over ~1.6s; each one locks a (red-reticled) target and is loosed on
  // its own timer. Missiles fly themselves (curving, accelerating) once airborne.
  _updateBarrage(dt, enemies, projectiles, effects) {
    const r2 = this.def.range * this.def.range;
    const target = this.acquireTarget(enemies);
    if (target) this.angle = Math.atan2(target.y - this.y, target.x - this.x);

    if (this.barrage) {
      this.barrage.t += dt;
      for (const s of this.barrage.shots) {
        if (s.fired || this.barrage.t < s.at) continue;
        // Re-validate the lock at launch; grab another target if it's gone.
        let tgt = s.target;
        if (!tgt || tgt.dead || tgt.reachedEnd) tgt = this._randTargetInRange(enemies, r2);
        s.fired = true;
        s.target = tgt;
        if (tgt) projectiles.push(new Projectile(this, tgt, 45));
      }
      if (this.barrage.t >= this.barrage.dur && this.barrage.shots.every((s) => s.fired)) {
        this.barrage = null;
      }
    }

    // cooldown was already decremented at the top of update(); start a fresh
    // salvo once it's elapsed and something is in range.
    if (!this.barrage && this.cooldown <= 0 && target) {
      const count = randInt(Math.random, 5, 10);
      const dur = 1.6;
      const shots = [];
      for (let i = 0; i < count; i++) {
        shots.push({ at: Math.random() * dur, target: this._randTargetInRange(enemies, r2), fired: false });
      }
      shots.sort((a, b) => a.at - b.at);
      this.barrage = { t: 0, dur, shots };
      this.cooldown = 1 / this.def.fireRate;
    }
  }

  // Laser Marksman. Locks the most-advanced target, tracks it with a red laser
  // for `charge` seconds, then lands one heavy hit. The crit is decided at lock:
  // a crit charge spooks the target (it panics and may bolt) and freezes it on
  // hit; an ordinary charge tracks quietly and just hits hard.
  _updateLaserSnipe(dt, enemies, effects) {
    const r2 = this.def.range * this.def.range;
    if (this.aim) {
      const e = this.aim.target;
      if (!e || e.dead || e.reachedEnd || dist2(this.x, this.y, e.x, e.y) > r2) {
        this.aim = null; // lost the mark — re-acquire next frame
      } else {
        this.angle = Math.atan2(e.y - this.y, e.x - this.x);
        this.aim.t += dt;
        if (this.aim.crit) e.applyStress(0.25); // only crit charges scare them
        if (this.aim.t >= this.aim.dur) {
          this._fireSnipe(e, this.aim.crit, effects);
          this.aim = null;
          this.cooldown = 1 / this.def.fireRate;
        }
        return;
      }
    }
    if (this.cooldown <= 0) {
      const target = this.acquireTarget(enemies);
      if (target) {
        this.angle = Math.atan2(target.y - this.y, target.x - this.x);
        this.aim = { target, t: 0, dur: this.def.charge, crit: Math.random() < this.def.critChance };
      }
    }
  }

  _fireSnipe(e, crit, effects) {
    const dmg = crit ? this.def.damage * 1.6 : this.def.damage;
    e.damage(dmg);
    e.addShake(3);
    spawnDamage(effects, e.x, e.y, dmg, e.x - this.x, e.y - this.y, crit);
    // A laser kill doesn't just explode — the body boils off into vapor.
    if (e.dead) effects.push(makeEvaporate(e.x, e.y, e.radius));
    if (crit) {
      // Freeze the panicked target solid, thawing into a brief slow afterward.
      e.addStun(this.def.freeze);
      e.applySlow(0.15, this.def.freeze + 0.8);
      effects.push({ kind: "blast", x: e.x, y: e.y, r: 16, t: 0.22, color: "#9fe0ff" });
    }
    // Instant laser bolt from the barrel to the mark (hotter red on a crit).
    effects.push({ kind: "beam", x1: this.x, y1: this.y, x2: e.x, y2: e.y, t: 0.14,
      color: crit ? "#ff2d55" : "#ff6b8a" });
    this.recoil = 1;
  }

  // Airbase. When ready and a target is in range it scrambles a jet, which
  // first circles the tower (spinning up) then breaks off on a straight strafing
  // run aimed over the swarm, releasing a couple of bombs as it passes. Jets and
  // their falling bombs are simulated here (they need the enemy list) and drawn
  // overhead in drawAir(); bomb impacts deal the tower's splash damage.
  _updateAirstrike(dt, enemies, effects) {
    const target = this.acquireTarget(enemies);
    if (target) this.angle = Math.atan2(target.y - this.y, target.x - this.x);

    if (this.cooldown <= 0 && target) {
      if (this.def.air === "heli") {
        // Apache Wing: hold a single gunship on station; only redeploy once the
        // current one has flown off (so it loiters and rockets the swarm).
        if (!this.heli) {
          this._launchHeli(target);
          this.cooldown = 1 / this.def.fireRate;
        }
      } else {
        // Scramble a formation of 2–3 jets; they enter the orbit spread apart
        // and peel off into their strafing runs one after another.
        const count = randInt(Math.random, 2, 3);
        for (let i = 0; i < count; i++) this._launchPlane(target, i, count);
        this.cooldown = 1 / this.def.fireRate;
      }
    }

    for (const p of this.planes) this._updatePlane(p, dt, enemies);
    for (const b of this.bombs) this._updateBomb(b, dt, enemies, effects);
    if (this.heli) this._updateHeli(dt, enemies, effects);
    for (const s of this.heliShots) this._updateHeliShot(s, dt, enemies, effects);
    if (this.bombs.length) this.bombs = this.bombs.filter((b) => !b.dead);
    if (this.planes.length) this.planes = this.planes.filter((p) => !p.dead);
    if (this.heliShots.length) this.heliShots = this.heliShots.filter((s) => !s.dead);
  }

  _launchPlane(target, i = 0, count = 1) {
    // Spread the formation evenly around the orbit and stagger their break-off
    // so they strafe in sequence rather than all at once.
    const a0 = Math.random() * Math.PI * 2 + i * (Math.PI * 2 / count);
    const orbitR = 46;
    this.planes.push({
      phase: "circle",
      t: 0,
      age: 0,                // total time alive (drives the appear/scale-in)
      a: a0,                 // current orbit angle
      omega: 2.6,            // orbit angular speed (rad/s)
      orbitR,
      circleTime: 1.0 + i * 0.55, // staggered break-off per formation slot
      speed: 210,            // strafing-run speed
      dir: a0 + Math.PI / 2, // heading (tangent while circling)
      x: this.x + Math.cos(a0) * orbitR,
      y: this.y + Math.sin(a0) * orbitR,
      drops: [],             // remaining bomb-release times into the run
      aim: { x: target.x, y: target.y },
      fading: false,         // set once the run is done: it flies off + fades out
      fadeT: 0,
      dead: false,
    });
  }

  _updatePlane(p, dt, enemies) {
    p.age += dt;
    if (p.phase === "circle") {
      p.t += dt;
      p.a += p.omega * dt;
      p.x = this.x + Math.cos(p.a) * p.orbitR;
      p.y = this.y + Math.sin(p.a) * p.orbitR;
      p.dir = p.a + Math.PI / 2; // fly tangent to the orbit
      if (p.t >= p.circleTime) {
        // Break off toward the freshest target (fall back to the launch aim).
        const tgt = this.acquireTarget(enemies);
        const aim = tgt ? { x: tgt.x, y: tgt.y } : p.aim;
        p.dir = Math.atan2(aim.y - p.y, aim.x - p.x);
        const reach = Math.hypot(aim.x - p.x, aim.y - p.y) / p.speed;
        const n = randInt(Math.random, 2, 3); // a couple of bombs
        const gap = 0.18;
        p.drops = [];
        for (let i = 0; i < n; i++) p.drops.push(Math.max(0.05, reach + (i - (n - 1) / 2) * gap));
        p.drops.sort((a, b) => a - b);
        p.phase = "run";
        p.t = 0;
      }
      return;
    }
    // Run phase: fly straight, releasing each scheduled bomb as its time comes.
    p.t += dt;
    p.x += Math.cos(p.dir) * p.speed * dt;
    p.y += Math.sin(p.dir) * p.speed * dt;
    while (p.drops.length && p.t >= p.drops[0]) {
      p.drops.shift();
      this._dropBomb(p);
    }
    // Once the payload is gone the jet keeps flying and fades out (scaling down)
    // over PLANE_FADE seconds, then is removed — also culled if it leaves the map.
    if (p.drops.length === 0 && !p.fading) p.fading = true;
    if (p.fading) {
      p.fadeT += dt;
      if (p.fadeT >= Tower.PLANE_FADE) p.dead = true;
    }
    if (p.t > 10 || p.x < -80 || p.x > GameMap.pixelW + 80 ||
        p.y < -80 || p.y > GameMap.pixelH + 80) {
      p.dead = true;
    }
  }

  _dropBomb(p) {
    this.bombs.push({
      x: p.x, y: p.y,
      vx: Math.cos(p.dir) * p.speed * 0.5, // inherits the jet's forward momentum
      vy: Math.sin(p.dir) * p.speed * 0.5,
      z: 30,    // height above ground; falls under gravity
      vz: 0,
      spin: Math.random() * Math.PI * 2,
      dead: false,
    });
  }

  _updateBomb(b, dt, enemies, effects) {
    b.vz -= 90 * dt;        // gravity pulls it down to the ground
    b.z += b.vz * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vx *= (1 - Math.min(1, dt * 1.5)); // shed forward drift as it falls
    b.vy *= (1 - Math.min(1, dt * 1.5));
    b.spin += dt * 7;
    if (b.z <= 0) {
      this._bombImpact(b, enemies, effects);
      b.dead = true;
    }
  }

  _bombImpact(b, enemies, effects) {
    const r = this.def.splash;
    const r2 = r * r;
    for (const e of enemies) {
      if (e.dead || dist2(b.x, b.y, e.x, e.y) > r2) continue;
      e.damage(this.def.damage);
      spawnDamage(effects, e.x, e.y, this.def.damage, e.x - b.x, e.y - b.y, true);
      e.addShake(3);
    }
    spawnExplosion(b.x, b.y, "#ffcaa0", 15);
    effects.push({ kind: "blast", x: b.x, y: b.y, r, t: 0.25, color: "#ffd9a0" });
    effects.push(makeFire(b.x, b.y));
  }

  // Spawn the Apache: it glides in along the tower's facing and holds station a
  // short way in front, between the tower and the swarm.
  _launchHeli(target) {
    const ang = Math.atan2(target.y - this.y, target.x - this.x);
    const dist = 78;
    const hx = clamp(this.x + Math.cos(ang) * dist, 24, GameMap.pixelW - 24);
    const hy = clamp(this.y + Math.sin(ang) * dist, 24, GameMap.pixelH - 24);
    this.heli = {
      phase: "enter",
      t: 0, age: 0,
      hx, hy,                                       // hover anchor
      x: this.x + Math.cos(ang) * (dist + 170),     // glide in from beyond it
      y: this.y + Math.sin(ang) * (dist + 170),
      dir: ang,                                      // body faces the swarm
      rotor: Math.random() * Math.PI * 2,            // blade spin angle
      fireCd: 0.3,
      hoverTime: 4.5,
      fading: false, fadeT: 0, dead: false,
      dust: { x: hx, y: hy, r: 72, intensity: 0 },   // downwash field (fed to the shader)
    };
  }

  _updateHeli(dt, enemies, effects) {
    const h = this.heli;
    h.age += dt; h.t += dt;
    h.rotor += dt * 42; // blades whirl

    if (h.phase === "enter") {
      h.x += (h.hx - h.x) * Math.min(1, dt * 3);
      h.y += (h.hy - h.y) * Math.min(1, dt * 3);
      if (Math.hypot(h.hx - h.x, h.hy - h.y) < 4) { h.phase = "hover"; h.t = 0; }
    } else if (h.phase === "hover") {
      // Bob gently on station and rattle off small missiles at the swarm.
      h.x = h.hx + Math.sin(h.age * 2.0) * 2.5;
      h.y = h.hy + Math.sin(h.age * 1.4) * 2.0;
      h.fireCd -= dt;
      if (h.fireCd <= 0) {
        const tgt = this._randTargetInRange(enemies, this.def.range * this.def.range);
        if (tgt) { this._fireHeliMissile(h, tgt); h.fireCd = 0.3; }
        else h.fireCd = 0.15;
      }
      if (h.t >= h.hoverTime) { h.phase = "exit"; h.fading = true; h.fadeT = 0; }
    } else { // exit: climb out and fade away
      h.y -= dt * 28;
      h.fadeT += dt;
      if (h.fadeT >= Tower.PLANE_FADE) h.dead = true;
    }

    // Downwash dust intensity: full while hovering, ramps in/out otherwise.
    const want = h.phase === "hover" ? 1 :
      h.phase === "enter" ? 0.35 : Math.max(0, 1 - h.fadeT / Tower.PLANE_FADE);
    h.dust.x = h.x; h.dust.y = h.y;
    h.dust.intensity += (want - h.dust.intensity) * Math.min(1, dt * 2.5);

    // The kicked-up dust has a chance to slow enemies caught under the rotor.
    if (h.dust.intensity > 0.3) {
      const r2 = h.dust.r * h.dust.r;
      for (const e of enemies) {
        if (e.dead || dist2(h.x, h.y, e.x, e.y) > r2) continue;
        if (Math.random() < dt * 1.8) e.applySlow(0.7, 0.6);
      }
    }

    if (h.dead) this.heli = null;
  }

  _fireHeliMissile(h, tgt) {
    const ang = Math.atan2(tgt.y - h.y, tgt.x - h.x);
    this.heliShots.push({
      x: h.x, y: h.y,
      dir: ang,
      speed: 380,
      target: tgt,
      dmg: 9,
      life: 1.6,
      trail: [],
      dead: false,
    });
    h.muzzle = 1; // brief flash, decays in draw via age
    h.muzzleT = h.age;
  }

  _updateHeliShot(s, dt, enemies, effects) {
    s.life -= dt;
    const tgt = s.target;
    if (tgt && !tgt.dead && !tgt.reachedEnd) {
      let desired = Math.atan2(tgt.y - s.y, tgt.x - s.x);
      let d = desired - s.dir;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const maxTurn = 6 * dt;
      s.dir += Math.max(-maxTurn, Math.min(maxTurn, d));
    }
    s.x += Math.cos(s.dir) * s.speed * dt;
    s.y += Math.sin(s.dir) * s.speed * dt;
    s.trail.push(s.x, s.y);
    if (s.trail.length > 12) s.trail.splice(0, s.trail.length - 12);
    for (const e of enemies) {
      if (e.dead) continue;
      const rad = e.radius + 3;
      if (dist2(s.x, s.y, e.x, e.y) > rad * rad) continue;
      e.damage(s.dmg);
      spawnDamage(effects, e.x, e.y, s.dmg, Math.cos(s.dir), Math.sin(s.dir));
      e.addShake(1);
      effects.push({ kind: "blast", x: s.x, y: s.y, r: 10, t: 0.16, color: "#ffd9a0" });
      s.dead = true;
      return;
    }
    if (s.life <= 0 || s.x < -40 || s.x > GameMap.pixelW + 40 ||
        s.y < -40 || s.y > GameMap.pixelH + 40) {
      s.dead = true;
    }
  }

  update(dt, enemies, projectiles, effects) {
    this.cooldown -= dt;
    this.clock += dt;
    if (this.pulseAnim > 0) this.pulseAnim -= dt;
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt / 0.22);
    if (this.muzzle > 0) this.muzzle = Math.max(0, this.muzzle - dt / 0.1);
    if (this.hitFlash > 0) this.hitFlash -= dt;

    if (this.def.projectile === "pulse") {
      const r2 = this.def.range * this.def.range;
      let inRange = false;
      if (this.cooldown <= 0) {
        // Slow + chip everything in range; only fire if someone is there.
        let hit = false;
        for (const e of enemies) {
          if (e.dead || dist2(this.x, this.y, e.x, e.y) > r2) continue;
          e.applySlow(this.def.slowFactor, this.def.slowDuration);
          e.damage(this.def.damage);
          spawnDamage(effects, e.x, e.y, this.def.damage, e.x - this.x, e.y - this.y);
          hit = true;
        }
        if (hit) {
          this.cooldown = 1 / this.def.fireRate;
          this.pulseAnim = 0.4;
        }
        inRange = hit;
      } else {
        for (const e of enemies) {
          if (!e.dead && dist2(this.x, this.y, e.x, e.y) <= r2) { inRange = true; break; }
        }
      }
      // The field intensifies while it's actively freezing enemies and relaxes
      // to a faint resting cold aura otherwise.
      const target = inRange ? 1 : FrostParams.restLevel;
      const rate = inRange ? FrostParams.rampUp : FrostParams.rampDown;
      this.freeze += (target - this.freeze) * Math.min(1, dt * rate);
      return;
    }

    if (this.def.projectile === "missile") {
      this._updateBarrage(dt, enemies, projectiles, effects);
      return;
    }

    if (this.def.projectile === "snipe") {
      this._updateLaserSnipe(dt, enemies, effects);
      return;
    }

    if (this.def.projectile === "airstrike") {
      this._updateAirstrike(dt, enemies, effects);
      return;
    }

    const target = this.acquireTarget(enemies);
    if (!target) return;
    this.angle = Math.atan2(target.y - this.y, target.x - this.x);
    if (this.cooldown > 0) return;
    this.cooldown = 1 / this.def.fireRate;

    if (this.def.projectile === "beam") {
      target.damage(this.def.damage);
      spawnDamage(effects, target.x, target.y, this.def.damage, target.x - this.x, target.y - this.y);
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
    } else if (this.def.spread) {
      // Scatter gunner (e.g. Twin): fire one bullet per barrel, each thrown off
      // its aim by a random amount so the burst sprays. These fly straight and
      // can genuinely miss (see Projectile scatter) — fast, but less accurate.
      const barrels = this.def.barrels || 1;
      const reach = this.def.range * 1.25;
      const ox = Math.cos(this.angle + Math.PI / 2);
      const oy = Math.sin(this.angle + Math.PI / 2);
      for (let b = 0; b < barrels; b++) {
        const side = barrels === 1 ? 0 : (b - (barrels - 1) / 2) * 6;
        const dir = this.angle + (Math.random() - 0.5) * 2 * this.def.spread;
        const p = new Projectile(this, target, 520, { scatter: true, dir, maxDist: reach });
        p.x = this.x + ox * side;
        p.y = this.y + oy * side;
        projectiles.push(p);
      }
      this.muzzle = 1;
      this._ejectCasing(effects);
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

  // Take a hit from an enemy bolt. Cleanup (cell freeing, debris) happens in the
  // game update once `dead` is set.
  damage(amount) {
    this.hp -= amount;
    this.hitFlash = 0.12;
    if (this.hp <= 0) { this.hp = 0; this.dead = true; }
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
    r.sprite(Tileset.TOWERS[this.spriteKey], this.cx * cs + off + bx, this.cy * cs + off - 2 + by, size, size);

    // Damage feedback: a red flash on impact and a health bar once hurt.
    if (this.hitFlash > 0) {
      r.disc(this.x, this.y, cs * 0.5, "#ff5a5a", Math.min(1, this.hitFlash / 0.12) * 0.45, true);
    }
    if (this.hp < this.maxHp) {
      const w = cs * 0.72;
      const frac = Math.max(0, this.hp / this.maxHp);
      const by2 = this.cy * cs - 2;
      r.rect(this.x - w / 2, by2, w, 4, "rgba(0,0,0,0.6)");
      r.rect(this.x - w / 2, by2, w * frac, 4,
        frac > 0.5 ? "#7ae582" : frac > 0.25 ? "#ffd166" : "#ef476f");
    }

    // Muzzle flash at the barrel tip in the moment after firing.
    if (kick > 0) {
      const ml = size * 0.5;
      r.glow(this.x + Math.cos(this.angle) * ml, this.y + Math.sin(this.angle) * ml,
        12 * this.recoil, "#ffd9a0", this.recoil * 0.8);
    }

    // Twin gunner: a quick muzzle flash off each of the two barrels (offset
    // perpendicular to the aim), so the spread fire reads as dual-barreled.
    if (this.muzzle > 0 && this.def.barrels) {
      const ml = size * 0.5;
      const tx = this.x + Math.cos(this.angle) * ml;
      const ty = this.y + Math.sin(this.angle) * ml;
      const ox = Math.cos(this.angle + Math.PI / 2);
      const oy = Math.sin(this.angle + Math.PI / 2);
      for (let b = 0; b < this.def.barrels; b++) {
        const side = (b - (this.def.barrels - 1) / 2) * 6;
        r.glow(tx + ox * side, ty + oy * side, 7 * this.muzzle, "#cde6ff", this.muzzle * 0.85);
      }
    }

    // Missile launcher: red reticles lock onto each pending shot's target,
    // tightening as that missile's launch moment nears.
    if (this.barrage) {
      for (const s of this.barrage.shots) {
        if (s.fired) continue;
        const e = s.target;
        if (!e || e.dead || e.reachedEnd) continue;
        const p = Math.min(1, this.barrage.t / Math.max(0.001, s.at));
        drawReticle(r, e.x, e.y, e.radius, p);
      }
    }

    // Laser Marksman: a red tracking laser holds on the mark through the charge,
    // brightening as the shot nears. Crit charges glow hotter — and the target
    // visibly panics — telegraphing the freeze.
    if (this.aim) {
      const e = this.aim.target;
      const p = Math.min(1, this.aim.t / this.aim.dur);
      const col = this.aim.crit ? "#ff2d55" : "#ff6b8a";
      if (e && !e.dead && !e.reachedEnd) {
        r.line(this.x, this.y, e.x, e.y, col, 1 + p, 0.3 + 0.5 * p, true);
        r.glow(e.x, e.y, 5 + p * 5, col, 0.5);
        r.ring(e.x, e.y, e.radius + 3, col, 1.2, 0.4 + 0.5 * p, true);
      }

      // Energy charging at the barrel emitter: a hot core, motes spiralling in
      // (faster and tighter as it tops up), and smoke wisps venting upward.
      // All driven by this.clock so the motion is smooth and flicker-free.
      const ml = size * 0.5;
      const ex = this.x + Math.cos(this.angle) * ml;
      const ey = this.y + Math.sin(this.angle) * ml;
      r.glow(ex, ey, 3 + p * 9, col, 0.25 + 0.55 * p);
      const motes = 6;
      for (let k = 0; k < motes; k++) {
        const a = this.clock * (3 + p * 6) + k * (Math.PI * 2 / motes);
        const orbR = (11 - p * 7) + Math.sin(this.clock * 5 + k) * 1.5; // converges
        const mx = ex + Math.cos(a) * orbR;
        const my = ey + Math.sin(a) * orbR * 0.6;                       // tilted orbit
        r.disc(mx, my, 1 + p * 1.1, "#ffd0d8", 0.45 + 0.45 * p, true);
      }
      for (let k = 0; k < 4; k++) {
        const ph = (this.clock * 0.55 + k / 4) % 1;                     // 0→1 rise cycle
        const sx = ex + Math.sin((this.clock + k * 1.7) * 2) * 3;
        const sy = ey - 3 - ph * 17;
        r.disc(sx, sy, 1.4 + ph * 3, "#3a3a3a", (1 - ph) * 0.22);
      }
    }

    // Frost tower: a cold halo with slow drifting mist that thickens with the
    // field strength, plus the expanding pulse ring on each tick.
    if (this.def.projectile === "pulse") {
      const f = this.freeze;
      if (f > 0.02) {
        r.glow(this.x, this.y, 24, "#cdefff", 0.22 * f);
        for (let k = 0; k < 3; k++) {
          const a = this.clock * 0.6 + k * 2.094;
          r.disc(this.x + Math.cos(a) * 13, this.y + Math.sin(a) * 9 - 3,
            5.5, "#e6f7ff", 0.1 * f, true);
        }
      }
      if (this.pulseAnim > 0) {
        const t = 1 - this.pulseAnim / 0.4;
        r.ring(this.x, this.y, this.def.range * t, "#90e0ef", 3, 0.5 * (1 - t));
      }
    }
  }

  // Airbase jets and their bombs fly above the battlefield, so they're drawn in
  // a separate overhead pass (called after enemies/projectiles/effects) rather
  // than in draw(). Each is lifted by a fixed altitude with a shadow cast on the
  // ground directly beneath it for a sense of height.
  drawAir(r) {
    if (!this.planes.length && !this.bombs.length && !this.heli && !this.heliShots.length) return;
    const cs = GameMap.CELL;

    this._drawHeli(r, cs);

    // Falling bombs: a small ground shadow + the bomb tumbling at its height.
    for (const b of this.bombs) {
      const grounded = Math.min(0.6, b.z / 60);
      r.disc(b.x, b.y, 2 + b.z * 0.05, "#000000", 0.28 * (1 - grounded));
      const bx = b.x, by = b.y - b.z;
      const ux = Math.cos(b.spin) * 2.6, uy = Math.sin(b.spin) * 2.6;
      r.line(bx - ux, by - uy, bx + ux, by + uy, "#3a3f44", 3.2);
      r.disc(bx + ux * 0.6, by + uy * 0.6, 1.3, "#9aa1a8");
    }

    // Jets: scale up + fade in on arrival, scale down + fade out as they leave
    // after the run. A soft shadow on the ground, the rotated sprite overhead,
    // and an engine glow off the tail — all dimmed by the jet's current alpha.
    const ALT = 22;
    const base = (cs + 8) * 0.7; // jet footprint, 30% smaller
    for (const p of this.planes) {
      const appear = clamp(p.age / Tower.PLANE_APPEAR, 0, 1);
      const leave = p.fading ? clamp(1 - p.fadeT / Tower.PLANE_FADE, 0, 1) : 1;
      const alpha = appear * leave;
      const scale = (0.7 + 0.3 * appear) * (0.7 + 0.3 * leave);
      const size = base * scale;
      r.disc(p.x, p.y, size * 0.3, "#000000", 0.16 * alpha);
      const ax = p.x, ay = p.y - ALT;
      r.spriteRot(Tileset.PLANE, ax, ay, size, size, p.dir, false, alpha); // art points west
      const tx = ax - Math.cos(p.dir) * size * 0.42;
      const ty = ay - Math.sin(p.dir) * size * 0.42;
      r.glow(tx, ty, 6 * scale, "#ffd9a0", 0.5 * alpha);
    }
  }

  // The Apache gunship: swirling ground dust (primitive billows that read in
  // both renderers, on top of the WebGL downwash shader), its small missiles,
  // then the hovering body with a spinning rotor-blade blur.
  _drawHeli(r, cs) {
    for (const s of this.heliShots) {
      const t = s.trail, n = t.length / 2;
      for (let i = 1; i < n; i++) {
        const a = i / n;
        r.line(t[(i - 1) * 2], t[(i - 1) * 2 + 1], t[i * 2], t[i * 2 + 1],
          "#ffcf9a", 1 + 1.5 * a, 0.5 * a, true);
      }
      r.glow(s.x, s.y, 4, "#ffd9a0", 0.6);
      r.disc(s.x, s.y, 1.7, "#fff1c0", 1, true);
    }

    const h = this.heli;
    if (!h) return;

    const appear = clamp(h.age / Tower.PLANE_APPEAR, 0, 1);
    const leave = h.fading ? clamp(1 - h.fadeT / Tower.PLANE_FADE, 0, 1) : 1;
    const alpha = appear * leave;

    // Billowing dust ring on the ground, cycling outward from under the rotor.
    const di = h.dust.intensity;
    if (di > 0.02) {
      for (let k = 0; k < 12; k++) {
        const phase = (h.age * 0.8 + k / 12) % 1;
        const a = h.rotor * 0.12 + k * (Math.PI * 2 / 12);
        const rad = h.dust.r * (0.15 + 0.85 * phase);
        const px = h.x + Math.cos(a) * rad;
        const py = h.y + Math.sin(a) * rad * 0.7; // squashed: seen at an angle
        r.disc(px, py, 3 + phase * 7, "#cdb488", (1 - phase) * 0.16 * di);
      }
    }

    const ALT = 26;
    const size = (cs + 10) * 0.7;
    r.disc(h.x, h.y, size * 0.34, "#000000", 0.18 * alpha);
    const ax = h.x, ay = h.y - ALT;
    // Top-down sprite kept upright (rotating it to the heading flipped it
    // upside down); just mirror it to face whichever way the swarm is.
    const faceLeft = Math.cos(h.dir) < 0;
    r.spriteRot(Tileset.HELI, ax, ay, size, size, 0, faceLeft, alpha);

    // Muzzle flash on the nose just after firing.
    const mz = h.muzzle ? Math.max(0, 1 - (h.age - h.muzzleT) / 0.1) : 0;
    if (mz > 0) {
      const nx = ax + Math.cos(h.dir) * size * 0.45;
      const ny = ay + Math.sin(h.dir) * size * 0.45;
      r.glow(nx, ny, 7 * mz, "#fff0c0", mz * 0.8 * alpha);
    }

    // Spinning main-rotor disc: a faint blur plus two blade streaks.
    r.disc(ax, ay, size * 0.6, "#cfd8e0", 0.08 * alpha, true);
    for (let b = 0; b < 2; b++) {
      const ba = h.rotor + b * (Math.PI / 2);
      const bl = size * 0.62;
      r.line(ax - Math.cos(ba) * bl, ay - Math.sin(ba) * bl,
        ax + Math.cos(ba) * bl, ay + Math.sin(ba) * bl, "#e8eef4", 1.4, 0.22 * alpha, true);
    }
  }
}

// Jet appear/disappear timing (seconds): scale+fade in on arrival, and the
// scale+fade out flown after the strafing run.
Tower.PLANE_APPEAR = 0.4;
Tower.PLANE_FADE = 1.2;

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

    // Scatter bullet (twin gunner): a straight-flying, non-homing round aimed
    // along a fixed heading with built-in inaccuracy. It sweeps for a hit and
    // expires after maxDist if it touched nothing — so it can miss.
    this.scatter = !!opts.scatter;
    if (this.scatter) {
      this.homing = false;
      this.dirX = Math.cos(opts.dir);
      this.dirY = Math.sin(opts.dir);
      this.dist = 0;
      this.maxDist = opts.maxDist || 240;
    }

    // Barrage missile: launches slow and accelerates hard, steering toward its
    // target with a limited turn rate (so it curves), plus a decaying lateral
    // wobble so the path snakes in. Limited agility + the wobble means some
    // overshoot and miss. Fired off-axis so the salvo fans up before homing.
    if (this.kind === "missile") {
      this.homing = true;
      this.accel = 1000;
      this.maxSpeed = 440;
      this.turnRate = 4.4;          // rad/s steering limit
      const toT = Math.atan2(this.target.y - this.y, this.target.x - this.x);
      this.heading = toT + (Math.random() - 0.5) * 2.6;
      this.wobAmp = 0.5 + Math.random() * 0.9;
      this.wobFreq = 6 + Math.random() * 5;
      this.wobPhase = Math.random() * Math.PI * 2;
      this.age = 0;
      this.life = 2.6;
    }
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
        const dmg = this.crit ? this.damage * 1.5 : this.damage;
        e.damage(dmg);
        spawnDamage(effects, e.x, e.y, dmg, this.dirX, this.dirY, this.crit);
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

    // Scatter bullet: fly straight, hit-testing the swept segment so a near-miss
    // really misses. Strikes the first enemy it touches, then expires; otherwise
    // it fades out once it has flown its full reach.
    if (this.scatter) {
      const px = this.x, py = this.y;
      this.x += this.dirX * this.speed * dt;
      this.y += this.dirY * this.speed * dt;
      this.dist += this.speed * dt;
      this._recordTrail();
      for (const e of enemies) {
        if (e.dead) continue;
        const rad = e.radius + 2;
        if (segDist2(px, py, this.x, this.y, e.x, e.y) > rad * rad) continue;
        e.damage(this.damage);
        spawnDamage(effects, e.x, e.y, this.damage, this.dirX, this.dirY);
        e.addShake(1);
        this.done = true;
        return;
      }
      if (this.dist > this.maxDist ||
          this.x < -40 || this.x > GameMap.pixelW + 40 ||
          this.y < -40 || this.y > GameMap.pixelH + 40) {
        this.done = true;
      }
      return;
    }

    // Barrage missile: ramp speed, steer (rate-limited) toward the live target
    // with a decaying wobble, and detonate on contact. If the target dies it
    // coasts on its heading and fizzles out — a clean miss.
    if (this.kind === "missile") {
      this.age += dt;
      this.speed = Math.min(this.maxSpeed, this.speed + this.accel * dt);
      const alive = this.target && !this.target.dead && !this.target.reachedEnd;
      if (alive) {
        let desired = Math.atan2(this.target.y - this.y, this.target.x - this.x);
        const decay = Math.max(0, 1 - this.age / 1.2);
        desired += Math.sin(this.age * this.wobFreq + this.wobPhase) * this.wobAmp * decay;
        let d = desired - this.heading;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const maxTurn = this.turnRate * dt;
        this.heading += Math.max(-maxTurn, Math.min(maxTurn, d));
      }
      this.x += Math.cos(this.heading) * this.speed * dt;
      this.y += Math.sin(this.heading) * this.speed * dt;
      this._recordTrail();
      if (alive) {
        const rad = this.target.radius + 5;
        if (dist2(this.x, this.y, this.target.x, this.target.y) <= rad * rad) {
          this.explode(this.x, this.y, enemies, effects);
          return;
        }
      }
      if (this.age >= this.life ||
          this.x < -40 || this.x > GameMap.pixelW + 40 ||
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
    if (this.kind !== "bullet" && this.kind !== "shell" && this.kind !== "rail" &&
        this.kind !== "missile") return;
    this.trail.push(this.x, this.y);
    const cap = this.kind === "rail" ? 20 : this.kind === "shell" ? 24 :
      this.kind === "missile" ? 22 : 16;
    if (this.trail.length > cap) this.trail.splice(0, this.trail.length - cap);
  }

  explode(x, y, enemies, effects) {
    // Ricochet: a small chance the shell skips off the target, deals a glancing
    // hit, and flies off at an angle to fade out instead of detonating.
    if (this.kind === "shell" && Math.random() < 0.08) {
      if (!this.target.dead) {
        this.target.damage(this.damage * 0.5);
        spawnDamage(effects, this.target.x, this.target.y, this.damage * 0.5, this.dirX, this.dirY);
        this.target.addShake(2);
      }
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
        spawnDamage(effects, e.x, e.y, dmg, e.x - x, e.y - y, this.explosive);
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
      spawnDamage(effects, this.target.x, this.target.y, this.damage, this.dirX, this.dirY);
    }
  }

  draw(r) {
    this._emitLight(r);
    if (this.kind === "bullet") { this._drawTracer(r); return; }
    if (this.kind === "shell") { this._drawShell(r); return; }
    if (this.kind === "rail") { this._drawRail(r); return; }
    if (this.kind === "missile") { this._drawMissile(r); return; }
    r.disc(this.x, this.y, this.splash > 0 ? 5 : 3, this.color);
  }

  // A pool of light the round casts on the world around it. Sized and brightened
  // by how dark the scene is (DayNight.darkness), so by day it's nothing and at
  // night each tracer/shell lights its surroundings as it streaks past.
  _emitLight(r) {
    const d = DayNight.darkness();
    if (d < 0.02) return;
    const R = (this.kind === "rail" ? 40 : this.kind === "shell" ? 34 :
      this.kind === "missile" ? 30 : 26) * (0.55 + 0.45 * d);
    r.glow(this.x, this.y, R, this.color, (0.10 + 0.45 * d));
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

  // Barrage missile: a smoky exhaust trail under a hot rocket flame, capped by a
  // short body pointed along its heading with a glowing motor.
  _drawMissile(r) {
    const t = this.trail;
    const n = t.length / 2;
    // Gray smoke trail.
    for (let i = 1; i < n; i++) {
      const a = i / n;
      r.line(t[(i - 1) * 2], t[(i - 1) * 2 + 1], t[i * 2], t[i * 2 + 1],
        "#b9c0c8", 1 + 3 * a, 0.12 * a);
    }
    // Hot exhaust core (additive), brightest near the motor.
    for (let i = 1; i < n; i++) {
      const a = i / n;
      r.line(t[(i - 1) * 2], t[(i - 1) * 2 + 1], t[i * 2], t[i * 2 + 1],
        "#ff7b29", 0.5 + 2.5 * a, 0.5 * a * a, true);
    }
    const hx = Math.cos(this.heading), hy = Math.sin(this.heading);
    // Body, then a glowing motor flare at the tail.
    r.line(this.x - hx * 4, this.y - hy * 4, this.x + hx * 2.5, this.y + hy * 2.5, this.color, 3, 1);
    r.glow(this.x - hx * 4, this.y - hy * 4, 6, "#ffd9a0", 0.7);
    r.disc(this.x + hx * 2.5, this.y + hy * 2.5, 1.5, "#fff1c0", 1, true);
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
