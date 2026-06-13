"use strict";

const Game = {
  canvas: null,
  ctx: null,
  width: 0,   // logical size (CSS pixels); canvas backing store is dpr-scaled
  height: 0,
  dpr: 1,
  enemies: [],
  towers: [],
  projectiles: [],
  effects: [],
  gold: 220,
  lives: 20,
  wave: 0,
  waveActive: false,
  spawnQueue: [],   // { type, delay } entries, consumed in order
  spawnTimer: 0,
  autoStartTimer: 0,
  selectedType: null,
  hoverCell: null,
  over: false,
  rng: Math.random,
  lastTime: 0,
};

// ---------------------------------------------------------------- waves

function buildWave(n) {
  const queue = [];
  const push = (type, count, gap) => {
    for (let i = 0; i < count; i++) queue.push({ type, delay: gap });
  };
  push("grunt", 6 + n * 2, 0.7);
  if (n >= 2) push("runner", 3 + n, 0.45);
  if (n >= 3 && n % 2 === 1) push("swarmling", 8 + n * 3, 0.12);
  if (n >= 4) push("tank", Math.floor(n / 2), 1.6);
  if (n >= 6) push("runner", n, 0.3);
  return queue;
}

function waveHpScale(n) {
  return 1 + (n - 1) * 0.22;
}

function startWave() {
  if (Game.waveActive || Game.over) return;
  Game.wave++;
  Game.spawnQueue = buildWave(Game.wave);
  Game.spawnTimer = 0;
  Game.waveActive = true;
  updateHud();
}

// ---------------------------------------------------------------- setup

// Size the canvas to fill its container, scaled for sharp rendering on
// high-DPI displays. All game logic uses the logical (CSS pixel) size.
function fitCanvas() {
  const wrap = document.getElementById("canvas-wrap");
  Game.dpr = window.devicePixelRatio || 1;
  Game.width = wrap.clientWidth;
  Game.height = wrap.clientHeight;
  const bw = Math.round(Game.width * Game.dpr);
  const bh = Math.round(Game.height * Game.dpr);
  // All three stacked layers (2D world, WebGL world, HUD overlay) share size.
  for (const c of [Game.canvas, Game.glCanvas, Game.overlayCanvas]) {
    c.width = bw;
    c.height = bh;
  }
}

function newMap() {
  fitCanvas();
  GameMap.generate(Game.width, Game.height, (Math.random() * 2 ** 31) | 0);
  Game.enemies = [];
  Game.towers = [];
  Game.projectiles = [];
  Game.effects = [];
  Game.gold = 220;
  Game.lives = 20;
  Game.wave = 0;
  Game.waveActive = false;
  Game.spawnQueue = [];
  Game.autoStartTimer = 0;
  Game.over = false;
  updateHud();
}

function buildShop() {
  const shop = document.getElementById("shop");
  shop.innerHTML = "";
  const keys = Object.keys(TOWER_TYPES);
  keys.forEach((type, i) => {
    const def = TOWER_TYPES[type];
    // Each base lives in a slot; advanced variants hang in a popover that the
    // slot reveals on hover (pure CSS — see #shop styles in index.html).
    const slot = document.createElement("div");
    slot.className = "tower-slot";

    const btn = document.createElement("button");
    btn.className = "tower-btn";
    btn.dataset.type = type;
    btn.title = def.desc;
    const adv = def.variants ? '<span class="adv">▴ more</span>' : "";
    btn.innerHTML = `<b style="color:${def.color}">${def.name}</b><small>${def.cost}g</small><span class="key">[${i + 1}]</span>${adv}`;
    btn.addEventListener("click", () => selectTower(type));
    slot.appendChild(btn);

    if (def.variants) {
      const pop = document.createElement("div");
      pop.className = "tower-pop";
      // The base itself is listed first ("Standard") so the popover is the full
      // menu of versions for that category.
      const entries = [[type, def, "Standard"]];
      for (const [vid, vdef] of Object.entries(def.variants)) entries.push([vid, vdef, vdef.name]);
      for (const [id, vdef, label] of entries) {
        const v = document.createElement("button");
        v.className = "variant-btn";
        v.dataset.type = id;
        v.title = vdef.desc;
        v.innerHTML =
          `<b style="color:${vdef.color}">${label}</b><small>${vdef.cost}g</small><i>${vdef.desc}</i>`;
        v.addEventListener("click", (e) => { e.stopPropagation(); selectTower(id); });
        pop.appendChild(v);
      }
      slot.appendChild(pop);
    }
    shop.appendChild(slot);
  });
}

