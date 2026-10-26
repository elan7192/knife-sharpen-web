公開網址：尚未部署（Vercel 連線未取得團隊 test11-7356 的授權，需使用者核准後部署；見 STATE.md）

# 研刃 · 磨刀（three.js 原型）

和風低多邊形場景中的磨刀小遊戲。純靜態檔案（`index.html` + `main.js`），three.js 0.170 透過 CDN import map 載入，無需建置，支援 iPhone Safari（觸控）與桌面瀏覽器（滑鼠）。不載入任何外部模型、貼圖或 HDRI 檔案。

## 執行

ES module 需經由 HTTP 載入（不能直接以 `file://` 開啟）：

```bash
python3 -m http.server 8000
# 開啟 http://localhost:8000/
```

手機測試：電腦與手機連同一個網路，開啟 `http://<電腦 IP>:8000/`。

## 操作方式

| 動作 | 觸控（iPhone Safari） | 滑鼠 / 鍵盤 |
| --- | --- | --- |
| 磨刀（來回推拉） | 單指在畫面任意處左右拖曳；往右推＝刀尖那段上石、往左＝刃根那段 | 按住左鍵左右拖曳 |
| 調整刀刃角度 | 拖曳時手指上下移動（往上＝角度變大）、第二指上下滑動、或右側角度滑桿（52 px 寬，可與磨刀手指同時操作） | 拖曳時上下移動、滑鼠滾輪、↑ / ↓ 方向鍵、右側滑桿 |
| 壓力 | 由按住時間與推拉速度決定：推太慢＝太輕，推太快＝太重 | 同左 |
| 試刀 | 點「試刀」按鈕（高度 ≥ 48 px） | 同左 |

觸控細節：畫布與控制項皆 `touch-action: none` 並 `preventDefault`，不會捲動頁面、不會雙指縮放或雙擊放大（viewport `user-scalable=no`）；HUD 與按鈕避開瀏海與 Home 條（`env(safe-area-inset-*)`）；旋轉螢幕自動重新取景。

### 規則（不計時、沒有失敗懲罰）

- **角度容許帶 15°–20°**：在帶內角度數字與燈號為綠色（帶外 3° 內為黃、再外為紅），進入帶內有「叮」一聲提示。帶外仍會慢慢進步，只是很慢。
- **壓力曲線**：綠區 30%–80% 效率最高；太輕＝進度慢；太重＝起毛邊（火花變多、磨聲變粗、提示「太用力會起毛邊」），進度變慢，但不會讓刀變鈍。
- **刃口覆蓋**：刃口分成 10 段（HUD「刃口亮線」格子，左＝刀尖、右＝刃根，與畫面上的刀同向）。正在石上的那段有紅框；磨過的段會在刀上亮起一條**刃口亮線**，第一筆推拉就看得到變化。每段到 25 / 50 / 75 / 100% 時響一聲**刃鳴**（WebAudio 合成的金屬鐘聲，段數越高音越高）並閃光；整條刃口都升一級時再加一段和弦與提示「全刃 第 N 段」。
- **鋒利度**＝10 段的平均，所以要左右推到兩端，讓整條刃口都亮起來。
- 刀為 21 cm 牛刀（gyuto）：PBR 金屬（metalness 1），越鋒利刀身越光亮（roughness 0.38 → 0.12），反射來自程式產生的環境貼圖（`RoomEnvironment` + `PMREMGenerator`）。

### 試刀

依序挑戰：**紙（20%）→ 竹子（45%）→ 鐵（70%）→ 冰山（90%）**。進入試刀時畫面轉為「試刀高潮」色板（壓黑背景、冷色邊光、寬銀幕黑邊）；成功時慢動作下刀 → 刀光一閃＋**頓幀**（依目標硬度 50–125 ms，上限 120 ms，期間世界以 5% 速度微動）＋由大到小衰減的鏡頭震動 → 短暫停頓 → 目標分成兩半倒下（切面獨立顏色：竹＝淺綠、鐵＝熱光、冰＝亮藍）。未達標則刀被彈開，顯示結果與評價（鈍刀 / 入門 / 利刃 / 名刀 / 神品），可選「繼續磨」或「重來」。

