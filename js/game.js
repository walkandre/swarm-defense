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
    const btn = document.createElement("button");
    btn.className = "tower-btn";
    btn.dataset.type = type;
    btn.title = def.desc;
    btn.innerHTML = `<b style="color:${def.color}">${def.name}</b><small>${def.cost}g</small><span class="key">[${i + 1}]</span>`;
    btn.addEventListener("click", () => selectTower(type));
    shop.appendChild(btn);
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
    const def = TOWER_TYPES[btn.dataset.type];
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
    const def = TOWER_TYPES[Game.selectedType];
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
    if (ev.key === " " && !Game.waveActive) { ev.preventDefault(); startWave(); }
    if (ev.key === "v" || ev.key === "V") toggleView();
  });

  document.getElementById("start-wave").addEventListener("click", startWave);
  document.getElementById("new-map").addEventListener("click", newMap);
  document.getElementById("toggle-view").addEventListener("click", toggleView);
}

// ---------------------------------------------------------------- update

function update(dt) {
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

function drawPlacementPreview(r) {
  if (!Game.selectedType || !Game.hoverCell) return;
  const { cx, cy } = Game.hoverCell;
  if (cx < 0 || cy < 0 || cx >= GameMap.cols || cy >= GameMap.rows) return;
  const def = TOWER_TYPES[Game.selectedType];
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
  } else if (Game.wave === 0) {
    ctx.fillStyle = "rgba(216, 222, 233, 0.85)";
    ctx.font = "16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Build towers, then press Start Wave (or Space)", W / 2, 28);
    ctx.textAlign = "left";
  }
}

function render() {
  // World is painted by the active renderer (Canvas-2D or WebGL).
  const r = Game.renderer;
  r.beginFrame();
  GameMap.draw(r);
  drawPlacementPreview(r);
  for (const t of Game.towers) t.draw(r);
  for (const e of Game.enemies) e.draw(r);
  for (const p of Game.projectiles) p.draw(r);
  drawEffects(r);
  r.endFrame();

  // HUD overlays always render in Canvas-2D on the top layer, regardless of
  // which world renderer is active.
  const octx = Game.overlayCtx;
  octx.setTransform(Game.dpr, 0, 0, Game.dpr, 0, 0);
  octx.imageSmoothingEnabled = false;
  octx.clearRect(0, 0, Game.width, Game.height);
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

function start() {
  buildShop();
  bindInput();
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
  Game.useWebGL = false;
  Game.renderer = Game.renderer2d;
  applyViewMode();

  // Start once the tilemap is decoded so the first frame has its sprites.
  Tileset.load(start);
}

init();
