"use strict";
/* =========================================================
 * レールランド — 子供向けレール配線＆走行シミュレーター
 *
 * レール形状は RAIL_TYPES レジストリに登録する。
 * 新しいレールを追加するときは registerRail() を呼ぶだけ。
 * =======================================================*/

/* ---------- 基本ジオメトリ ---------- */
const STRAIGHT_LEN = 110;          // 直線レールの長さ
const CURVE_R = 140;               // カーブ半径
const CURVE_TH = Math.PI / 4;      // カーブ角度 45°
const SNAP_DIST = 34;              // 吸着距離
const SNAP_ANG = 0.5;              // 吸着許容角度(rad)
const BED_W = 30;                  // 道床(木)の幅
const RAIL_OFF = 7;                // レール溝のオフセット

const TAU = Math.PI * 2;
function normAng(a) { a = a % TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; }

/* パス: s(0..len) → {x, y, a}（ローカル座標） */
function straightPath(len) {
  return { len, pos: s => ({ x: s, y: 0, a: 0 }) };
}
function arcPath(r, th, sign) {  // sign +1: 下方向(右)カーブ / -1: 上方向(左)
  return {
    len: r * th,
    pos: s => {
      const a = s / r;
      return { x: r * Math.sin(a), y: sign * r * (1 - Math.cos(a)), a: sign * a };
    }
  };
}

/* ---------- レール種類レジストリ ---------- */
/* endpoint: { x, y, out(外向き角度), pol: 'M'(凸) | 'F'(凹) }
 * path: { len, pos, a: 始端endpoint番号, b: 終端endpoint番号 } */
const RAIL_TYPES = {};
const PALETTE_ORDER = [];

function registerRail(id, def) {
  RAIL_TYPES[id] = def;
  PALETTE_ORDER.push(id);
}

function makeStraightType(label, len) {
  const p = straightPath(len);
  return {
    label,
    endpoints: [
      { x: 0, y: 0, out: Math.PI, pol: "F" },
      { x: len, y: 0, out: 0, pol: "M" },
    ],
    paths: [{ ...p, a: 0, b: 1 }],
  };
}
function makeCurveType(label, sign) {
  const p = arcPath(CURVE_R, CURVE_TH, sign);
  const end = p.pos(p.len);
  return {
    label,
    endpoints: [
      { x: 0, y: 0, out: Math.PI, pol: "F" },
      { x: end.x, y: end.y, out: end.a, pol: "M" },
    ],
    paths: [{ ...p, a: 0, b: 1 }],
  };
}
function makeSwitchType(label, sign) {
  const ps = straightPath(STRAIGHT_LEN);
  const pc = arcPath(CURVE_R, CURVE_TH, sign);
  const ce = pc.pos(pc.len);
  return {
    label,
    isSwitch: true,
    endpoints: [
      { x: 0, y: 0, out: Math.PI, pol: "F" },
      { x: STRAIGHT_LEN, y: 0, out: 0, pol: "M" },
      { x: ce.x, y: ce.y, out: ce.a, pol: "M" },
    ],
    paths: [
      { ...ps, a: 0, b: 1 },   // path 0: 直進
      { ...pc, a: 0, b: 2 },   // path 1: 分岐
    ],
  };
}

registerRail("straight", makeStraightType("まっすぐ", STRAIGHT_LEN));
registerRail("half", makeStraightType("みじかい", STRAIGHT_LEN / 2));
registerRail("curveL", makeCurveType("カーブ ↰", -1));
registerRail("curveR", makeCurveType("カーブ ↱", +1));
registerRail("switchL", makeSwitchType("ぶんき ↰", -1));
registerRail("switchR", makeSwitchType("ぶんき ↱", +1));

/* ---------- 電車 ---------- */
const TRAIN_COLORS = ["#ff595e", "#1982c4", "#8ac926", "#ffca3a", "#9d4edd"];
const CAR_LEN = 38, CAR_W = 22, CAR_GAP = 36, CAR_R = 15;

