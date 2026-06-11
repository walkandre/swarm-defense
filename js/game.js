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
  Game.canvas.width = Math.round(Game.width * Game.dpr);
  Game.canvas.height = Math.round(Game.height * Game.dpr);
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
  const rect = Game.canvas.getBoundingClientRect();
  const scaleX = Game.width / rect.width;
  const scaleY = Game.height / rect.height;
  const x = (ev.clientX - rect.left) * scaleX;
  const y = (ev.clientY - rect.top) * scaleY;
  return { cx: Math.floor(x / GameMap.CELL), cy: Math.floor(y / GameMap.CELL) };
}

function bindInput() {
  const canvas = Game.canvas;

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
  });

  document.getElementById("start-wave").addEventListener("click", startWave);
  document.getElementById("new-map").addEventListener("click", newMap);
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
    if (e.dead) goldEarned += e.def.gold;
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

function drawPlacementPreview(ctx) {
  if (!Game.selectedType || !Game.hoverCell) return;
  const { cx, cy } = Game.hoverCell;
  if (cx < 0 || cy < 0 || cx >= GameMap.cols || cy >= GameMap.rows) return;
  const def = TOWER_TYPES[Game.selectedType];
  const cs = GameMap.CELL;
  const px = cx * cs + cs / 2;
  const py = cy * cs + cs / 2;
  const ok = GameMap.canBuild(cx, cy) && def.cost <= Game.gold;

  ctx.beginPath();
  ctx.arc(px, py, def.range, 0, Math.PI * 2);
  ctx.fillStyle = ok ? "rgba(79, 195, 247, 0.08)" : "rgba(239, 71, 111, 0.08)";
  ctx.fill();
  ctx.strokeStyle = ok ? "rgba(79, 195, 247, 0.4)" : "rgba(239, 71, 111, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = ok ? "rgba(79, 195, 247, 0.35)" : "rgba(239, 71, 111, 0.35)";
  ctx.fillRect(cx * cs, cy * cs, cs, cs);
}

function drawEffects(ctx) {
  for (const fx of Game.effects) {
    if (fx.kind === "beam") {
      ctx.beginPath();
      ctx.moveTo(fx.x1, fx.y1);
      ctx.lineTo(fx.x2, fx.y2);
      ctx.strokeStyle = fx.color;
      ctx.globalAlpha = Math.max(0, fx.t / 0.12);
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (fx.kind === "blast") {
      const t = 1 - fx.t / 0.25;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, fx.r * (0.4 + 0.6 * t), 0, Math.PI * 2);
      ctx.strokeStyle = fx.color;
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
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
  const ctx = Game.ctx;
  ctx.setTransform(Game.dpr, 0, 0, Game.dpr, 0, 0);
  // Crisp pixel-art scaling; resizing the canvas resets this each time.
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, Game.width, Game.height);
  GameMap.draw(ctx);
  drawPlacementPreview(ctx);
  for (const t of Game.towers) t.draw(ctx);
  for (const e of Game.enemies) e.draw(ctx);
  for (const p of Game.projectiles) p.draw(ctx);
  drawEffects(ctx);
  drawOverlays(ctx);
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

function init() {
  Game.canvas = document.getElementById("game");
  Game.ctx = Game.canvas.getContext("2d");
  // Start once the tilemap is decoded so the first frame has its sprites.
  Tileset.load(start);
}

init();