function selectTower(type) {
  Game.selectedType = Game.selectedType === type ? null : type;
  updateHud();
}

function updateHud() {
  document.getElementById("gold-val").textContent = Game.gold;
  document.getElementById("lives-val").textContent = Game.lives;
  document.getElementById("wave-val").textContent = Game.wave;
  document.getElementById("start-wave").disabled = Game.waveActive || Game.over;
  document.querySelectorAll(".tower-btn").forEach((btn) => {
    const def = TOWER_DEFS[btn.dataset.type];
    // A base button reads as selected when it — or any of its variants — is the
    // active choice, so picking "Twin Gunner" still lights up the Gunner slot.
    const sel = btn.dataset.type === Game.selectedType ||
      (def.variants && Game.selectedType in def.variants);
    btn.classList.toggle("selected", !!sel);
    btn.classList.toggle("unaffordable", def.cost > Game.gold);
  });
  document.querySelectorAll(".variant-btn").forEach((btn) => {
    const def = TOWER_DEFS[btn.dataset.type];
    btn.classList.toggle("selected", btn.dataset.type === Game.selectedType);
    btn.classList.toggle("unaffordable", def.cost > Game.gold);
  });
}

// ---------------------------------------------------------------- input

function canvasCell(ev) {
  const rect = Game.overlayCanvas.getBoundingClientRect();
  const scaleX = Game.width / rect.width;
  const scaleY = Game.height / rect.height;
  const x = (ev.clientX - rect.left) * scaleX;
  const y = (ev.clientY - rect.top) * scaleY;
  return { cx: Math.floor(x / GameMap.CELL), cy: Math.floor(y / GameMap.CELL) };
}

function bindInput() {
  // The overlay (HUD) layer is always topmost and visible, so it receives the
  // pointer events for both renderers.
  const canvas = Game.overlayCanvas;

  canvas.addEventListener("mousemove", (ev) => {
    Game.hoverCell = canvasCell(ev);
  });
  canvas.addEventListener("mouseleave", () => {
    Game.hoverCell = null;
  });

  canvas.addEventListener("click", (ev) => {
    if (Game.over) return;
    const { cx, cy } = canvasCell(ev);
    if (!Game.selectedType) return;
    const def = TOWER_DEFS[Game.selectedType];
    if (def.cost > Game.gold || !GameMap.canBuild(cx, cy)) return;
    const tower = new Tower(Game.selectedType, cx, cy);
    Game.towers.push(tower);
    GameMap.towersAt[cx][cy] = tower;
    Game.gold -= def.cost;
    updateHud();
  });

  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const { cx, cy } = canvasCell(ev);
    const tower = GameMap.towersAt?.[cx]?.[cy];
    if (!tower) return;
    Game.gold += tower.sellValue();
    GameMap.towersAt[cx][cy] = null;
    Game.towers.splice(Game.towers.indexOf(tower), 1);
    updateHud();
  });

  window.addEventListener("keydown", (ev) => {
    const keys = Object.keys(TOWER_TYPES);
    const idx = parseInt(ev.key, 10) - 1;
    if (idx >= 0 && idx < keys.length) selectTower(keys[idx]);
    if (ev.key === "Escape") { Game.selectedType = null; updateHud(); }
    if (ev.key === "9") { Game.gold += 3000; updateHud(); } // debug: top up gold
    if (ev.key === " " && !Game.waveActive) { ev.preventDefault(); startWave(); }
    if (ev.key === "v" || ev.key === "V") toggleView();
    // "t" steps to the next time of day; Shift+T toggles a continuous cycle.
    if (ev.key === "t") DayNight.next();
    if (ev.key === "T") DayNight.auto = !DayNight.auto;
  });

  document.getElementById("start-wave").addEventListener("click", startWave);
  document.getElementById("new-map").addEventListener("click", newMap);
  document.getElementById("swap-tiles").addEventListener("click", () => Tileset.swap());
  document.getElementById("day-btn").addEventListener("click", () => DayNight.next());

  // Hamburger menu: toggle on click, close on outside click.
  const menu = document.getElementById("menu");
  document.getElementById("menu-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = menu.classList.toggle("open");
    document.getElementById("menu-btn").setAttribute("aria-expanded", open);
  });
  document.addEventListener("click", (ev) => {
    if (!menu.contains(ev.target)) {
      menu.classList.remove("open");
      document.getElementById("menu-btn").setAttribute("aria-expanded", false);
    }
  });
}

