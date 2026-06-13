"use strict";

// ----------------------------------------------------------------------------
// Renderer abstraction.
//
// Both the legacy Canvas-2D path and the WebGL path implement the SAME small
// immediate-mode interface, so the game's draw code (GameMap.draw, Tower/Enemy/
// Projectile.draw, drawEffects, …) never touches a raw context — it calls
// renderer primitives and the active backend decides how to paint them.
//
// Interface (all coordinates are logical/CSS pixels):
//   beginFrame()                                   — clear + set up the frame
//   endFrame()                                     — flush any batched geometry
//   sprite(tile, dx, dy, dw, dh, flip, alpha=1)    — blit a tilemap.png tile
//   spriteRot(tile, cx, cy, dw, dh, angle, flip, alpha=1) — blit a tile rotated about its centre
//   rect(x, y, w, h, color, alpha=1)               — filled rectangle
//   disc(x, y, r, color, alpha=1, additive=false)  — filled circle
//   ring(x, y, r, color, lineWidth=1, a=1, add=false) — stroked circle
//   line(x1,y1,x2,y2, color, lineWidth=1, a=1, add=false) — thick line
//   glow(x, y, r, color, alpha=1)                  — additive radial bloom
//
// `color` is any CSS color string (hex / rgb / rgba). `additive` maps to
// "lighter" compositing in 2D and ONE,ONE blending in WebGL.
// ----------------------------------------------------------------------------

// Live-tunable frost/displacement parameters (exposed to the debug GUI). Read
// every frame by the post-process and the frost buildup logic, so edits apply
// immediately.
const FrostParams = {
  displaceAmp: 2.5,      // px of scene warp at full field intensity
  displaceFreq: 0.5,     // spatial frequency multiplier of the warp
  tint: 0.27,            // icy colour tint strength
  sparkle: 0.89,         // ice-crystal twinkle strength
  protectStrength: 0.62, // how much tower footprints resist the warp (0..1)
  protectRadius: 59,     // px radius around a tower kept crisp
  restLevel: 0.18,       // idle frost intensity (the resting cold aura)
  rampUp: 1.1,           // how fast the field builds while freezing
  rampDown: 0.5,         // how fast it relaxes when idle
};

// Chromatic aberration radiating from each sniper bullet (RGB channel split in
// the post-process). Also live-tunable via the debug GUI.
const ChromaParams = {
  strength: 6,   // max channel separation in px next to a bullet
  radius: 46,    // px falloff radius of the aberration around a bullet
  blur: 3,       // px blur radius around a bullet (spreads it into neighbours)
};

// Heat-haze shimmer rising off a charging laser emitter (a rising, warbling
// screen-space displacement + a faint warm tint in the post-process).
const HeatParams = {
  amp: 4.0,      // px of haze warp at full charge next to the emitter
  tint: 0.16,    // warm colour bleed strength inside the haze
};

// --- Time-of-day colour grading --------------------------------------------
// A whole-scene tone map applied as the final step of each frame: every painted
// pixel is multiplied by an `ambient` light colour (the dominant grade) and
// then a translucent `sky` colour is screened on top for atmosphere. Both
// backends read DayNight.grade() and apply the same maths, so 2D and WebGL look
// identical. The grade animates between PHASES so cycling reads as a smooth
// sunrise/sunset rather than a hard cut.
const DayNight = {
  // Ordered ring of looks. `ambient` is a multiply (<=1, can't brighten); `sky`
  // is [r,g,b,a] screened over the scene for a coloured haze.
  PHASES: [
    { name: "Day",   ambient: [1.00, 1.00, 1.00], sky: [0.00, 0.00, 0.00, 0.00] },
    { name: "Dusk",  ambient: [1.00, 0.74, 0.56], sky: [1.00, 0.42, 0.16, 0.16] },
    { name: "Night", ambient: [0.40, 0.48, 0.78], sky: [0.08, 0.16, 0.44, 0.20] },
    { name: "Dawn",  ambient: [0.94, 0.78, 0.84], sky: [1.00, 0.60, 0.52, 0.12] },
  ],

  t: 0,        // current position along the phase ring (continuous, animated)
  target: 0,   // where we're easing toward (a phase index, may exceed length)
  ease: 2.5,   // how fast `t` chases `target` (per second)
  auto: false, // continuously advance through the cycle on its own?
  secondsPerPhase: 12, // dwell time per phase while auto-cycling

  // Step forward to the next phase (wraps via the ever-growing target).
  next() { this.target = Math.round(this.target) + 1; },

  // Advance the clock: auto-cycle pushes the target, then `t` eases toward it.
  update(dt) {
    if (this.auto) this.target += dt / this.secondsPerPhase;
    this.t += (this.target - this.t) * Math.min(1, dt * this.ease);
  },

  phaseName() {
    const n = this.PHASES.length;
    return this.PHASES[((Math.round(this.t) % n) + n) % n].name;
  },

  // Interpolate the two phases bracketing the current `t`.
  grade() {
    const n = this.PHASES.length;
    const tt = ((this.t % n) + n) % n;
    const i = Math.floor(tt);
    const f = tt - i;
    const a = this.PHASES[i];
    const b = this.PHASES[(i + 1) % n];
    return {
      ambient: [
        lerp(a.ambient[0], b.ambient[0], f),
        lerp(a.ambient[1], b.ambient[1], f),
        lerp(a.ambient[2], b.ambient[2], f),
      ],
      sky: [
        lerp(a.sky[0], b.sky[0], f),
        lerp(a.sky[1], b.sky[1], f),
        lerp(a.sky[2], b.sky[2], f),
        lerp(a.sky[3], b.sky[3], f),
      ],
    };
  },

  // 0 in full daylight → 1 at deep night, from the ambient light's luminance.
  // Drives emissive effects (e.g. bullets casting light) so they only glow once
  // the world is dark enough for the light to read.
  darkness() {
    const a = this.grade().ambient;
    const lum = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
    return clamp((1 - lum) * 1.8, 0, 1);
  },

  // True when the grade is a no-op (plain daylight) so backends can skip it.
  isIdentity() {
    const g = this.grade();
    return g.sky[3] < 0.002 &&
      Math.abs(g.ambient[0] - 1) < 0.002 &&
      Math.abs(g.ambient[1] - 1) < 0.002 &&
      Math.abs(g.ambient[2] - 1) < 0.002;
  },
};