/* ---------- 状態 ---------- */
let pieces = [];        // { id, type, x, y, rot, sw }
let trains = [];        // { id, color, pieceId, pathIdx, s, dir, crashed }
let nextId = 1;
let running = false;
let baseSpeed = 90;
let selection = null;   // { kind: 'piece'|'train', id }
let connMap = new Map();
let connDirty = true;
let colorCursor = 0;
let crashFx = [];       // { x, y, t }
let graceUntil = 0;

const view = { x: 0, y: 0, scale: 1 };

/* ---------- ユーティリティ ---------- */
const pieceById = id => pieces.find(p => p.id === id);
const trainById = id => trains.find(t => t.id === id);

function worldEndpoint(piece, i) {
  const ep = RAIL_TYPES[piece.type].endpoints[i];
  const c = Math.cos(piece.rot), s = Math.sin(piece.rot);
  return {
    x: piece.x + ep.x * c - ep.y * s,
    y: piece.y + ep.x * s + ep.y * c,
    out: normAng(ep.out + piece.rot),
    pol: ep.pol,
  };
}
function worldPos(piece, lp) {
  const c = Math.cos(piece.rot), s = Math.sin(piece.rot);
  return {
    x: piece.x + lp.x * c - lp.y * s,
    y: piece.y + lp.x * s + lp.y * c,
    a: lp.a + piece.rot,
  };
}

/* ---------- 接続管理 ---------- */
const connKey = (id, ep) => id + ":" + ep;

function rebuildConnections() {
  connMap = new Map();
  const all = [];
  for (const p of pieces) {
    const n = RAIL_TYPES[p.type].endpoints.length;
    for (let i = 0; i < n; i++) all.push({ piece: p, i, w: worldEndpoint(p, i) });
  }
  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const A = all[a], B = all[b];
      if (A.piece === B.piece) continue;
      if (A.w.pol === B.w.pol) continue;
      const dx = A.w.x - B.w.x, dy = A.w.y - B.w.y;
      if (dx * dx + dy * dy > 9) continue;
      if (Math.abs(normAng(A.w.out - B.w.out - Math.PI)) > 0.15) continue;
      connMap.set(connKey(A.piece.id, A.i), { pieceId: B.piece.id, ep: B.i });
      connMap.set(connKey(B.piece.id, B.i), { pieceId: A.piece.id, ep: A.i });
    }
  }
  connDirty = false;
}
function getConn(pieceId, ep) {
  if (connDirty) rebuildConnections();
  return connMap.get(connKey(pieceId, ep));
}

/* ドラッグ中のピースを他ピースの空き端点へ吸着させる候補を探す */
function findSnap(piece) {
  if (connDirty) rebuildConnections();
  let best = null;
  const nMy = RAIL_TYPES[piece.type].endpoints.length;
  for (let i = 0; i < nMy; i++) {
    const my = worldEndpoint(piece, i);
    for (const other of pieces) {
      if (other === piece) continue;
      const nO = RAIL_TYPES[other.type].endpoints.length;
      for (let j = 0; j < nO; j++) {
        if (getConn(other.id, j)) continue;   // 使用済み端点
        const w = worldEndpoint(other, j);
        if (w.pol === my.pol) continue;       // 凹凸が合わない
        const dx = w.x - my.x, dy = w.y - my.y;
        const d = Math.hypot(dx, dy);
        if (d > SNAP_DIST) continue;
        const ad = Math.abs(normAng(my.out - (w.out + Math.PI)));
        if (ad > SNAP_ANG) continue;
        const score = d + ad * 25;
        if (!best || score < best.score) best = { score, myEp: i, target: w, targetPiece: other };
      }
    }
  }
  return best;
}
function applySnap(piece, snap) {
  const my0 = worldEndpoint(piece, snap.myEp);
  piece.rot = normAng(piece.rot + normAng(snap.target.out + Math.PI - my0.out));
  const my1 = worldEndpoint(piece, snap.myEp);
  piece.x += snap.target.x - my1.x;
  piece.y += snap.target.y - my1.y;
}

/* ---------- 電車の走行 ---------- */
function pathsOf(piece) { return RAIL_TYPES[piece.type].paths; }

