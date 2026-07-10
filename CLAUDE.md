# レールランド (railsim) — 開発ガイド

子供向けのレール配線＆電車走行シミュレーター。ビルド不要の静的 Web アプリ
（`index.html` / `style.css` / `app.js` の3ファイル）で、GitHub Pages にそのまま公開できる。

## 絶対に守ること

1. **特定の市販レール玩具（商標）に言及しない・想起させない。**
   コード・コメント・commit メッセージ・UI 文言のどこにも商品名を書かない。
   見た目も既製品を連想させない配色（現在は「木製レール風」の茶系＋クリーム色）を維持する。
   青いプラスチックレール風の配色にしない。
2. **子供向け UI 文言はひらがな中心**（例:「うごかす」「ぶんき」「ぜんぶけす」）。絵文字を活用する。
3. **ビルド工程を導入しない。** vanilla JS のみ。ES modules も使わない
   （`file://` で直接開いても動くように、普通の `<script>` 読み込みを維持）。
4. コメント・ドキュメントは日本語で書く。

## 変更後の検証（必須）

```sh
node --check app.js                 # 構文チェック
cd tests && npm run setup           # 初回のみ（依存＋ヘッドレスブラウザ導入）
npm test                            # 回帰テスト（🎉 ALL PASS になること）
```

- テストは `tests/screenshots/` にスクリーンショットを出力する。
  **見た目に関わる変更をしたら必ずスクリーンショットを目視確認する**（Read ツールで画像を開ける）。
- 手動確認は `python3 -m http.server 8000` → `http://localhost:8000`。
- 挙動を追加したら `tests/smoke.js` にテストも追加する。
  テスト内でクリック座標を作るときは必ず `worldToScreen()` を使う（canvas はパン/ズームされる）。

## アーキテクチャ（app.js 1ファイル、上から順にセクション化）

### 座標系
- Canvas 標準の **y 軸下向き**。角度はラジアン、`sign=+1` のカーブは「画面下方向（右曲がり）」。
- ビュー変換は `view = {x, y, scale}`。画面↔ワールド変換は `screenToWorld()`。
- 定数: 直線 `STRAIGHT_LEN=110`、カーブ `CURVE_R=140` / 45°（カーブ8本で真円になる。円弧長 ≈ 110 で直線とほぼ同じ）。

### レール種類レジストリ（拡張ポイント）
- `RAIL_TYPES` に `registerRail(id, def)` で登録すると**パレットにも自動で並ぶ**。
- 定義 = `endpoints`（端点）+ `paths`（走行パス）:
  - endpoint: `{x, y, out, pol}` — `out` は**外向き**の角度。`pol` は `'M'`(凸) / `'F'`(凹)。
  - path: `{len, pos: s => {x,y,a}, a: 始端endpoint番号, b: 終端endpoint番号}`。s は 0〜len。
- 慣例: 各レールは始端が凹(F)・終端が凸(M)。分岐は基端 F + 出口2つが M で、
  paths[0]=直進 / paths[1]=分岐側。`isSwitch: true` を付ける。
- 追加手順の詳細は `.claude/skills/add-rail/SKILL.md` を参照。

### 配置ピースと接続
- ピース = `{id, type, x, y, rot, sw}`。ワールド座標変換は `worldEndpoint()` / `worldPos()`。
- **接続はデータとして持たず、位置から毎回導出する**（`rebuildConnections()`）。
  2つの端点が「距離3px以内・向きが正反対(±0.15rad)・凹凸が逆」なら接続とみなし `connMap` に両方向登録。
- ⚠️ **ピースの位置/回転/追加/削除をしたら必ず `connDirty = true` にする。**
  これを忘れると電車が古い接続情報で走る。
- スナップ: `findSnap()`（距離 SNAP_DIST=34px・角度 SNAP_ANG=0.5rad 以内の空き端点を探す）→
  `applySnap()`（回転＋平行移動で**厳密に**一致させる）。厳密に合わせないと上記の接続判定(3px)に入らない。
- ⚠️ **ピースの回転（`btnRotate`）は必ず `rotatePieceInPlace()`（ピース中心が軸）を使う。**
  端点0を軸に回すと、繋がっていたレールの位置に居座ったまま向きだけ変わり、
  「見た目は繋がっているのに実際は角度がズレて接続されていない」状態になる
  （過去に実機で報告されたバグ。S字に折れ曲がって見える）。中心軸なら、再接続できない場合は
  見た目にもはっきり隙間ができるので、子供にも「繋がっていない」ことが伝わる。

### 電車と走行
- 電車 = `{id, color, pieceId, pathIdx, s, dir(±1), crashed}`。線路上の1次元位置として表現。
- `stepTrain(t, dist)`: パス端に達したら `connMap` で次のピースへ乗り継ぐ。
  分岐の基端から入った場合のみ候補パスが2つあり、`piece.sw` で選ぶ。接続がなければ `dir` 反転（折り返し）。
- 2両目の位置は `trainPose(t, back)` が**逆向きに stepTrain して**求める。
- 衝突 = 車両中心円（半径 CAR_R=15）の重なり判定。`graceUntil` は復旧直後の再衝突を防ぐ猶予。
- ⚠️ ピースを削除したら、その上の電車も削除する（`deleteSelection()` 参照）。

### 入力・描画・保存
- 入力は Pointer Events の状態機械（`drag.mode`: pan / piece / newPiece / train / newTrain、2本指で pinch）。
  「クリック」= 移動6px未満の pointerup。分岐はクリックで `sw` トグル、他は選択。
- 描画は毎フレーム全再描画（`frame()`）。パスを `samplePath()` でポリライン化し、
  道床→まくらぎ→レール溝→コネクター→電車→エフェクトの順に描く。
- 状態変更をしたら `save()` を呼ぶ。localStorage キーは `"railland-save"`。
  `load()` は不明な type のピースを捨てる（後方互換のため、この防御は残すこと）。

## ファイル構成

```
index.html        UI 骨格（ヘッダー・パレット・canvas・アクションバー）
style.css         見た目（暖色系・丸ゴシック・丸ボタン）
app.js            全ロジック（このファイルだけ読めば全体が分かる）
tests/smoke.js    ヘッドレスブラウザ回帰テスト（静的サーバー内蔵）
.claude/skills/   プロジェクト専用スキル（verify, add-rail）
```