## 網址參數

| 參數 | 作用 |
| --- | --- |
| `?time=day` / `?time=dusk` | 指定色板（預設依當地時間：17:00–06:00 為黃昏） |
| `?demo=0.8` | 除錯：以指定鋒利度直接開始試刀 |

## 效能與自動測試

- 像素比上限：桌面 `min(devicePixelRatio, 2)`、手機 1.5；陰影圖手機 1024（PCFShadowMap）、桌面 2048（PCFSoftShadowMap）；只有太陽投影，行灯點光源不投影。
- 場景以合併幾何（`mergeGeometries`）與 instancing 減少繪製呼叫；粒子為固定池（手機每組 ≤ 120），主迴圈不配置新物件；HUD 只在數值改變時寫 DOM；分頁隱藏時暫停繪製與音訊。
- 自動測試：`node tests/stability.iphone13.mjs`（Playwright 無頭 iPhone 13；three.js 首次以 curl 快取到 `tests/.cache/`；截圖與分享圖輸出到 `tests/artifacts/`）。
- 測試掛鉤：`window.__game`（getter：`sharpness`、`angle`、`pressure`、`phase`＝`sharpen`/`test`/`result`，另有 `segments`、`stage`、`band`）與 `window.__fps`（最近 60 幀實際幀率平均）。

## 模型與素材授權

**所有場景物件與牛刀皆為程式碼產生的幾何體**（`main.js` 內建）：木板桌、砥石台與磨刀石、水桶、行灯（附暖色點光源）、圓形試刀台與砧板、踏腳石、石堆與巨石、碎石地與苔蘚、竹林、試刀目標，以及牛刀（21 cm 刀身、弧形刀腹、尖刀尖、金屬枕〔bolster〕、三鉚釘西式刀柄）。場景為 flat shading 低多邊形，顏色取自 `/workspace/game-art/palettes.json`（白天／黃昏／試刀高潮），尺寸與面數依 `05-model-specs.md`（例：磨刀石 0.21 × 0.07 × 0.03 m）。

**本專案不含任何第三方模型檔。** 先前使用的 threejsassets.com GLB 因其授權禁止以可單獨取用的檔案形式再散布，已從公開版本移除（程式碼不再含 GLTFLoader / DRACOLoader 或任何模型載入路徑）。日後若要加入外部素材，依 `/workspace/game-art` 政策**只能使用 CC0**（不接受 CC-BY 等需標示或有限制的授權）。

## 研究建議採納

依 `/workspace/researchy/game-sharpening-research-2026-10-26.md`：

本輪已做：

- 角度容許帶（15°–20°，HUD 可讀、綠色回饋）
- 壓力曲線（太輕慢、中間最佳、太重起毛邊且變慢）
- 行程覆蓋：刃口分段，亮線逐段出現（3 秒內看得到進度）
- 刃鳴（DING）：每段每級完成音＋全刃升級和弦
- 試刀頓幀（上限 120 ms）＋由大到小衰減的震動
- 不計時、沒有失敗懲罰（偏離只會變慢，提示語氣溫和）
- 每個動作都有聲音＋畫面回應（觸石聲與水花、角度入帶提示音、帶外每度輕響、按鈕聲、火花／水滴／閃光粒子）

延後（現在不做）：

- 砥石粒度 粗→中→細（多層髒汙式的換石、換音色、換手感）
- 客人／委託（不同刀種與小故事）、工房升級與解鎖
- 試刀目標換成 番茄、巻藁（榻榻米捲）等階梯；切口平整度評分
- 試刀回放與 GIF 分享（截圖分享已於第 6 輪完成）
- ~~手機震動（強度與壓力連動）~~（第 6 輪完成，手把 rumble 留待 Unity）
- ~~研ぎ汁（泥漿）視覺~~（第 6 輪完成）、名人模式計分
- 10 分鐘 Demo 切片與試玩實驗（灰盒手感、DING A/B、頓幀 0/80/150 ms 調參）