function stepTrain(t, dist) {
  let guard = 0;
  while (dist > 1e-6 && guard++ < 20) {
    const piece = pieceById(t.pieceId);
    if (!piece) return;
    const path = pathsOf(piece)[t.pathIdx];
    const rem = t.dir > 0 ? path.len - t.s : t.s;
    if (dist <= rem) { t.s += t.dir * dist; return; }
    dist -= rem;
    t.s = t.dir > 0 ? path.len : 0;
    const epIdx = t.dir > 0 ? path.b : path.a;
    const conn = getConn(piece.id, epIdx);
    if (!conn) { t.dir *= -1; continue; }    // 行き止まり: 折り返し
    const np = pieceById(conn.pieceId);
    if (!np) return;
    const npaths = pathsOf(np);
    const cand = [];
    for (let i = 0; i < npaths.length; i++)
      if (npaths[i].a === conn.ep || npaths[i].b === conn.ep) cand.push(i);
    const pi = cand.length > 1 ? cand[np.sw ? 1 : 0] : cand[0];
    const npath = npaths[pi];
    if (npath.a === conn.ep) { t.s = 0; t.dir = 1; }
    else { t.s = npath.len; t.dir = -1; }
    t.pieceId = np.id;
    t.pathIdx = pi;
  }
}

function trainPose(t, back = 0) {
  let st = t;
  if (back > 0) {
    st = { pieceId: t.pieceId, pathIdx: t.pathIdx, s: t.s, dir: -t.dir };
    stepTrain(st, back);
    st.dir = -st.dir;
  }
  const piece = pieceById(st.pieceId);
  if (!piece) return null;
  const p = worldPos(piece, pathsOf(piece)[st.pathIdx].pos(st.s));
  if (st.dir < 0) p.a += Math.PI;
  return p;
}

function carCenters(t) {
  const out = [];
  const p0 = trainPose(t, 0);
  const p1 = trainPose(t, CAR_GAP);
  if (p0) out.push(p0);
  if (p1) out.push(p1);
  return out;
}

function checkCollisions(now) {
  if (now < graceUntil) return;
  for (let i = 0; i < trains.length; i++) {
    for (let j = i + 1; j < trains.length; j++) {
      const A = trains[i], B = trains[j];
      if (A.crashed && B.crashed) continue;
      const ca = carCenters(A), cb = carCenters(B);
      for (const a of ca) for (const b of cb) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < CAR_R * 2 - 2) {
          A.crashed = B.crashed = true;
          crashFx.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t: now });
          playCrash();
        }
      }
    }
  }
}

/* ---------- サウンド ---------- */
let audioCtx = null;
function getAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  return audioCtx;
}
function playClick() {
  const ac = getAudio(); if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = "square"; o.frequency.value = 2200;
  g.gain.setValueAtTime(0.12, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.06);
  o.connect(g).connect(ac.destination);
  o.start(); o.stop(ac.currentTime + 0.07);
}
function playCrash() {
  const ac = getAudio(); if (!ac) return;
  const len = 0.35, buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = ac.createBufferSource(), g = ac.createGain();
  src.buffer = buf;
  g.gain.value = 0.25;
  src.connect(g).connect(ac.destination);
  src.start();
}

/* ---------- キャンバス・ビュー ---------- */
const cv = document.getElementById("cv");
const ctx = cv.getContext("2d");
let dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cv.width = r.width * dpr;
  cv.height = r.height * dpr;
}
window.addEventListener("resize", resize);

function screenToWorld(sx, sy) {
  const r = cv.getBoundingClientRect();
  return { x: (sx - r.left - view.x) / view.scale, y: (sy - r.top - view.y) / view.scale };
}

/* ---------- 描画 ---------- */
function samplePath(piece, path, step = 10) {
  const pts = [];
  const n = Math.max(2, Math.ceil(path.len / step) + 1);
  for (let i = 0; i < n; i++) {
    pts.push(worldPos(piece, path.pos(path.len * i / (n - 1))));
  }
  return pts;
}

