"use strict";
/* レールランド 回帰テスト
 *
 * 実行方法:
 *   cd tests && npm run setup   # 初回のみ
 *   npm test
 *
 * 静的サーバーを内蔵しているので、別途サーバーを立てる必要はない。
 * 終了コード 0 = 全テスト成功。スクリーンショットを tests/screenshots/ に出力する。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SHOT_DIR = path.join(__dirname, "screenshots");
const PORT = 8644;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const rel = req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]);
      const f = path.join(ROOT, rel);
      if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
        res.end(data);
      });
    });
    srv.listen(PORT, "127.0.0.1", () => resolve(srv));
  });
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log("  ✅ " + name);
  else { failures++; console.log("  ❌ " + name + (detail ? "  → " + detail : "")); }
}

/* アプリ内座標(world) → 画面座標。クリック系テストで必ずこれを使うこと */
async function worldToScreen(page, wx, wy) {
  return page.evaluate(([x, y]) => {
    const r = cv.getBoundingClientRect();
    return { x: r.left + view.x + x * view.scale, y: r.top + view.y + y * view.scale };
  }, [wx, wy]);
}

/* 状態をまっさらにする（デモレイアウトも消す） */
async function resetState(page) {
  await page.evaluate(() => {
    localStorage.clear();
    pieces = []; trains = []; crashFx = []; nextId = 1;
    running = false; connDirty = true; setSelection(null);
  });
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const srv = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.waitForTimeout(500);

  console.log("[1] 起動とデモレイアウト");
  const init = await page.evaluate(() => ({ pieces: pieces.length, trains: trains.length }));
  check("初回起動でデモ(円形8本+電車1台)が出る", init.pieces === 8 && init.trains === 1, JSON.stringify(init));
  const thumbs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".palette-item canvas").forEach(c => {
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      out.push(n);
    });
    return out;
  });
  check("パレットのサムネイルが全て描画されている", thumbs.length >= 7 && thumbs.every(n => n > 300), JSON.stringify(thumbs));

  console.log("[2] スナップ接続（凸凹コネクター）");
  await resetState(page);
  const item = await page.locator(".palette-item").first().boundingBox();
  const dragFromPalette = async (x, y) => {
    await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  };
  await dragFromPalette(500, 400);
  await dragFromPalette(628, 408); // 1本目の凸端の近くに、わざとズラして配置
  const snap = await page.evaluate(() => {
    rebuildConnections();
    return { p: pieces.map(q => ({ x: q.x, y: q.y, rot: q.rot })), conns: connMap.size };
  });
  check("ズレて置いた直線が正確に吸着する",
    snap.p.length === 2 &&
    Math.abs(snap.p[1].x - snap.p[0].x - 110) < 0.5 &&
    Math.abs(snap.p[1].y - snap.p[0].y) < 0.5 &&
    Math.abs(snap.p[1].rot - snap.p[0].rot) < 0.01,
    JSON.stringify(snap.p));
  check("接続が両方向に登録される (connMap.size=2)", snap.conns === 2, "size=" + snap.conns);

  console.log("[3] 凹凸の極性（凸と凸は繋がらない）");
  const pol = await page.evaluate(() => {
    pieces = [
      { id: 1, type: "straight", x: 0, y: 0, rot: 0, sw: 0 },
      { id: 2, type: "straight", x: 220, y: 0, rot: Math.PI, sw: 0 }, // 凸端同士が (110,0) で正対
    ];
    connDirty = true; rebuildConnections();
    return connMap.size;
  });
  check("凸端同士は接続されない", pol === 0, "size=" + pol);

  console.log("[3.5] レールの回転（中心軸・見せかけの接続を作らない）");
  const rot = await page.evaluate(() => {
    // rotatePieceInPlace の核心性質: ピースの「見た目の中心」は
    // 回転してもワールド座標上で動かないこと（=その場でくるっと回る）。
    // 端点0を軸にすると中心が大きく移動し、それが「繋がっているのに
    // 実は繋がっていない」見せかけの接続を生む原因だった。
    const piece = { id: 1, type: "curveR", x: 130, y: 90, rot: 0.4, sw: 0 };
    const c = pieceLocalCenter(piece);
    const before = worldPos(piece, { x: c.x, y: c.y, a: 0 });
    rotatePieceInPlace(piece, Math.PI / 4);
    const after = worldPos(piece, { x: c.x, y: c.y, a: 0 });
    return {
      centerMoved: Math.hypot(after.x - before.x, after.y - before.y),
      rotChanged: Math.abs(normAng(piece.rot - 0.4 - Math.PI / 4)) < 1e-6,
    };
  });
  check("回転してもピースの中心はワールド座標で動かない（その場で回る）",
    rot.centerMoved < 1e-6 && rot.rotChanged, JSON.stringify(rot));

  const rotGap = await page.evaluate(() => {
    // カーブを混ぜた列で、再接続先が無い回転をした場合に
    // 「繋がって見えるのに実は繋がっていない」状態を作らないか確認
    pieces = [
      { id: 1, type: "curveR", x: 0, y: 0, rot: 0, sw: 0 },
    ];
    const w0 = worldEndpoint(pieces[0], 1);
    pieces.push({ id: 2, type: "curveR", x: w0.x, y: w0.y, rot: w0.out, sw: 0 });
    trains = []; connDirty = true; rebuildConnections();
    const mid = pieces[1];
    const before = getConn(mid.id, 0);
    rotatePieceInPlace(mid, Math.PI / 4); // 45度だけ回す→隣とはもう噛み合わない角度
    connDirty = true; rebuildConnections();
    const after = getConn(mid.id, 0);
    const a = worldEndpoint(pieces[0], 1), b = worldEndpoint(mid, 0);
    return {
      wasConnected: !!before,
      stillConnectedLogically: !!after,
      visualGap: Math.hypot(a.x - b.x, a.y - b.y),
    };
  });
  check("繋がらない回転をしたら見た目にもはっきり隙間ができる（見せかけの接続にならない）",
    rotGap.wasConnected && !rotGap.stillConnectedLogically && rotGap.visualGap > 10,
    JSON.stringify(rotGap));

  console.log("[4] 行き止まりで折り返す");
  const bounce = await page.evaluate(() => {
    pieces = [{ id: 1, type: "straight", x: 0, y: 0, rot: 0, sw: 0 }];
    connDirty = true;
    const t = { id: 9, color: "#f00", pieceId: 1, pathIdx: 0, s: 5, dir: 1, crashed: false };
    trains = [t];
    stepTrain(t, 200); // 5→110(残105) 折返し 残95 → s=15, dir=-1
    return { s: t.s, dir: t.dir };
  });
  check("孤立レール上で折り返す (s=15, dir=-1)",
    Math.abs(bounce.s - 15) < 0.01 && bounce.dir === -1, JSON.stringify(bounce));

  console.log("[5] 分岐レール");
  await page.evaluate(() => {
    pieces = [{ id: 1, type: "switchR", x: 450, y: 350, rot: 0, sw: 0 }];
    trains = []; connDirty = true;
  });
  const sPos = await worldToScreen(page, 450 + 55, 350);
  await page.mouse.click(sPos.x, sPos.y);
  await page.waitForTimeout(100);
  const sw = await page.evaluate(() => pieces[0].sw);
  check("クリックで進路が切り替わる (sw: 0→1)", sw === 1, "sw=" + sw);
  const route = await page.evaluate(() => {
    // 基端側に直線を繋いで通過させ、分岐側パスに入るか
    pieces.push({ id: 2, type: "straight", x: 340, y: 350, rot: 0, sw: 0 });
    connDirty = true;
    const t = { id: 9, color: "#f00", pieceId: 2, pathIdx: 0, s: 100, dir: 1, crashed: false };
    trains = [t];
    stepTrain(t, 40);
    return { pieceId: t.pieceId, pathIdx: t.pathIdx };
  });
  check("sw=1 のとき分岐側パスへ進入 (pathIdx=1)",
    route.pieceId === 1 && route.pathIdx === 1, JSON.stringify(route));

  console.log("[6] 走行と衝突");
  const crash = await page.evaluate(() => {
    // 8本カーブの円形に、逆向きの電車2台
    pieces = []; trains = []; nextId = 1;
    let prev = null;
    for (let i = 0; i < 8; i++) {
      const q = { id: nextId++, type: "curveR", x: 320, y: 200, rot: 0, sw: 0 };
      if (prev) { const w = worldEndpoint(prev, 1); q.rot = w.out; q.x = w.x; q.y = w.y; }
      pieces.push(q); prev = q;
    }
    connDirty = true;
    trains.push({ id: nextId++, color: "#ff595e", pieceId: pieces[0].id, pathIdx: 0, s: 10, dir: 1, crashed: false });
    trains.push({ id: nextId++, color: "#1982c4", pieceId: pieces[4].id, pathIdx: 0, s: 10, dir: -1, crashed: false });
    running = true;
  });
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => ({
    crashed: trains.map(t => t.crashed),
    loop: trains.every(t => pieces.some(p => p.id === t.pieceId)),
  }));
  check("周回走行できる（電車が線路上にいる）", after.loop);
  check("正面衝突で両方停止する", after.crashed.every(c => c), JSON.stringify(after.crashed));
  await page.screenshot({ path: path.join(SHOT_DIR, "crash.png") });

  console.log("[7] 保存と復元");
  await page.evaluate(() => { running = false; save(); });
  await page.reload();
  await page.waitForTimeout(500);
  const restored = await page.evaluate(() => ({ pieces: pieces.length, trains: trains.length }));
  check("リロード後にレイアウトが復元される", restored.pieces === 8 && restored.trains === 2, JSON.stringify(restored));
  await page.screenshot({ path: path.join(SHOT_DIR, "final.png") });

  console.log("[8] JavaScript エラー");
  check("実行中に JS エラーが出ていない", errors.length === 0, errors.join(" / "));

  await browser.close();
  srv.close();
  console.log(failures === 0 ? "\n🎉 ALL PASS" : `\n💥 ${failures} 件失敗`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(e => { console.error(e); process.exit(1); });