// --- shared color parsing (WebGL needs floats; cached so it's cheap per-frame).
const _colorCache = new Map();
function parseColor(css) {
  let c = _colorCache.get(css);
  if (c) return c;
  c = [1, 1, 1, 1];
  if (css[0] === "#") {
    let h = css.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    c[0] = parseInt(h.slice(0, 2), 16) / 255;
    c[1] = parseInt(h.slice(2, 4), 16) / 255;
    c[2] = parseInt(h.slice(4, 6), 16) / 255;
    if (h.length >= 8) c[3] = parseInt(h.slice(6, 8), 16) / 255;
  } else {
    const m = css.match(/[-\d.]+/g);
    if (m) {
      c[0] = (+m[0]) / 255;
      c[1] = (+m[1]) / 255;
      c[2] = (+m[2]) / 255;
      c[3] = m.length > 3 ? +m[3] : 1;
    }
  }
  _colorCache.set(css, c);
  return c;
}

// ============================================================ Canvas 2D backend

class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.supported = true;
  }

  beginFrame() {
    const ctx = this.ctx;
    ctx.setTransform(Game.dpr, 0, 0, Game.dpr, 0, 0);
    // Crisp pixel-art scaling; resizing the canvas resets this each time.
    ctx.imageSmoothingEnabled = false;
    // Paint an opaque backdrop (matching the WebGL clear / CSS #181b22) rather
    // than clearing to transparent, so the time-of-day multiply in endFrame
    // grades the whole canvas — uncovered margins included — exactly like the
    // WebGL post pass does, instead of leaving solid ambient bars at the edges.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#181b22";
    ctx.fillRect(0, 0, Game.width, Game.height);
  }

  endFrame() {
    if (DayNight.isIdentity()) return;
    const ctx = this.ctx;
    const g = DayNight.grade();
    const u8 = (v) => Math.round(clamp(v, 0, 1) * 255);
    // Ambient: multiply the framebuffer down toward the light colour.
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgb(${u8(g.ambient[0])}, ${u8(g.ambient[1])}, ${u8(g.ambient[2])})`;
    ctx.fillRect(0, 0, Game.width, Game.height);
    // Sky: screen a translucent atmosphere tint on top.
    if (g.sky[3] > 0.002) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = g.sky[3];
      ctx.fillStyle = `rgb(${u8(g.sky[0])}, ${u8(g.sky[1])}, ${u8(g.sky[2])})`;
      ctx.fillRect(0, 0, Game.width, Game.height);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // Canvas-2D can't sample the framebuffer, so these screen-space post effects
  // are WebGL-only flourishes; no-ops here (the frost ground/aura/tint and the
  // bullet trails still render through the shared primitives).
  setFrostFields() {}
  setChromaPoints() {}
  setHeatPoints() {}
  setDustPoints() {}

  sprite(tile, dx, dy, dw, dh, flip, alpha = 1) {
    const ctx = this.ctx;
    if (alpha !== 1) ctx.globalAlpha = alpha;
    Tileset.draw(ctx, tile, dx, dy, dw, dh, flip);
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  // Blit a tile rotated `angle` radians about the centre point (cx, cy).
  spriteRot(tile, cx, cy, dw, dh, angle, flip, alpha = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    Tileset.draw(ctx, tile, -dw / 2, -dh / 2, dw, dh, flip);
    ctx.restore();
  }

  rect(x, y, w, h, color, alpha = 1) {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }

  disc(x, y, r, color, alpha = 1, additive = false) {
    const ctx = this.ctx;
    if (additive) { ctx.save(); ctx.globalCompositeOperation = "lighter"; }
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (additive) ctx.restore();
  }

  ring(x, y, r, color, lineWidth = 1, alpha = 1, additive = false) {
    const ctx = this.ctx;
    if (additive) { ctx.save(); ctx.globalCompositeOperation = "lighter"; }
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (additive) ctx.restore();
  }

  line(x1, y1, x2, y2, color, lineWidth = 1, alpha = 1, additive = false) {
    const ctx = this.ctx;
    if (additive) { ctx.save(); ctx.globalCompositeOperation = "lighter"; }
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (additive) ctx.restore();
  }

  glow(x, y, r, color, alpha = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255, 248, 220, 0.9)");
    g.addColorStop(0.4, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ============================================================ WebGL backend

// Two programs, one reused vertex buffer. Draw calls are accumulated into a
// single ordered stream and flushed whenever the primitive kind (sprite vs.
// shape) or blend mode (normal vs. additive) changes — this preserves exact
// draw order (so layering matches the 2D path) while batching long runs of the
// same primitive (e.g. the ~600 ground tiles) into one GPU draw call.
class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { premultipliedAlpha: true, alpha: true, antialias: false, depth: false };
    const gl = canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts);
    this.gl = gl;
    this.supported = !!gl;
    if (!gl) return;

    this.spriteProg = this._program(WebGLRenderer.SPRITE_VS, WebGLRenderer.SPRITE_FS,
      { a_pos: 0, a_uv: 1, a_alpha: 2 });
    this.shapeProg = this._program(WebGLRenderer.SHAPE_VS, WebGLRenderer.SHAPE_FS,
      { a_pos: 0, a_local: 1, a_color: 2, a_misc: 3 });
    this.uSpriteRes = gl.getUniformLocation(this.spriteProg, "u_res");
    this.uSpriteTex = gl.getUniformLocation(this.spriteProg, "u_tex");
    this.uShapeRes = gl.getUniformLocation(this.shapeProg, "u_res");

    this.buffer = gl.createBuffer();
    this.tex = null;          // tilemap texture, created lazily once it decodes
    this.verts = [];          // float stream for the current batch
    this.cur = null;          // { kind, blend } of the current batch

    // Frost post-process: scene is rendered to an offscreen target, then a
    // fullscreen pass warps it (displacement) + tints it inside frost fields.
    this.postProg = this._program(WebGLRenderer.POST_VS, WebGLRenderer.POST_FS, { a_pos: 0 });
    this.uPostScene = gl.getUniformLocation(this.postProg, "u_scene");
    this.uPostRes = gl.getUniformLocation(this.postProg, "u_res");
    this.uPostTime = gl.getUniformLocation(this.postProg, "u_time");
    this.uPostCount = gl.getUniformLocation(this.postProg, "u_count");
    this.uPostFields = gl.getUniformLocation(this.postProg, "u_fields[0]");
    this.uPostTowers = gl.getUniformLocation(this.postProg, "u_towers[0]");
    this.uPostTowerCount = gl.getUniformLocation(this.postProg, "u_towerCount");
    this.uPostAmp = gl.getUniformLocation(this.postProg, "u_amp");
    this.uPostFreq = gl.getUniformLocation(this.postProg, "u_freq");
    this.uPostTint = gl.getUniformLocation(this.postProg, "u_tint");
    this.uPostSparkle = gl.getUniformLocation(this.postProg, "u_sparkle");
    this.uPostProtectStr = gl.getUniformLocation(this.postProg, "u_protectStr");
    this.uPostProtectRad = gl.getUniformLocation(this.postProg, "u_protectRad");
    this.uPostChroma = gl.getUniformLocation(this.postProg, "u_chroma[0]");
    this.uPostChromaCount = gl.getUniformLocation(this.postProg, "u_chromaCount");
    this.uPostChromaStr = gl.getUniformLocation(this.postProg, "u_chromaStr");
    this.uPostChromaRad = gl.getUniformLocation(this.postProg, "u_chromaRad");
    this.uPostChromaBlur = gl.getUniformLocation(this.postProg, "u_chromaBlur");
    this.uPostHeat = gl.getUniformLocation(this.postProg, "u_heat[0]");
    this.uPostHeatCount = gl.getUniformLocation(this.postProg, "u_heatCount");
    this.uPostHeatAmp = gl.getUniformLocation(this.postProg, "u_heatAmp");
    this.uPostHeatTint = gl.getUniformLocation(this.postProg, "u_heatTint");
    this.uPostDust = gl.getUniformLocation(this.postProg, "u_dust[0]");
    this.uPostDustCount = gl.getUniformLocation(this.postProg, "u_dustCount");
    this.uPostAmbient = gl.getUniformLocation(this.postProg, "u_ambient");
    this.uPostSky = gl.getUniformLocation(this.postProg, "u_sky");
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    this.fbo = null;
    this.sceneTex = null;
    this.fboW = 0; this.fboH = 0;
    this.frostFields = [];
    this.frostTowers = [];   // tower positions to keep crisp inside the field
    this.chromaPoints = [];  // sniper bullet positions for chromatic aberration
    this.heatPoints = [];    // charging-laser emitters that shimmer with heat haze
    this.dustPoints = [];    // helicopter downwash that swirls dust off the ground
    this._fieldBuf = new Float32Array(WebGLRenderer.MAX_FROST * 4);
    this._towerBuf = new Float32Array(WebGLRenderer.MAX_PROTECT * 2);
    this._chromaBuf = new Float32Array(WebGLRenderer.MAX_CHROMA * 2);
    this._heatBuf = new Float32Array(WebGLRenderer.MAX_HEAT * 4);
    this._dustBuf = new Float32Array(WebGLRenderer.MAX_DUST * 4);
    this.t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  // The game hands us the active frost fields each frame (logical x,y,radius +
  // 0..1 intensity) plus the tower positions to shield from the warp. The
  // fields' presence switches the displacement pass on.
  setFrostFields(fields, towers) {
    this.frostFields = fields || [];
    this.frostTowers = towers || [];
  }

  // Sniper bullet positions that radiate chromatic aberration.
  setChromaPoints(points) { this.chromaPoints = points || []; }

  // Charging-laser emitters (logical x,y + radius + 0..1 intensity) that warp
  // the scene with a rising heat shimmer.
  setHeatPoints(points) { this.heatPoints = points || []; }

  // Helicopter rotor downwash (logical x,y + radius + 0..1 intensity) that
  // swirls a tan dust cloud up off the ground.
  setDustPoints(points) { this.dustPoints = points || []; }

  // (Re)create the offscreen scene target when the backing size changes.
  _ensureTargets(bw, bh) {
    const gl = this.gl;
    if (this.fbo && this.fboW === bw && this.fboH === bh) return;
    if (this.sceneTex) gl.deleteTexture(this.sceneTex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboW = bw; this.fboH = bh;
  }

  _postPass() {
    const gl = this.gl;
    gl.useProgram(this.postProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(this.uPostScene, 0);
    gl.uniform2f(this.uPostRes, Game.width, Game.height);
    gl.uniform1f(this.uPostTime, (performance.now() - this.t0) / 1000);
    const n = Math.min(WebGLRenderer.MAX_FROST, this.frostFields.length);
    gl.uniform1i(this.uPostCount, n);
    const arr = this._fieldBuf;
    arr.fill(0);
    for (let i = 0; i < n; i++) {
      const f = this.frostFields[i];
      arr[i * 4] = f.x; arr[i * 4 + 1] = f.y; arr[i * 4 + 2] = f.r; arr[i * 4 + 3] = f.intensity;
    }
    gl.uniform4fv(this.uPostFields, arr);

    // Tower footprints to shield from the warp.
    const tn = Math.min(WebGLRenderer.MAX_PROTECT, this.frostTowers.length);
    gl.uniform1i(this.uPostTowerCount, tn);
    const tarr = this._towerBuf;
    tarr.fill(0);
    for (let i = 0; i < tn; i++) {
      tarr[i * 2] = this.frostTowers[i].x;
      tarr[i * 2 + 1] = this.frostTowers[i].y;
    }
    gl.uniform2fv(this.uPostTowers, tarr);

    // Chromatic-aberration sources (sniper bullets).
    const cn = Math.min(WebGLRenderer.MAX_CHROMA, this.chromaPoints.length);
    gl.uniform1i(this.uPostChromaCount, cn);
    const carr = this._chromaBuf;
    carr.fill(0);
    for (let i = 0; i < cn; i++) {
      carr[i * 2] = this.chromaPoints[i].x;
      carr[i * 2 + 1] = this.chromaPoints[i].y;
    }
    gl.uniform2fv(this.uPostChroma, carr);
    gl.uniform1f(this.uPostChromaStr, ChromaParams.strength);
    gl.uniform1f(this.uPostChromaRad, ChromaParams.radius);
    gl.uniform1f(this.uPostChromaBlur, ChromaParams.blur);

    // Heat-haze sources (charging laser emitters).
    const hn = Math.min(WebGLRenderer.MAX_HEAT, this.heatPoints.length);
    gl.uniform1i(this.uPostHeatCount, hn);
    const harr = this._heatBuf;
    harr.fill(0);
    for (let i = 0; i < hn; i++) {
      const h = this.heatPoints[i];
      harr[i * 4] = h.x; harr[i * 4 + 1] = h.y; harr[i * 4 + 2] = h.r; harr[i * 4 + 3] = h.intensity;
    }
    gl.uniform4fv(this.uPostHeat, harr);
    gl.uniform1f(this.uPostHeatAmp, HeatParams.amp);
    gl.uniform1f(this.uPostHeatTint, HeatParams.tint);

    // Helicopter dust sources.
    const dn = Math.min(WebGLRenderer.MAX_DUST, this.dustPoints.length);
    gl.uniform1i(this.uPostDustCount, dn);
    const darr = this._dustBuf;
    darr.fill(0);
    for (let i = 0; i < dn; i++) {
      const d = this.dustPoints[i];
      darr[i * 4] = d.x; darr[i * 4 + 1] = d.y; darr[i * 4 + 2] = d.r; darr[i * 4 + 3] = d.intensity;
    }
    gl.uniform4fv(this.uPostDust, darr);

    // Time-of-day grade (ambient multiply + screened sky tint).
    const grade = DayNight.grade();
    gl.uniform3f(this.uPostAmbient, grade.ambient[0], grade.ambient[1], grade.ambient[2]);
    gl.uniform4f(this.uPostSky, grade.sky[0], grade.sky[1], grade.sky[2], grade.sky[3]);

    // Live-tunable parameters.
    gl.uniform1f(this.uPostAmp, FrostParams.displaceAmp);
    gl.uniform1f(this.uPostFreq, FrostParams.displaceFreq);
    gl.uniform1f(this.uPostTint, FrostParams.tint);
    gl.uniform1f(this.uPostSparkle, FrostParams.sparkle);
    gl.uniform1f(this.uPostProtectStr, FrostParams.protectStrength);
    gl.uniform1f(this.uPostProtectRad, FrostParams.protectRadius);

    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.BLEND);
  }

  _program(vsSrc, fsSrc, attribs) {
    const gl = this.gl;
    const vs = this._shader(gl.VERTEX_SHADER, vsSrc);
    const fs = this._shader(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    // Fix attribute locations so both programs share indices 0..3.
    for (const name in attribs) gl.bindAttribLocation(p, attribs[name], name);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("Program link failed:", gl.getProgramInfoLog(p));
    }
    return p;
  }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("Shader compile failed:", gl.getShaderInfoLog(s), src);
    }
    return s;
  }

  _ensureTexture() {
    if (!Tileset.ready || !Tileset.img) return;
    // Re-upload when the active sheet changes (Tileset.swap bumps version).
    if (this.tex && this.texVersion === Tileset.version) return;
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    this.texVersion = Tileset.version;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, Tileset.img);
    // Crisp pixel art: nearest sampling, clamped, no mipmaps.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texW = Tileset.img.width;
    this.texH = Tileset.img.height;
  }

  beginFrame() {
    const gl = this.gl;
    const bw = Math.round(Game.width * Game.dpr);
    const bh = Math.round(Game.height * Game.dpr);
    this.bw = bw; this.bh = bh;
    // Only pay for the offscreen target + post pass when an effect needs it.
    this.usePost = this.frostFields.length > 0 || this.chromaPoints.length > 0 ||
      this.heatPoints.length > 0 || this.dustPoints.length > 0 || !DayNight.isIdentity();
    if (this.usePost) this._ensureTargets(bw, bh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.usePost ? this.fbo : null);
    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0.094, 0.106, 0.133, 1); // #181b22, matching the CSS backdrop
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.verts.length = 0;
    this.cur = null;
  }

  endFrame() {
    this._flush();
    if (this.usePost) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.bw, this.bh);
      this._postPass();
    }
  }

  // Switch the active batch, flushing the previous one if the kind/blend differ.
  _batch(kind, blend) {
    if (this.cur && this.cur.kind === kind && this.cur.blend === blend) return;
    this._flush();
    this.cur = { kind, blend };
  }

  _flush() {
    const gl = this.gl;
    if (!this.cur || this.verts.length === 0) { this.verts.length = 0; return; }
    const sprite = this.cur.kind === "sprite";
    const floats = sprite ? 5 : 12;
    const count = this.verts.length / floats;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.verts), gl.DYNAMIC_DRAW);

    // Reset attribute state (locations 0..3 are fixed across both programs).
    for (let i = 0; i < 4; i++) gl.disableVertexAttribArray(i);

    const stride = floats * 4;
    if (sprite) {
      gl.useProgram(this.spriteProg);
      gl.uniform2f(this.uSpriteRes, Game.width, Game.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.uSpriteTex, 0);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
    } else {
      gl.useProgram(this.shapeProg);
      gl.uniform2f(this.uShapeRes, Game.width, Game.height);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
    }

    if (this.cur.blend === "add") gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha

    gl.drawArrays(gl.TRIANGLES, 0, count);
    this.verts.length = 0;
  }

  // --- primitives -----------------------------------------------------------

  sprite(tile, dx, dy, dw, dh, flip, alpha = 1) {
    this._ensureTexture();
    if (!this.tex) return;
    this._batch("sprite", "normal");
    const step = Tileset.TILE + Tileset.GAP;
    const inset = 0.5; // half a texel, avoids sampling the 1px gutter
    let u0 = (tile[0] * step + inset) / this.texW;
    let u1 = (tile[0] * step + Tileset.TILE - inset) / this.texW;
    const v0 = (tile[1] * step + inset) / this.texH;
    const v1 = (tile[1] * step + Tileset.TILE - inset) / this.texH;
    if (flip) { const t = u0; u0 = u1; u1 = t; }
    const v = this.verts;
    const a = alpha;
    const x1 = dx + dw, y1 = dy + dh;
    v.push(dx, dy, u0, v0, a,  x1, dy, u1, v0, a,  x1, y1, u1, v1, a);
    v.push(dx, dy, u0, v0, a,  x1, y1, u1, v1, a,  dx, y1, u0, v1, a);
  }

  // Rotated blit: same UVs as sprite(), but the four corners are rotated about
  // (cx, cy) by `angle` so the tile can face any heading.
  spriteRot(tile, cx, cy, dw, dh, angle, flip, alpha = 1) {
    this._ensureTexture();
    if (!this.tex) return;
    this._batch("sprite", "normal");
    const step = Tileset.TILE + Tileset.GAP;
    const inset = 0.5;
    let u0 = (tile[0] * step + inset) / this.texW;
    let u1 = (tile[0] * step + Tileset.TILE - inset) / this.texW;
    const v0 = (tile[1] * step + inset) / this.texH;
    const v1 = (tile[1] * step + Tileset.TILE - inset) / this.texH;
    if (flip) { const t = u0; u0 = u1; u1 = t; }
    const co = Math.cos(angle), si = Math.sin(angle);
    const hw = dw / 2, hh = dh / 2;
    const px = (lx, ly) => cx + lx * co - ly * si;
    const py = (lx, ly) => cy + lx * si + ly * co;
    // corners: TL(-hw,-hh) TR(hw,-hh) BR(hw,hh) BL(-hw,hh)
    const ax = px(-hw, -hh), ay = py(-hw, -hh);
    const bx = px(hw, -hh),  by = py(hw, -hh);
    const cX = px(hw, hh),   cY = py(hw, hh);
    const dX = px(-hw, hh),  dY = py(-hw, hh);
    const v = this.verts;
    const a = alpha;
    v.push(ax, ay, u0, v0, a,  bx, by, u1, v0, a,  cX, cY, u1, v1, a);
    v.push(ax, ay, u0, v0, a,  cX, cY, u1, v1, a,  dX, dY, u0, v1, a);
  }

  // Push a shape quad: four corners carry a local coord in [-1,1] (used by the
  // fragment shader for disc/ring/glow falloff) plus a shared color + params.
  _shapeQuad(corners, r, g, b, a, mode, inner, aa) {
    const v = this.verts;
    const c = corners;
    const emit = (i) => v.push(c[i][0], c[i][1], c[i][2], c[i][3], r, g, b, a, mode, inner, aa, 0);
    emit(0); emit(1); emit(2);
    emit(0); emit(2); emit(3);
  }

  rect(x, y, w, h, color, alpha = 1) {
    this._batch("shape", "normal");
    const c = parseColor(color);
    this._shapeQuad(
      [[x, y, 0, 0], [x + w, y, 0, 0], [x + w, y + h, 0, 0], [x, y + h, 0, 0]],
      c[0], c[1], c[2], c[3] * alpha, 0, 0, 0);
  }

  _radial(x, y, R, mode, inner, aa, color, alpha, additive) {
    this._batch("shape", additive ? "add" : "normal");
    const c = parseColor(color);
    this._shapeQuad(
      [[x - R, y - R, -1, -1], [x + R, y - R, 1, -1], [x + R, y + R, 1, 1], [x - R, y + R, -1, 1]],
      c[0], c[1], c[2], c[3] * alpha, mode, inner, aa);
  }

  disc(x, y, r, color, alpha = 1, additive = false) {
    this._radial(x, y, r, 1, 0, 1.5 / r, color, alpha, additive);
  }

  ring(x, y, r, color, lineWidth = 1, alpha = 1, additive = false) {
    const R = r + lineWidth / 2;
    const inner = Math.max(0, (r - lineWidth / 2) / R);
    this._radial(x, y, R, 2, inner, 1.5 / R, color, alpha, additive);
  }

  glow(x, y, r, color, alpha = 1) {
    this._radial(x, y, r, 3, 0, 0, color, alpha, true);
  }

  line(x1, y1, x2, y2, color, lineWidth = 1, alpha = 1, additive = false) {
    this._batch("shape", additive ? "add" : "normal");
    let nx = y2 - y1, ny = -(x2 - x1);
    const len = Math.hypot(nx, ny) || 1;
    nx = (nx / len) * lineWidth / 2;
    ny = (ny / len) * lineWidth / 2;
    const c = parseColor(color);
    this._shapeQuad(
      [[x1 + nx, y1 + ny, 0, 0], [x2 + nx, y2 + ny, 0, 0],
       [x2 - nx, y2 - ny, 0, 0], [x1 - nx, y1 - ny, 0, 0]],
      c[0], c[1], c[2], c[3] * alpha, 0, 0, 0);
  }
}

// --- shaders (projection maps logical pixels → clip space, Y pointing down) ---

WebGLRenderer.SPRITE_VS = `
attribute vec2 a_pos;
attribute vec2 a_uv;
attribute float a_alpha;
uniform vec2 u_res;
varying vec2 v_uv;
varying float v_alpha;
void main() {
  vec2 c = vec2(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0);
  gl_Position = vec4(c, 0.0, 1.0);
  v_uv = a_uv;
  v_alpha = a_alpha;
}`;

WebGLRenderer.SPRITE_FS = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
varying float v_alpha;
// Texture is premultiplied alpha, so scaling the whole sample by v_alpha fades
// it correctly under the ONE, ONE_MINUS_SRC_ALPHA blend.
void main() { gl_FragColor = texture2D(u_tex, v_uv) * v_alpha; }`;

WebGLRenderer.SHAPE_VS = `
attribute vec2 a_pos;
attribute vec2 a_local;
attribute vec4 a_color;
attribute vec4 a_misc;
uniform vec2 u_res;
varying vec2 v_local;
varying vec4 v_color;
varying vec4 v_misc;
void main() {
  vec2 c = vec2(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0);
  gl_Position = vec4(c, 0.0, 1.0);
  v_local = a_local;
  v_color = a_color;
  v_misc = a_misc;
}`;

// mode: 0 solid · 1 disc · 2 ring · 3 glow.  Output is premultiplied alpha.
WebGLRenderer.SHAPE_FS = `
precision mediump float;
varying vec2 v_local;
varying vec4 v_color;
varying vec4 v_misc;
void main() {
  float mode = v_misc.x;
  float inner = v_misc.y;
  float aa = max(v_misc.z, 0.0001);
  if (mode > 2.5) {
    // Glow: white-hot core fading to the tint colour, additive bloom.
    float d = length(v_local);
    float inten = clamp(1.0 - d, 0.0, 1.0);
    inten = inten * inten;
    float core = inten * inten;
    vec3 rgb = mix(v_color.rgb, vec3(1.0, 0.97, 0.86), core);
    float a = inten * v_color.a;
    gl_FragColor = vec4(rgb * a, a);
    return;
  }
  float cov = 1.0;
  if (mode > 0.5 && mode < 1.5) {
    float d = length(v_local);
    cov = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  } else if (mode > 1.5) {
    float d = length(v_local);
    float outer = 1.0 - smoothstep(1.0 - aa, 1.0, d);
    float ins = smoothstep(inner - aa, inner + aa, d);
    cov = outer * ins;
  }
  float a = v_color.a * cov;
  gl_FragColor = vec4(v_color.rgb * a, a);
}`;

// --- frost displacement post-process ---------------------------------------
// Samples the rendered scene texture and, inside each frost field, warps the
// lookup by an animated procedural noise (the "displacement map"), tints the
// result icy, and adds a sparse sparkle. Outside fields it's an identity blit.

WebGLRenderer.MAX_FROST = 8;
WebGLRenderer.MAX_PROTECT = 16;
WebGLRenderer.MAX_CHROMA = 8;
WebGLRenderer.MAX_HEAT = 8;
WebGLRenderer.MAX_DUST = 8;

WebGLRenderer.POST_VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

WebGLRenderer.POST_FS = `
precision highp float;
uniform sampler2D u_scene;
uniform vec2 u_res;                 // logical resolution
uniform float u_time;
uniform int u_count;
uniform vec4 u_fields[8];           // x,y (logical), radius, intensity
uniform int u_towerCount;
uniform vec2 u_towers[16];          // tower footprints to keep crisp
uniform float u_amp;
uniform float u_freq;
uniform float u_tint;
uniform float u_sparkle;
uniform float u_protectStr;
uniform float u_protectRad;
uniform int u_chromaCount;
uniform vec2 u_chroma[8];           // sniper bullet positions (logical)
uniform float u_chromaStr;
uniform float u_chromaRad;
uniform float u_chromaBlur;
uniform int u_heatCount;
uniform vec4 u_heat[8];             // x,y (logical), radius, intensity
uniform float u_heatAmp;
uniform float u_heatTint;
uniform int u_dustCount;
uniform vec4 u_dust[8];             // x,y (logical), radius, intensity
uniform vec3 u_ambient;             // time-of-day light multiply
uniform vec4 u_sky;                 // time-of-day sky tint (rgb, strength)
varying vec2 v_uv;

void main() {
  // Reconstruct this fragment's logical-pixel position (v_uv.y is flipped
  // relative to logical Y because the scene texture's row 0 is the bottom).
  vec2 frag = vec2(v_uv.x * u_res.x, (1.0 - v_uv.y) * u_res.y);

  float frost = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_count) break;
    vec4 f = u_fields[i];
    float d = distance(frag, f.xy);
    frost += (1.0 - smoothstep(f.z * 0.2, f.z, d)) * f.w;
  }
  frost = clamp(frost, 0.0, 1.0);

  // Tower footprints resist the warp: a structure shouldn't ripple like liquid.
  float protect = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= u_towerCount) break;
    float d = distance(frag, u_towers[i]);
    protect = max(protect, 1.0 - smoothstep(u_protectRad * 0.5, u_protectRad, d));
  }

  vec2 uv = v_uv;
  if (frost > 0.001) {
    // Animated displacement field (layered waves = a cheap displacement map).
    float fq = u_freq;
    vec2 disp = vec2(
      sin(frag.x * 0.05 * fq + u_time * 1.3) + sin(frag.y * 0.08 * fq - u_time * 1.1),
      sin(frag.x * 0.07 * fq - u_time * 0.9) + sin(frag.y * 0.045 * fq + u_time * 1.5));
    disp += 0.5 * vec2(sin(frag.y * 0.20 * fq + u_time * 4.0), cos(frag.x * 0.22 * fq - u_time * 3.0));
    float amp = u_amp * frost * (1.0 - protect * u_protectStr);
    uv += (disp * amp) / u_res * vec2(1.0, -1.0);
  }

  // Heat haze: a rising, warbling displacement around each charging emitter —
  // strongest at the source, biased to the air above it (heat rises), mostly a
  // horizontal shimmer scrolling upward. The accumulated heat also drives a
  // warm tint applied after sampling, below.
  float heat = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_heatCount) break;
    vec4 h = u_heat[i];
    float d = distance(frag, h.xy);
    float fall = (1.0 - smoothstep(h.z * 0.1, h.z, d)) * h.w;
    float above = clamp((h.y - frag.y) / h.z + 0.3, 0.0, 1.0);
    fall *= mix(0.35, 1.0, above);
    if (fall > 0.0) {
      heat += fall;
      float ph = (h.x + h.y) * 0.05;
      float wobX = sin(frag.y * 0.45 - u_time * 7.0 + ph)
                 + 0.5 * sin(frag.y * 0.9 - u_time * 11.0 + ph * 1.7);
      float wobY = 0.4 * sin(frag.x * 0.6 - u_time * 6.0 + ph);
      uv += vec2(wobX, wobY) * fall * u_heatAmp / u_res * vec2(1.0, -1.0);
    }
  }
  heat = clamp(heat, 0.0, 1.0);

  // Helicopter rotor downwash: dust billows outward from under the rotor in
  // animated rings and a swirl that drags the scene tangentially (the blades
  // stirring the air). The accumulated amount drives a tan tint after sampling.
  float dust = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_dustCount) break;
    vec4 d = u_dust[i];
    vec2 rel = frag - d.xy;
    float dd = length(rel);
    float fall = (1.0 - smoothstep(d.z * 0.15, d.z, dd)) * d.w;
    if (fall > 0.0) {
      float ang = atan(rel.y, rel.x);
      float ring = 0.5 + 0.5 * sin(dd * 0.22 - u_time * 5.0 + sin(ang * 3.0 + u_time * 1.5) * 1.5);
      dust += fall * ring;
      vec2 tang = vec2(-rel.y, rel.x) / max(dd, 1.0);
      uv += tang * fall * 2.0 * sin(u_time * 4.0 + dd * 0.08) / u_res * vec2(1.0, -1.0);
    }
  }
  dust = clamp(dust, 0.0, 1.0);

  // Chromatic aberration radiating from each bullet: split the R/B channels
  // along the radial direction, strongest at the bullet and fading to nothing.
  // The same proximity drives a localised blur that spreads the bullet out.
  vec2 ca = vec2(0.0);
  float bf = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_chromaCount) break;
    vec2 d = frag - u_chroma[i];
    float dist = length(d);
    float fall = 1.0 - smoothstep(0.0, u_chromaRad, dist);
    bf = max(bf, fall);
    if (dist > 0.001) ca += (d / dist) * fall;
  }
  ca = clamp(ca, -1.0, 1.0) * u_chromaStr;
  vec2 caUV = ca / u_res * vec2(1.0, -1.0);

  vec3 col;
  float blurPx = bf * u_chromaBlur;
  if (blurPx > 0.25) {
    // 8-tap ring blur (+ centre) with the channel split applied to each tap.
    vec3 acc = vec3(0.0);
    for (int t = 0; t < 8; t++) {
      float ang = float(t) * 0.7853982; // 45 deg steps
      vec2 off = vec2(cos(ang), sin(ang)) * blurPx / u_res * vec2(1.0, -1.0);
      acc.r += texture2D(u_scene, uv + off + caUV).r;
      acc.g += texture2D(u_scene, uv + off).g;
      acc.b += texture2D(u_scene, uv + off - caUV).b;
    }
    acc.r += texture2D(u_scene, uv + caUV).r;
    acc.g += texture2D(u_scene, uv).g;
    acc.b += texture2D(u_scene, uv - caUV).b;
    col = acc / 9.0;
  } else {
    col.r = texture2D(u_scene, uv + caUV).r;
    col.g = texture2D(u_scene, uv).g;
    col.b = texture2D(u_scene, uv - caUV).b;
  }

  if (frost > 0.001) {
    // Icy tint + faint frosting, plus a sparse twinkle of ice crystals.
    vec3 ice = vec3(0.78, 0.90, 1.0);
    col = mix(col, col * ice + vec3(0.06) * frost, frost * u_tint);
    float spk = sin(frag.x * 0.7 + u_time * 5.0) * sin(frag.y * 0.6 - u_time * 4.0);
    col += smoothstep(0.96, 1.0, spk) * frost * u_sparkle;
  }

  // Warm bleed inside the heat haze, so the shimmer reads as hot air.
  if (heat > 0.001) col += vec3(1.0, 0.55, 0.2) * heat * u_heatTint;

  // Tan dust haze over the ground inside the rotor downwash.
  if (dust > 0.001) {
    vec3 dustCol = vec3(0.86, 0.74, 0.52);
    col = mix(col, col * dustCol + vec3(0.10, 0.08, 0.05), dust * 0.6);
  }

  // Time-of-day grade: ambient multiply, then add the sky tint (matches the
  // Canvas-2D "lighter" overlay so both backends grade identically).
  col = col * u_ambient + u_sky.rgb * u_sky.a;

  gl_FragColor = vec4(col, 1.0);
}`;