function strokePolyline(pts, offset) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = p.x - Math.sin(p.a) * offset;
    const y = p.y + Math.cos(p.a) * offset;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawPiece(piece, ghostSnap) {
  const type = RAIL_TYPES[piece.type];
  const selected = selection && selection.kind === "piece" && selection.id === piece.id;
  const pathSamples = type.paths.map(p => samplePath(piece, p));

  // 道床（木の板）
  for (let i = 0; i < pathSamples.length; i++) {
    const inactive = type.isSwitch && i !== (piece.sw ? 1 : 0);
    ctx.lineCap = "round";
    ctx.lineWidth = BED_W;
    ctx.strokeStyle = selected ? "#ffd27a" : (inactive ? "#e5cba0" : "#e2b877");
    strokePolyline(pathSamples[i], 0);
  }
  // まくらぎ
  ctx.strokeStyle = "#c49658";
  ctx.lineWidth = 4;
  ctx.lineCap = "butt";
  for (const pts of pathSamples) {
    for (let i = 1; i < pts.length; i += 2) {
      const p = pts[i];
      const nx = -Math.sin(p.a), ny = Math.cos(p.a);
      ctx.beginPath();
      ctx.moveTo(p.x - nx * 11, p.y - ny * 11);
      ctx.lineTo(p.x + nx * 11, p.y + ny * 11);
      ctx.stroke();
    }
  }
  // レール溝
  ctx.lineCap = "round";
  for (let i = 0; i < pathSamples.length; i++) {
    const inactive = type.isSwitch && i !== (piece.sw ? 1 : 0);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = inactive ? "#b39770" : "#7a5230";
    strokePolyline(pathSamples[i], -RAIL_OFF);
    strokePolyline(pathSamples[i], RAIL_OFF);
  }
  // 分岐の矢印（進行方向）
  if (type.isSwitch) {
    const path = type.paths[piece.sw ? 1 : 0];
    const p = worldPos(piece, path.pos(Math.min(46, path.len * 0.45)));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.a);
    ctx.fillStyle = "#2e9e44";
    ctx.beginPath();
    ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // 端点コネクター（凸 / 凹）
  for (let i = 0; i < type.endpoints.length; i++) {
    const w = worldEndpoint(piece, i);
    const connected = !!getConn(piece.id, i);
    if (connected) continue;
    if (w.pol === "M") {
      ctx.fillStyle = "#d9a55e";
      ctx.beginPath();
      ctx.arc(w.x + Math.cos(w.out) * 6, w.y + Math.sin(w.out) * 6, 5, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "#a97a3a"; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.fillStyle = "#a97a3a";
      ctx.beginPath();
      ctx.arc(w.x - Math.cos(w.out) * 4, w.y - Math.sin(w.out) * 4, 5, 0, TAU);
      ctx.fill();
    }
  }
  // スナップ先ハイライト
  if (ghostSnap) {
    ctx.strokeStyle = "#2e9e44";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(ghostSnap.target.x, ghostSnap.target.y, 14, 0, TAU);
    ctx.stroke();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCar(pose, color, isEngine, shake) {
  ctx.save();
  ctx.translate(pose.x + (shake ? (Math.random() - .5) * 3 : 0),
                pose.y + (shake ? (Math.random() - .5) * 3 : 0));
  ctx.rotate(pose.a);
  const L2 = (isEngine ? CAR_LEN : CAR_LEN - 8) / 2;
  ctx.fillStyle = "rgba(0,0,0,.15)";
  roundRect(-L2 + 2, -CAR_W / 2 + 2, L2 * 2, CAR_W, 8);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(-L2, -CAR_W / 2, L2 * 2, CAR_W, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.25)";
  ctx.lineWidth = 2;
  roundRect(-L2, -CAR_W / 2, L2 * 2, CAR_W, 8);
  ctx.stroke();
  if (isEngine) {
    // 先頭（明るい鼻先）と運転席の窓
    ctx.fillStyle = "rgba(255,255,255,.85)";
    roundRect(L2 - 10, -CAR_W / 2 + 3, 7, CAR_W - 6, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.5)";
    roundRect(-L2 + 5, -CAR_W / 2 + 4, 10, CAR_W - 8, 3);
    ctx.fill();
  } else {
    ctx.fillStyle = "rgba(255,255,255,.5)";
    for (const dx of [-9, 1]) {
      roundRect(dx, -CAR_W / 2 + 4, 7, CAR_W - 8, 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawTrain(t, now) {
  const selected = selection && selection.kind === "train" && selection.id === t.id;
  const shake = t.crashed && crashFx.some(f => now - f.t < 600);
  const p1 = trainPose(t, CAR_GAP);
  const p0 = trainPose(t, 0);
  if (p1) drawCar(p1, t.color, false, shake);
  if (p0) {
    if (selected) {
      ctx.save();
      ctx.shadowColor = "#ffb400";
      ctx.shadowBlur = 18;
      drawCar(p0, t.color, true, shake);
      ctx.restore();
    } else {
      drawCar(p0, t.color, true, shake);
    }
  }
}

function drawBackground() {
  const w = cv.width / dpr, h = cv.height / dpr;
  ctx.fillStyle = "#fdf3e0";
  ctx.fillRect(0, 0, w, h);
  // 水玉模様
  const gap = 46 * view.scale;
  const ox = ((view.x % gap) + gap) % gap;
  const oy = ((view.y % gap) + gap) % gap;
  ctx.fillStyle = "rgba(214, 178, 120, .25)";
  for (let x = ox; x < w + gap; x += gap) {
    for (let y = oy; y < h + gap; y += gap) {
      ctx.beginPath();
      ctx.arc(x, y, 3 * view.scale, 0, TAU);
      ctx.fill();
    }
  }
}

function draw(now) {
  drawBackground();
  ctx.save();
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
  if (connDirty) rebuildConnections();
  const draggingPiece = drag && drag.mode === "piece" ? pieceById(drag.id) : null;
  for (const p of pieces) {
    drawPiece(p, p === draggingPiece ? drag.snap : null);
  }
  for (const t of trains) drawTrain(t, now);
  // 衝突エフェクト
  crashFx = crashFx.filter(f => now - f.t < 1400);
  for (const f of crashFx) {
    const k = (now - f.t) / 1400;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.font = `${34 + k * 26}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("💥", f.x, f.y - k * 18);
    ctx.restore();
  }
  // ドラッグ中の電車（線路の外）
  if (drag && drag.mode === "newTrain") {
    drawCar({ x: drag.wx, y: drag.wy, a: 0 }, drag.color, true, false);
  }
  ctx.restore();
}

/* ---------- メインループ ---------- */
let lastT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0);
  lastT = now;
  if (running) {
    if (connDirty) rebuildConnections();
    for (const t of trains) {
      if (!t.crashed) stepTrain(t, baseSpeed * dt);
    }
    checkCollisions(now);
  }
  draw(now);
  requestAnimationFrame(frame);
}

/* ---------- 入力（ドラッグ・タップ・パン・ズーム） ---------- */
let drag = null;
const activePointers = new Map();
let pinch = null;

function pieceHit(wx, wy) {
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    for (const path of pathsOf(p)) {
      const pts = samplePath(p, path, 14);
      for (const q of pts) {
        if (Math.hypot(q.x - wx, q.y - wy) < BED_W / 2 + 4) return p;
      }
    }
  }
  return null;
}
function trainHit(wx, wy) {
  for (let i = trains.length - 1; i >= 0; i--) {
    for (const c of carCenters(trains[i])) {
      if (Math.hypot(c.x - wx, c.y - wy) < CAR_R + 6) return trains[i];
    }
  }
  return null;
}
function nearestTrackPoint(wx, wy, maxDist = 34) {
  let best = null;
  for (const p of pieces) {
    const paths = pathsOf(p);
    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi];
      const n = Math.max(4, Math.ceil(path.len / 8));
      for (let i = 0; i <= n; i++) {
        const s = path.len * i / n;
        const q = worldPos(p, path.pos(s));
        const d = Math.hypot(q.x - wx, q.y - wy);
        if (d < maxDist && (!best || d < best.d)) {
          best = { d, pieceId: p.id, pathIdx: pi, s };
        }
      }
    }
  }
  return best;
}

function setSelection(sel) {
  selection = sel;
  const bar = document.getElementById("actionbar");
  const btnRev = document.getElementById("btnReverse");
  const btnRot = document.getElementById("btnRotate");
  if (!sel) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  btnRev.style.display = sel.kind === "train" ? "" : "none";
  btnRot.style.display = sel.kind === "piece" ? "" : "none";
}

cv.addEventListener("pointerdown", e => {
  cv.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    // ピンチ開始（進行中のドラッグはキャンセルしてパン/ズームへ）
    const pts = [...activePointers.values()];
    pinch = {
      d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2,
      scale: view.scale, vx: view.x, vy: view.y,
    };
    drag = null;
    return;
  }
  const w = screenToWorld(e.clientX, e.clientY);
  const train = trainHit(w.x, w.y);
  if (train) {
    drag = { mode: "train", id: train.id, moved: false, sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y };
    return;
  }
  const piece = pieceHit(w.x, w.y);
  if (piece) {
    // 最前面へ
    pieces.splice(pieces.indexOf(piece), 1);
    pieces.push(piece);
    drag = {
      mode: "piece", id: piece.id, moved: false,
      sx: e.clientX, sy: e.clientY,
      ox: w.x - piece.x, oy: w.y - piece.y, snap: null,
    };
    return;
  }
  drag = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
});

window.addEventListener("pointermove", e => {
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  if (pinch && activePointers.size === 2) {
    const pts = [...activePointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
    const k = Math.min(3, Math.max(0.35, pinch.scale * (d / pinch.d)));
    const r = cv.getBoundingClientRect();
    const wx = (pinch.cx - r.left - pinch.vx) / pinch.scale;
    const wy = (pinch.cy - r.top - pinch.vy) / pinch.scale;
    view.scale = k;
    view.x = cx - r.left - wx * k;
    view.y = cy - r.top - wy * k;
    return;
  }
  if (!drag) return;
  const moved = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6;
  if (moved) drag.moved = true;
  const w = screenToWorld(e.clientX, e.clientY);
  if (drag.mode === "pan") {
    view.x = drag.vx + (e.clientX - drag.sx);
    view.y = drag.vy + (e.clientY - drag.sy);
  } else if (drag.mode === "piece" && drag.moved) {
    const piece = pieceById(drag.id);
    if (!piece) return;
    piece.x = w.x - drag.ox;
    piece.y = w.y - drag.oy;
    connDirty = true;
    drag.snap = findSnap(piece);
  } else if (drag.mode === "train" && drag.moved) {
    drag.wx = w.x; drag.wy = w.y;
    const t = trainById(drag.id);
    const near = nearestTrackPoint(w.x, w.y);
    if (t && near) {
      t.pieceId = near.pieceId; t.pathIdx = near.pathIdx; t.s = near.s;
      t.crashed = false;
    }
  } else if (drag.mode === "newTrain") {
    drag.wx = w.x; drag.wy = w.y;
  } else if (drag.mode === "newPiece") {
    const piece = pieceById(drag.id);
    if (!piece) return;
    piece.x = w.x - drag.ox;
    piece.y = w.y - drag.oy;
    connDirty = true;
    drag.snap = findSnap(piece);
    drag.mode = "piece";  // 以降は通常のピースドラッグと同じ
    drag.moved = true;
  }
});

window.addEventListener("pointerup", e => {
  activePointers.delete(e.pointerId);
  if (pinch) { if (activePointers.size < 2) pinch = null; return; }
  if (!drag) return;
  const d = drag; drag = null;

  if (d.mode === "pan") {
    if (!d.moved) setSelection(null);
    return;
  }
  if (d.mode === "piece" || d.mode === "newPiece") {
    const piece = pieceById(d.id);
    if (!piece) return;
    if (d.moved || d.mode === "newPiece") {
      const snap = findSnap(piece);
      if (snap) { applySnap(piece, snap); playClick(); }
      connDirty = true;
      save();
    } else {
      // タップ: 選択（分岐なら切り替えも）
      if (RAIL_TYPES[piece.type].isSwitch) { piece.sw = piece.sw ? 0 : 1; playClick(); save(); }
      setSelection({ kind: "piece", id: piece.id });
    }
    return;
  }
  if (d.mode === "train") {
    if (!d.moved) {
      setSelection({ kind: "train", id: d.id });
    } else {
      const t = trainById(d.id);
      const near = t && nearestTrackPoint(d.wx, d.wy, 60);
      if (!near) {
        // 線路の外に落とした → 削除
        trains = trains.filter(x => x.id !== d.id);
        if (selection && selection.kind === "train" && selection.id === d.id) setSelection(null);
      }
      save();
    }
    return;
  }
  if (d.mode === "newTrain") {
    const near = nearestTrackPoint(d.wx, d.wy, 50);
    if (near) {
      trains.push({
        id: nextId++, color: d.color,
        pieceId: near.pieceId, pathIdx: near.pathIdx, s: near.s,
        dir: 1, crashed: false,
      });
      playClick();
      save();
    }
    return;
  }
});

cv.addEventListener("wheel", e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const k = Math.min(3, Math.max(0.35, view.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
  const wx = (e.clientX - r.left - view.x) / view.scale;
  const wy = (e.clientY - r.top - view.y) / view.scale;
  view.scale = k;
  view.x = e.clientX - r.left - wx * k;
  view.y = e.clientY - r.top - wy * k;
}, { passive: false });

/* ---------- パレット ---------- */
function drawTypeThumb(canvas, typeId) {
  const type = RAIL_TYPES[typeId];
  const c = canvas.getContext("2d");
  const scale = 0.58;
  c.save();
  c.scale(scale, scale);
  // バウンディングを概算して中央寄せ
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const path of type.paths) {
    for (let i = 0; i <= 16; i++) {
      const p = path.pos(path.len * i / 16);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  const ox = (canvas.width / scale - (maxX - minX)) / 2 - minX;
  const oy = (canvas.height / scale - (maxY - minY)) / 2 - minY;
  c.translate(ox, oy);
  for (const path of type.paths) {
    const pts = [];
    for (let i = 0; i <= 20; i++) pts.push(path.pos(path.len * i / 20));
    c.lineCap = "round";
    c.lineWidth = BED_W;
    c.strokeStyle = "#e2b877";
    c.beginPath();
    pts.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
    c.stroke();
    for (const off of [-RAIL_OFF, RAIL_OFF]) {
      c.lineWidth = 3.5;
      c.strokeStyle = "#7a5230";
      c.beginPath();
      pts.forEach((p, i) => {
        const x = p.x - Math.sin(p.a) * off, y = p.y + Math.cos(p.a) * off;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.stroke();
    }
  }
  c.restore();
}

function drawTrainThumb(canvas) {
  const c = canvas.getContext("2d");
  c.save();
  c.translate(canvas.width / 2, canvas.height / 2);
  const w = 60, h = 26;
  c.fillStyle = TRAIN_COLORS[0];
  c.beginPath();
  c.roundRect(-w / 2, -h / 2, w, h, 9);
  c.fill();
  c.fillStyle = "rgba(255,255,255,.85)";
  c.beginPath(); c.roundRect(w / 2 - 12, -h / 2 + 4, 8, h - 8, 3); c.fill();
  c.fillStyle = "rgba(255,255,255,.5)";
  c.beginPath(); c.roundRect(-w / 2 + 6, -h / 2 + 5, 12, h - 10, 3); c.fill();
  c.restore();
}

function buildPalette() {
  const box = document.getElementById("paletteItems");
  for (const id of PALETTE_ORDER) {
    const item = document.createElement("div");
    item.className = "palette-item";
    const th = document.createElement("canvas");
    th.width = 120; th.height = 66;
    th.style.width = "120px"; th.style.height = "66px";
    drawTypeThumb(th, id);
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = RAIL_TYPES[id].label;
    item.append(th, label);
    item.addEventListener("pointerdown", e => {
      e.preventDefault();
      const w = screenToWorld(e.clientX, e.clientY);
      const piece = { id: nextId++, type: id, x: w.x, y: w.y, rot: 0, sw: 0 };
      pieces.push(piece);
      connDirty = true;
      drag = { mode: "newPiece", id: piece.id, sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, snap: null, moved: true };
    });
    box.appendChild(item);
  }
  // 電車
  const item = document.createElement("div");
  item.className = "palette-item";
  const th = document.createElement("canvas");
  th.width = 120; th.height = 50;
  th.style.width = "120px"; th.style.height = "50px";
  drawTrainThumb(th);
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = "でんしゃ";
  item.append(th, label);
  item.addEventListener("pointerdown", e => {
    e.preventDefault();
    const w = screenToWorld(e.clientX, e.clientY);
    drag = {
      mode: "newTrain", color: TRAIN_COLORS[colorCursor++ % TRAIN_COLORS.length],
      sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y, moved: true,
    };
  });
  box.appendChild(item);
}

/* ---------- ツールバー ---------- */
const btnPlay = document.getElementById("btnPlay");
btnPlay.addEventListener("click", () => {
  running = !running;
  btnPlay.textContent = running ? "⏸ とめる" : "▶️ うごかす";
  btnPlay.classList.toggle("playing", running);
});
document.getElementById("speed").addEventListener("input", e => {
  baseSpeed = +e.target.value;
});
document.getElementById("btnRescue").addEventListener("click", () => {
  for (const t of trains) {
    if (t.crashed) { t.crashed = false; t.dir *= -1; }
  }
  graceUntil = performance.now() + 1200;
});
document.getElementById("btnClear").addEventListener("click", () => {
  if (!confirm("レールと でんしゃを ぜんぶ けしますか？")) return;
  pieces = []; trains = []; crashFx = [];
  setSelection(null);
  connDirty = true;
  save();
});
document.getElementById("btnRotate").addEventListener("click", () => {
  if (!selection || selection.kind !== "piece") return;
  const p = pieceById(selection.id);
  if (!p) return;
  p.rot = normAng(p.rot + Math.PI / 4);
  connDirty = true;
  const snap = findSnap(p);
  if (snap) { applySnap(p, snap); playClick(); connDirty = true; }
  save();
});
document.getElementById("btnReverse").addEventListener("click", () => {
  if (!selection || selection.kind !== "train") return;
  const t = trainById(selection.id);
  if (t) { t.dir *= -1; save(); }
});
document.getElementById("btnDelete").addEventListener("click", deleteSelection);

function deleteSelection() {
  if (!selection) return;
  if (selection.kind === "piece") {
    const id = selection.id;
    pieces = pieces.filter(p => p.id !== id);
    trains = trains.filter(t => t.pieceId !== id);
    connDirty = true;
  } else {
    trains = trains.filter(t => t.id !== selection.id);
  }
  setSelection(null);
  save();
}

window.addEventListener("keydown", e => {
  if (e.key === "Delete" || e.key === "Backspace") { deleteSelection(); }
  if (e.key === "r" || e.key === "R") document.getElementById("btnRotate").click();
  if (e.key === " ") { e.preventDefault(); btnPlay.click(); }
});

/* ---------- 保存・復元 ---------- */
function save() {
  try {
    localStorage.setItem("railland-save", JSON.stringify({ pieces, trains, nextId, colorCursor }));
  } catch (e) {}
}
function load() {
  try {
    const raw = localStorage.getItem("railland-save");
    if (!raw) return false;
    const d = JSON.parse(raw);
    pieces = (d.pieces || []).filter(p => RAIL_TYPES[p.type]);
    trains = (d.trains || []).filter(t => pieces.some(p => p.id === t.pieceId));
    for (const t of trains) t.crashed = false;
    nextId = d.nextId || 1;
    colorCursor = d.colorCursor || 0;
    connDirty = true;
    return pieces.length > 0;
  } catch (e) { return false; }
}

/* 初回起動時のデモレイアウト: 8本のカーブで輪っか＋電車1台 */
function demoLayout() {
  let prev = null;
  for (let i = 0; i < 8; i++) {
    const p = { id: nextId++, type: "curveR", x: 260, y: 160, rot: 0, sw: 0 };
    pieces.push(p);
    if (prev) {
      connDirty = true;
      const w = worldEndpoint(prev, 1);
      p.rot = w.out;
      p.x = w.x; p.y = w.y;
    }
    prev = p;
  }
  connDirty = true;
  trains.push({
    id: nextId++, color: TRAIN_COLORS[colorCursor++ % TRAIN_COLORS.length],
    pieceId: pieces[0].id, pathIdx: 0, s: 10, dir: 1, crashed: false,
  });
}

/* ---------- 起動 ---------- */
buildPalette();
resize();
if (!load()) demoLayout();
requestAnimationFrame(frame);