// ---------------------------------------------------------------- update

function update(dt) {
  // The day/night grade keeps animating even on the game-over screen.
  DayNight.update(dt);

  if (Game.over) return;

  // Spawning.
  if (Game.spawnQueue.length > 0) {
    Game.spawnTimer -= dt;
    while (Game.spawnTimer <= 0 && Game.spawnQueue.length > 0) {
      const next = Game.spawnQueue.shift();
      const lane = next.path != null ? next.path : (Math.random() * GameMap.paths.length) | 0;
      Game.enemies.push(new Enemy(next.type, waveHpScale(Game.wave), Math.random, lane));
      Game.spawnTimer += next.delay;
    }
  }

  // Enemies.
  for (const e of Game.enemies) e.update(dt);
  resolveEnemyCollisions(Game.enemies);

  // Towers and projectiles.
  for (const t of Game.towers) t.update(dt, Game.enemies, Game.projectiles, Game.effects);
  for (const p of Game.projectiles) p.update(dt, Game.enemies, Game.effects);
  Game.projectiles = Game.projectiles.filter((p) => !p.done);

  // Effects decay.
  for (const fx of Game.effects) fx.t -= dt;
  Game.effects = Game.effects.filter((fx) => fx.t > 0);

  // Deaths and leaks.
  let goldEarned = 0;
  for (const e of Game.enemies) {
    if (e.dead) {
      goldEarned += e.def.gold;
      spawnExplosion(e.x, e.y, e.def.color, e.radius);
    }
    if (e.reachedEnd) Game.lives--;
  }
  if (goldEarned > 0) Game.gold += goldEarned;
  const before = Game.enemies.length;
  Game.enemies = Game.enemies.filter((e) => !e.dead && !e.reachedEnd);

  if (Game.lives <= 0) {
    Game.lives = 0;
    Game.over = true;
  }

  // Wave end: bonus gold, schedule the next wave.
  if (Game.waveActive && Game.spawnQueue.length === 0 && Game.enemies.length === 0) {
    Game.waveActive = false;
    Game.gold += 30 + Game.wave * 10;
    Game.autoStartTimer = 10;
  }
  if (!Game.waveActive && Game.autoStartTimer > 0 && !Game.over) {
    Game.autoStartTimer -= dt;
    if (Game.autoStartTimer <= 0) startWave();
  }

  if (goldEarned > 0 || before !== Game.enemies.length || Game.over) updateHud();
}

// ---------------------------------------------------------------- render

// Snow/ice sheet accreting on the ground under each active frost tower, with
// ice crystals that accumulate as the field strengthens. Drawn before units so
// it sits on the ground.
function drawFrostGround(r) {
  for (const t of Game.towers) {
    if (t.def.projectile !== "pulse" || t.freeze <= 0.02) continue;
    const f = t.freeze, range = t.def.range;
    r.disc(t.x, t.y, range, "#eaf6ff", 0.1 * f);
    r.disc(t.x, t.y, range * 0.6, "#dff0ff", 0.1 * f);
    r.ring(t.x, t.y, range, "#bfe8ff", 2, 0.4 * f, true);
    if (!t.frostCrystals) t.frostCrystals = genFrostCrystals(t.x, t.y, range);
    const n = Math.floor(t.frostCrystals.length * Math.min(1, f));
    for (let i = 0; i < n; i++) {
      const c = t.frostCrystals[i];
      r.disc(c.x, c.y, c.r, "#ffffff", 0.5, true);
    }
  }
}

