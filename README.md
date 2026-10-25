# 研刃 · 磨刀（three.js 原型）

和風低多邊形場景中的磨刀小遊戲。純靜態檔案（`index.html` + `main.js`），three.js 0.170 透過 CDN import map 載入，無需建置，支援 iPhone Safari（觸控）與桌面瀏覽器（滑鼠）。

## 執行

ES module 與 GLB 需經由 HTTP 載入（不能直接以 `file://` 開啟）：

```bash
python3 -m http.server 8000
# 開啟 http://localhost:8000/
```

手機測試：電腦與手機連同一個網路，開啟 `http://<電腦 IP>:8000/`。

## 操作方式

| 動作 | 觸控 | 滑鼠 / 鍵盤 |
| --- | --- | --- |
| 磨刀（來回推拉） | 單指在畫面上左右拖曳 | 按住左鍵左右拖曳 |
| 調整刀刃角度 | 拖曳時手指上下移動（往上＝角度變大）、第二指上下滑動、或右側角度滑桿 | 拖曳時上下移動、滑鼠滾輪、↑ / ↓ 方向鍵、右側滑桿 |
| 壓力 | 由拖曳速度與按住時間決定：推太慢＝太輕，推太快＝太重 | 同左 |
| 試刀 | 點「試刀」按鈕 | 同左 |

### 規則

- 目標角度 **15° ± 3°**：角度燈為綠色表示正確（黃色＝接近，紅色＝偏差大）。
- 壓力條需停在**綠色區間**。
- 只有「角度正確 + 壓力在綠區 + 持續推拉」時，**鋒利度**才會上升；角度嚴重偏差或壓力過重會讓刃口變鈍。
- 磨刀時手會自然微微飄移，需隨時修正角度。
- 刀身材質為 PBR 金屬（metalness 1），越鋒利表面越光亮（roughness 下降）。

### 試刀

依序挑戰：**紙（20%）→ 竹子（45%）→ 鐵（70%）→ 冰山（90%）**。鋒利度達標則目標一刀兩斷並分成兩半倒下；未達標則刀被彈開，結束試刀並顯示結果與評價（鈍刀 / 入門 / 利刃 / 名刀 / 神品）。結果畫面可選「繼續磨」（保留鋒利度）或「重來」（歸零）。冰山僅為舞台演出用的小型道具。

## 模型

`./models/` 中的 GLB（Draco 壓縮，解碼器由 unpkg CDN 載入）以 `GLTFLoader` 載入，並以 `Box3` 自動縮放、置於地面並開啟陰影：

- `plank-table.glb`：主桌（磨刀石所在）
- `round-table.glb`：試刀台
- `oil-lantern.glb`：桌上油燈（附暖色點光源）
- `stepping-stones.glb`、`flagstone-path-tile-01.glb`、`rock-cluster.glb`、`sandstone-boulder.glb`：庭園裝飾

每個模型個別 try/catch（含逾時），載入失敗時改用簡單幾何體代替，遊戲不受影響。

模型來源 threejsassets.com（免費商用授權）

## 變更紀錄

- 2026-10-26 | who: Executor via Claude Code (Opus 5.5) | reviewer: TBD | what: 建立磨刀原型（index.html、main.js、README.md）：和風場景、磨刀玩法、繁中 HUD、試刀演出、粒子、WebAudio 音效、GLB 模型載入與後備幾何體 | why: 依需求建立可在 iPhone Safari 遊玩的 three.js 磨刀原型