## 變更紀錄

- 2026-10-26 | who: Executor via Claude Code (Opus 5.5) | reviewer: fresh Claude Code review run (Opus 5.5) | initial build | phone prototype
- 2026-10-26 | who: fresh Claude Code review run (Opus 5.5) | reviewer: 待使用者確認 | what: 審查修正＋美術＋授權：GLB 改為僅 `?localmodels=1` 載入（loader 動態 import）、預設全程式模型、來源標示只在本機模型時顯示、新增 `.vercelignore`；刀改為牛刀造形＋刃口亮線；套用白天／黃昏／試刀高潮色板（天空漸層、HUD 主題、慢動作、刀光、寬銀幕黑邊、切面顏色）；壓力綠區放寬為 30–80%、換向時壓力不驟降；竹每株降到 500 面以下並移除每幀配置 | why: 依審查需求修正 bug、遵循美術方向包與第三方模型授權
- 2026-10-26 | who: Executor via Claude Code (Opus 5.5) | reviewer: OpenAI Codex CLI 0.157.0 (gpt-6-luna) | what: 授權修正：完全移除 GLTFLoader／DRACOLoader／`?localmodels=1` 路徑（取代上一行的作法），原 GLB 移至未部署且不進 git 的 `_private/`；全場景與牛刀改為程式生成低多邊形（依 /workspace/game-art 色盤與規格，CC0-only）；手機觸控（禁捲動縮放、safe-area、≥48px 按鈕、自製角度滑桿）與效能（像素比上限 1.5/2、陰影 1024/2048、粒子池上限、無每幀配置、背景分頁暫停）；採納研究建議（角度帶 15–20°、壓力曲線與毛邊、刃口 10 段亮線、刃鳴、頓幀上限 120ms）；審查修正 iOS AudioContext.resume() 未捕捉的 rejection；部署至 Vercel | why: 第三方模型授權禁止單獨散布、iPhone Safari 可玩性、吸收 Researchy 研究、提供公開試玩網址
- 2026-10-26 | who: Executor via Claude Code (Opus 5.5) | reviewer: OpenAI Codex CLI (gpt-6-luna) | what: 第 3 輪：粗／中／細砥石（#220/#1000/#6000，各有磨速與鋒利度上限、觸控切換鈕）、粗砥火花與中細砥泥漿（固定容量粒子池）、各砥石磨耗凹陷、WebAudio 磨刀聲隨速度／壓力變化與解鎖鈴聲；試刀高潮：紙→卷藁→鐵→巨石→冰山單一解鎖表、預切兩半、0.15 倍慢動作、嚴格 2.39:1 黑邊、頓幀 ≤120ms 後衰減震動、失敗彈刀；審查修正：換砥中不可同時試刀、已解鎖但變鈍的目標標示「不足」、無障礙標籤「粗砥石 #220」、每次試刀重設頓幀紀錄、「最高評價」標示、巻藁改繁中卷藁 | why: 待辦 (2) 磨刀手感與 (3) 試刀高潮；依獨立審查修正狀態錯誤（5 項採納、5 項附理由駁回）
- 2026-10-26 | who: Executor via Claude Code (Opus 5.5)（審查修正由 OpenAI Codex CLI (gpt-5.6-terra) 代修，因 Claude 額度用完至 12:20） | reviewer: OpenAI Codex CLI (gpt-6-luna)（初審＋修正後重審） | what: 第 4 輪遊戲流程：標題畫面（開始／自由磨刀）→ 委託卡（客人、牛刀、指定試刀目標，難度隨完成件數上升）→ 磨刀（HUD 顯示委託）→ 試刀 → 結果（0–100 分、S/A/B/C、分項：鋒利度餘裕 40／角度 25／壓力 20／效率 15；失敗可「再磨一下」）→ 下一個委託／回標題；window.__knife.flow/startOrder/acceptOrder/startFree/title；審查修正：過場中不可切換畫面或重疊試刀、退場動畫中不可接委託、每件委託重設壓力／速度、完成件數只計一次、沒磨刀時角度／壓力／效率 0 分 | why: 待辦 (4) 遊戲流程；依獨立審查修正狀態機漏洞
- 2026-10-26 | who: Executor via Grok Bot | reviewer: OpenAI Codex CLI (gpt-6-luna)（對照 main.js 查核數值） | what: 新增 UNITY_PORT.md（網頁機制 → Unity C# 對照＋單一參數表＋評分表） | why: 之後移植到 KnifeProto
- 2026-10-26 | who: Executor via OpenAI Codex CLI (gpt-5.6-terra)（Claude 額度用完至 12:20，代為主寫） | reviewer: OpenAI Codex CLI (gpt-6-luna)（初審＋修正後重審，無新回歸） | what: 第 5 輪：低多邊形日式工房打磨（行灯暖光微閃、白天／黃昏光線分調、暖簾擺動、障子格窗、地板細節、竹林搖曳、光中浮塵 手機 12 點／桌面 48 點）；委託多樣化（更多客人與刀種文案：牛刀、三德刀、出刃、柳刃、菜切、中式菜刀，程式繪製客人頭像，高 DPR 清晰）；WebAudio 音效精修（依砥石變化的磨刀聲、按鈕聲、客人來店鈴、S/A/B/C 結果音、低音量環境聲） | why: 待辦 (5) 場景打磨與 (8) 委託／音效；無頭流程測試 2 件委託＋自由試刀冰山皆通過、無主控台錯誤、無捲動
- 2026-10-26 | who: Executor via OpenAI Codex CLI (gpt-5.6-terra)（Claude 額度用完至 12:20，代為主寫） | reviewer: OpenAI Codex CLI (gpt-6-luna) | what: 第 6 輪：結果卡「分享成績」（先渲染再擷取畫面＋疊加分數／評價／目標文字成 PNG，支援 navigator.share 分享檔案，否則下載；測試掛鉤 window.__knife.shareBlob()）；震動回饋（navigator.vibrate，不支援時如 iOS 靜默略過；磨刀時依壓力 8–25ms 短震、每 120ms 最多一次，刃鳴 30ms，試刀頓幀 [60,40,120]，彈刀 [40]；標題畫面「震動：開／關」並記在 localStorage）；中／細砥石研ぎ汁（泥漿）讓石面逐漸變深，換石與新委託時重置 | why: 研究延後清單的截圖分享、震動回饋、研ぎ汁視覺；審查 1 項 major（iOS 分享前等待 PNG 編碼可能失去使用者手勢、分享失敗時沒有改下載）已採納但未修：修正時 Codex 額度用完，列為下一輪第一件
- 2026-10-26 | who: claude-cloud-stability via Claude Code cloud (Claude Opus 5.5) | reviewer: 待指派（不同模型） | what: 第 7 輪穩定性：新增 stability.js（畫面轉移表、版本化 localStorage 存檔、分享交接）；main.js 局部接線：所有畫面切換經 goScreen() 檢查、frame／tween／試刀例外自動復原＋看門狗、WebGL context lost 暫停與還原；存檔進度／解鎖／設定（震動、新增音效開關）、自由模式刃口與砥石磨耗、未完成委託可接著磨，壞檔自動備份、無儲存空間仍可玩、兩段式清除紀錄；分頁隱藏／pagehide／freeze 暫停繪製、音效、震動並存檔，blur 放開手指，旋轉時重新取景；修 iOS 分享：結果卡出現時先建好 PNG，點擊內第一個非同步動作就是 navigator.share，tap 太快則同步 toDataURL 轉 Blob，非 AbortError 改顯示預覽＋下載；分享圖重新設計（1080×1350，寬銀幕畫面＋印章評價＋分項條）；橫向結果卡雙欄；tests/ Playwright 無頭 iPhone 13 流程測試 54 項 | why: 穩定性線任務與第 6 輪審查遺留的 iOS 分享 major