// Stable scatter of crystal positions inside the field (generated once per
// tower so they don't flicker; revealed in index order as the field builds).
function genFrostCrystals(cx, cy, range) {
  const out = [];
  for (let i = 0; i < 44; i++) {
    const a = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * range * 0.95;
    out.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, r: 0.8 + Math.random() * 1.6 });
  }
  return out;
}

function drawPlacementPreview(r) {
  if (!Game.selectedType || !Game.hoverCell) return;
  const { cx, cy } = Game.hoverCell;
  if (cx < 0 || cy < 0 || cx >= GameMap.cols || cy >= GameMap.rows) return;
  const def = TOWER_DEFS[Game.selectedType];
  const cs = GameMap.CELL;
  const px = cx * cs + cs / 2;
  const py = cy * cs + cs / 2;
  const ok = GameMap.canBuild(cx, cy) && def.cost <= Game.gold;
  const color = ok ? "#4fc3f7" : "#ef476f";

  r.disc(px, py, def.range, color, 0.08);
  r.ring(px, py, def.range, color, 1.5, 0.4);
  r.rect(cx * cs, cy * cs, cs, cs, color, 0.35);
}

// Burst of glowing embers + shockwave + flash, tinted to the dying enemy.
// Bigger enemies make a bigger, longer-lived blast.
function spawnExplosion(x, y, color, radius) {
  const scale = radius / 9; // grunt radius is the baseline
  const count = Math.round(10 + radius * 1.2);
  const particles = [];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (35 + Math.random() * 90) * scale;
    particles.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 18 * scale, // slight upward bias
      r: (1.4 + Math.random() * 2.4) * scale,
      life: 0.35 + Math.random() * 0.3,
    });
  }
  Game.effects.push({
    kind: "explosion",
    x, y,
    t: 0.5,
    dur: 0.5,
    color,
    flashR: radius * 2.6,
    waveR: radius * 4.5,
    particles,
  });
}

// Floating combat number for a single hit. Spawned at the impact point and
// nudged along the shot's heading (dx,dy, normalized here) so the number drifts
// the way the round was travelling while it rises and fades. Crits read larger
// and gold. Rendered in the Canvas-2D overlay (drawDamageNumbers), not the world
// renderer, since text lives on the HUD layer.
function spawnDamage(effects, x, y, amount, dx, dy, crit) {
  const l = Math.hypot(dx, dy) || 1;
  const dur = crit ? 0.9 : 0.7;
  effects.push({
    kind: "dmg",
    x: x + (Math.random() - 0.5) * 6, y: y - 8,
    dx: dx / l, dy: dy / l,
    amount: Math.max(1, Math.round(amount)),
    crit: !!crit,
    t: dur, dur,
  });
}

