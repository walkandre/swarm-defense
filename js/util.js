"use strict";

// Seeded RNG (mulberry32) so a map can be regenerated deterministically.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist2(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Simple spatial hash for circle-vs-circle broad phase.
class SpatialHash {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.buckets = new Map();
  }
  key(cx, cy) {
    return cx * 73856093 ^ cy * 19349663;
  }
  clear() {
    this.buckets.clear();
  }
  insert(obj) {
    const cx = Math.floor(obj.x / this.cellSize);
    const cy = Math.floor(obj.y / this.cellSize);
    const k = this.key(cx, cy);
    let b = this.buckets.get(k);
    if (!b) { b = []; this.buckets.set(k, b); }
    b.push(obj);
  }
  // Calls fn for each object in the 3x3 neighborhood of (x, y).
  queryNeighborhood(x, y, fn) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const b = this.buckets.get(this.key(cx + ox, cy + oy));
        if (b) for (let i = 0; i < b.length; i++) fn(b[i]);
      }
    }
  }
}