// Damage numbers ride the top Canvas-2D layer (world coords == CSS px here, so
// no remap needed). Position is a pure function of the effect's age: drift along
// the shot heading + a gentle upward float, pop in, then fade out.
function drawDamageNumbers(ctx) {
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  for (const fx of Game.effects) {
    if (fx.kind !== "dmg") continue;
    const p = (fx.dur - fx.t) / fx.dur;           // 0 → 1 over its life
    const drift = fx.crit ? 26 : 18;
    const px = fx.x + fx.dx * drift * p;
    const py = fx.y + fx.dy * drift * p - 16 * p; // float up as it travels
    const alpha = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `bold ${fx.crit ? 14 : 10}px system-ui, sans-serif`;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillStyle = fx.crit ? "#ffd76b" : "#ffffff";
    ctx.strokeText(fx.amount, px, py);
    ctx.fillText(fx.amount, px, py);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

function drawEffects(r) {
  for (const fx of Game.effects) {
    if (fx.kind === "explosion") {
      const p = 1 - fx.t / fx.dur; // 0 → 1 over the effect's life

      // Core flash — bright, brief (additive radial bloom).
      const flash = Math.max(0, 1 - p * 4);
      if (flash > 0) {
        const fr = fx.flashR * (0.5 + p * 1.5);
        r.glow(fx.x, fx.y, fr, fx.color, flash);
      }

      // Expanding shockwave ring.
      r.ring(fx.x, fx.y, fx.waveR * p, fx.color, Math.max(1, 3 * (1 - p)),
        Math.max(0, 1 - p) * 0.6, true);

      // Embers — integrate motion, fade, and cool toward red.
      for (const e of fx.particles) {
        const el = p * fx.dur / e.life; // 0 → 1+ over particle's own life
        if (el >= 1) continue;
        e.x += e.vx * 0.016;
        e.y += e.vy * 0.016;
        e.vx *= 0.92;
        e.vy = e.vy * 0.92 + 60 * 0.016; // gravity
        r.disc(e.x, e.y, e.r * (1 - el * 0.6), fx.color, (1 - el) * 0.9, true);
      }
    } else if (fx.kind === "casing") {
      // Spent brass arcing out of the gunner and bouncing. Simulated here with
      // a fixed step (like the explosion embers): z is height above ground.
      const dts = 0.016;
      fx.vz -= 420 * dts;          // gravity
      fx.z += fx.vz * dts;
      if (fx.z <= 0) {
        fx.z = 0;
        if (fx.vz < 0) fx.vz = -fx.vz * 0.42; // bounce, shed energy
        fx.vx *= 0.6; fx.vy *= 0.6;           // ground friction
        fx.vrot *= 0.6;
      }
      fx.x += fx.vx * dts;
      fx.y += fx.vy * dts;
      fx.rot += fx.vrot * dts;
      const fade = Math.min(1, fx.t / 0.2);    // fade out in the last 0.2s
      const len = fx.len || 3.2;
      // Ground shadow: larger and fainter the higher it is.
      r.disc(fx.x, fx.y, 2.2 + fx.z * 0.04, "#000000",
        0.3 * fade * (1 - Math.min(0.6, fx.z / 60)));
      // The casing: a short brass capsule lifted to its height, plus a glint.
      const cx = fx.x, cy = fx.y - fx.z;
      const ux = Math.cos(fx.rot) * len, uy = Math.sin(fx.rot) * len;
      r.line(cx - ux, cy - uy, cx + ux, cy + uy, fx.color || "#d9b44a", 2.5 + len * 0.2, fade);
      r.disc(cx + ux * 0.5, cy + uy * 0.5, 1.3, "#fff3c0", fade * 0.9, true);
    } else if (fx.kind === "fire") {
      // A patch of ground burning: additive flame tongues rising + fading,
      // with gray smoke puffs drifting up after them. Driven by the effect age,
      // so it's frame-rate independent.
      const age = fx.dur - fx.t;
      for (const p of fx.flames) {
        const lt = (age - p.delay) / p.life;
        if (lt < 0 || lt >= 1) continue;
        const flick = 0.7 + 0.3 * Math.sin((age + p.delay) * 40 + p.dx);
        const px = fx.x + p.dx * (1 - lt * 0.3);
        const py = fx.y - p.rise * lt;
        const a = (1 - lt) * flick;
        const sz = p.r * (1 - lt * 0.4);
        r.glow(px, py, sz * 1.8, "#ff7b29", a * 0.6);
        r.disc(px, py, sz * 0.6, "#ffd86b", a, true);
      }
      for (const p of fx.smoke) {
        const lt = (age - p.delay) / p.life;
        if (lt < 0 || lt >= 1) continue;
        const px = fx.x + p.dx + lt * 3;
        const py = fx.y - p.rise * lt - 4;
        const sz = p.r * (1 + lt * 1.6);
        r.disc(px, py, sz, "#2c2c2c", Math.sin(lt * Math.PI) * 0.28);
      }
    } else if (fx.kind === "warp") {
      // Explosive round: concentric shock rings rippling outward + a core flash.
      const p = 1 - fx.t / fx.dur;
      for (let k = 0; k < 3; k++) {
        const rp = p - k * 0.12;
        if (rp < 0 || rp > 1) continue;
        r.ring(fx.x, fx.y, fx.r * rp, fx.color, 3 * (1 - rp) + 1, (1 - rp) * 0.6, true);
      }
      r.glow(fx.x, fx.y, fx.r * (0.3 + p * 0.35), fx.color, Math.max(0, 1 - p * 3) * 0.85);
    } else if (fx.kind === "evaporate") {
      // The body boiling off: a quick hot flash, then vapor wisps rising and
      // fading — warm at the base, cooling to gray steam as they climb. The
      // scene-warping shimmer itself comes from the heat-haze post-process.
      const age = fx.dur - fx.t;
      const p = age / fx.dur;
      const flash = Math.max(0, 1 - p * 3);
      if (flash > 0) r.glow(fx.x, fx.y, fx.radius * 2.4, "#ffe0a8", flash * 0.85);
      for (const w of fx.wisps) {
        const lt = (age - w.delay) / w.life;
        if (lt < 0 || lt >= 1) continue;
        const px = fx.x + w.dx * (0.3 + lt * 0.7);
        const py = fx.y - w.rise * lt;
        const a = Math.sin(lt * Math.PI);
        const sz = w.r * (0.5 + lt * 1.2);
        if (lt < 0.4) r.glow(px, py, sz * 1.6, "#ff9b4a", a * 0.35);
        r.disc(px, py, sz, lt < 0.4 ? "#ffcaa0" : "#c8ced6", a * 0.28);
      }
    } else if (fx.kind === "beam") {
      r.line(fx.x1, fx.y1, fx.x2, fx.y2, fx.color, 2.5, Math.max(0, fx.t / 0.12));
    } else if (fx.kind === "blast") {
      const t = 1 - fx.t / 0.25;
      r.ring(fx.x, fx.y, fx.r * (0.4 + 0.6 * t), fx.color, 3, (1 - t) * 0.8);
    }
  }
}

function drawOverlays(ctx) {
  const W = Game.width, H = Game.height;

  // Time-of-day readout lives in the HUD (#day-btn). "t" cycles, Shift+T auto.
  document.getElementById("day-btn").textContent =
    `${DayNight.phaseName()}${DayNight.auto ? " ⟳" : ""}`;

  if (Game.over) {
    ctx.fillStyle = "rgba(10, 12, 16, 0.75)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#ef476f";
    ctx.font = "bold 52px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("GAME OVER", W / 2, H / 2 - 20);
    ctx.fillStyle = "#d8dee9";
    ctx.font = "20px system-ui, sans-serif";
    ctx.fillText(`You survived ${Game.wave} wave${Game.wave === 1 ? "" : "s"} — click New Map to retry`, W / 2, H / 2 + 24);
    ctx.textAlign = "left";
  } else if (!Game.waveActive && Game.autoStartTimer > 0) {
    ctx.fillStyle = "rgba(216, 222, 233, 0.85)";
    ctx.font = "16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Next wave in ${Math.ceil(Game.autoStartTimer)}s — press Space to start now`, W / 2, 28);
    ctx.textAlign = "left";
  }
}

function render() {
  // World is painted by the active renderer (Canvas-2D or WebGL).
  const r = Game.renderer;

  // Frost fields drive the WebGL displacement post-process (no-op in 2D).
  const frost = [];
  for (const t of Game.towers) {
    if (t.def.projectile === "pulse" && t.freeze > 0.02) {
      frost.push({ x: t.x, y: t.y, r: t.def.range, intensity: t.freeze });
    }
  }
  // Towers sitting inside a frost field get shielded from the warp so the
  // structures stay readable while the ground around them ripples.
  const protect = [];
  if (frost.length) {
    const pad = FrostParams.protectRadius;
    for (const t of Game.towers) {
      for (const f of frost) {
        const rr = f.r + pad;
        if (dist2(t.x, t.y, f.x, f.y) <= rr * rr) { protect.push({ x: t.x, y: t.y }); break; }
      }
    }
  }
  r.setFrostFields(frost, protect);

  // Sniper bullets radiate chromatic aberration through the post-process.
  const chroma = [];
  for (const p of Game.projectiles) {
    if (p.kind === "rail") chroma.push({ x: p.x, y: p.y });
  }
  r.setChromaPoints(chroma);

  // A charging laser emitter boils the air in front of it: feed each one as a
  // heat-haze source (warps + warm-tints the scene through the post-process).
  const heat = [];
  const cs = GameMap.CELL;
  for (const t of Game.towers) {
    if (!t.aim) continue;
    const p = Math.min(1, t.aim.t / t.aim.dur);
    const ml = (cs + 4) * 0.5;
    heat.push({
      x: t.x + Math.cos(t.angle) * ml,
      y: t.y + Math.sin(t.angle) * ml,
      r: 34 + p * 26,
      intensity: 0.3 + 0.7 * p,
    });
  }
  // Evaporating bodies boil the air too — strongest right as they vaporize.
  for (const fx of Game.effects) {
    if (fx.kind !== "evaporate") continue;
    const life = fx.t / fx.dur; // 1 → 0 over its life
    heat.push({ x: fx.x, y: fx.y - 4, r: fx.radius * 3, intensity: Math.min(1, life * 1.2) });
  }
  r.setHeatPoints(heat);

  // Helicopter rotor downwash drives the WebGL dust post-process (no-op in 2D).
  const dust = [];
  for (const t of Game.towers) {
    if (t.heli && t.heli.dust && t.heli.dust.intensity > 0.01) dust.push(t.heli.dust);
  }
  r.setDustPoints(dust);

  r.beginFrame();
  GameMap.draw(r);
  drawFrostGround(r);
  drawPlacementPreview(r);
  for (const t of Game.towers) t.draw(r);
  for (const e of Game.enemies) e.draw(r);
  for (const p of Game.projectiles) p.draw(r);
  drawEffects(r);
  // Airbase jets + bombs fly above everything else (drawn last in the world).
  for (const t of Game.towers) if (t.drawAir) t.drawAir(r);
  r.endFrame();

  // HUD overlays always render in Canvas-2D on the top layer, regardless of
  // which world renderer is active.
  const octx = Game.overlayCtx;
  octx.setTransform(Game.dpr, 0, 0, Game.dpr, 0, 0);
  octx.imageSmoothingEnabled = false;
  octx.clearRect(0, 0, Game.width, Game.height);
  drawDamageNumbers(octx);
  drawOverlays(octx);
}

// ---------------------------------------------------------------- loop

function frame(time) {
  const dt = Math.min(0.05, (time - Game.lastTime) / 1000 || 0.016);
  Game.lastTime = time;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

// Optional lil-gui panel for live-tuning the frost/displacement params. Guards
// on lil-gui being loaded (it's a CDN script), so the game runs fine without it.
function buildDebugUI() {
  const NS = window.lil;
  if (!NS || !NS.GUI) return;
  const gui = new NS.GUI({ title: "Debug — Frost" });
  const d = gui.addFolder("Displacement");
  d.add(FrostParams, "displaceAmp", 0, 20, 0.1).name("warp amount");
  d.add(FrostParams, "displaceFreq", 0.1, 3, 0.05).name("warp frequency");
  d.add(FrostParams, "tint", 0, 1, 0.01).name("ice tint");
  d.add(FrostParams, "sparkle", 0, 2, 0.01).name("sparkle");
  const p = gui.addFolder("Tower protection");
  p.add(FrostParams, "protectStrength", 0, 1, 0.01).name("strength");
  p.add(FrostParams, "protectRadius", 0, 60, 1).name("radius (px)");
  const b = gui.addFolder("Field buildup");
  b.add(FrostParams, "restLevel", 0, 1, 0.01).name("rest level");
  b.add(FrostParams, "rampUp", 0.1, 4, 0.05).name("ramp up");
  b.add(FrostParams, "rampDown", 0.1, 4, 0.05).name("ramp down");
  const c = gui.addFolder("Sniper chroma");
  c.add(ChromaParams, "strength", 0, 20, 0.1).name("separation (px)");
  c.add(ChromaParams, "radius", 5, 150, 1).name("radius (px)");
  c.add(ChromaParams, "blur", 0, 20, 0.1).name("blur (px)");
  const td = gui.addFolder("Time of day");
  td.add(DayNight, "target", 0, DayNight.PHASES.length, 0.01).name("phase").listen();
  td.add(DayNight, "ease", 0.2, 8, 0.1).name("transition speed");
  td.add(DayNight, "auto").name("auto-cycle").listen();
  td.add(DayNight, "secondsPerPhase", 2, 60, 1).name("phase seconds");
  makeGuiDraggable(gui);
}

// lil-gui pins itself top-right and isn't draggable; let the title bar move it.
// A plain click (no drag) still collapses/expands as usual.
function makeGuiDraggable(gui) {
  const el = gui.domElement;
  const title = el.querySelector(".title");
  if (!title) return;
  const rect = el.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.right = "auto";
  el.style.left = rect.left + "px";
  el.style.top = rect.top + "px";
  title.style.cursor = "move";

  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  title.addEventListener("mousedown", (e) => {
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top;
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    el.style.left = (ox + dx) + "px";
    el.style.top = (oy + dy) + "px";
  });
  window.addEventListener("mouseup", () => { dragging = false; });
  // Swallow the collapse-toggle click only when we actually dragged.
  title.addEventListener("click", (e) => {
    if (moved) { e.stopImmediatePropagation(); moved = false; }
  }, true);
}

function start() {
  buildShop();
  bindInput();
  // buildDebugUI();  // hidden for now — re-enable to live-tune frost/chroma params
  newMap();
  // Refit on resize while nothing is at stake; mid-game the canvas just
  // stretches via CSS so the layout (and your towers) stay intact.
  window.addEventListener("resize", () => {
    if (Game.wave === 0 && Game.towers.length === 0) newMap();
  });
  requestAnimationFrame(frame);
}

// Swap which renderer/canvas is live. The world has two stacked canvases
// (2D + WebGL); only one is shown. The overlay canvas (HUD) always sits on top.
function applyViewMode() {
  const gl = Game.useWebGL && Game.rendererGL.supported;
  Game.useWebGL = gl;
  Game.renderer = gl ? Game.rendererGL : Game.renderer2d;
  Game.canvas.style.display = gl ? "none" : "block";
  Game.glCanvas.style.display = gl ? "block" : "none";
  const btn = document.getElementById("toggle-view");
  if (btn) {
    btn.textContent = gl ? "View: WebGL" : "View: 2D";
    btn.disabled = !Game.rendererGL.supported;
    btn.title = Game.rendererGL.supported
      ? "Toggle the renderer (V)"
      : "WebGL is not available in this browser";
  }
}

function toggleView() {
  if (!Game.rendererGL.supported) return;
  Game.useWebGL = !Game.useWebGL;
  applyViewMode();
}

function init() {
  Game.glCanvas = document.getElementById("game-gl");
  Game.canvas = document.getElementById("game");          // 2D world layer
  Game.overlayCanvas = document.getElementById("overlay"); // HUD layer (always 2D)
  Game.overlayCtx = Game.overlayCanvas.getContext("2d");

  Game.renderer2d = new Canvas2DRenderer(Game.canvas);
  Game.rendererGL = new WebGLRenderer(Game.glCanvas);
  // Prefer WebGL when the browser supports it; applyViewMode falls back to 2D
  // if the context failed to create.
  Game.useWebGL = true;
  Game.renderer = Game.renderer2d;
  applyViewMode();

  // Start once the tilemap is decoded so the first frame has its sprites.
  Tileset.load(start);
}

init();
