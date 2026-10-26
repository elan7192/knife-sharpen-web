# UNITY_PORT — 網頁原型 → Unity（KnifeProto）對照

目標專案：`C:\Users\elan9\UnityProjects\KnifeProto`（Unity 6 LTS 6000.0.85f1，已用 EzySlice）。
來源：本 repo 的 `main.js`（three.js）。下方所有數值以 `main.js` 頂端常數為準；改數值時兩邊一起改。
單位：網頁 1 單位 = 1 公尺，Unity 同。時間：網頁的「遊戲時間」= Unity `Time.deltaTime`（受 `Time.timeScale` 影響），「真實時間」= `Time.unscaledDeltaTime`。

## 1. 機制對照

| 網頁機制（main.js） | Unity 對應（C#） | 移植重點 |
|---|---|---|
| 指標拖曳：x → 刀前後推、y → 角度；右側角度滑桿；第二指調角度 | `WhetstoneSharpener.cs`（輸入）＋新 Input System `Touchscreen`/`Pointer` | 推刀距離 = 螢幕寬 45% 對應整段行程；`ANGLE_PER_PX` 換算為每像素角度。滑桿用 uGUI `Slider`（直向）。 |
| `game.speed`、`game.pressure`（按住時間＋速度推算） | `WhetstoneSharpener.cs` | 用相同 damp 公式：`lerp(cur, target, 1-exp(-rate*dt))`；速度上升 rate 10、下降 2.5；壓力 rate 5（按住）/4（放開）。 |
| 角度效率 `angleEfficiency`、壓力曲線 `pressureEfficiency` | `KnifeSharpness.cs` | 直接照抄成 static 函式（見參數表）。沒有失敗狀態，最低效率不為 0。 |
| 刃口 10 段進度 `seg.progress[]`、各段等級 `SEG_LEVELS` → 刃鳴 | `KnifeSharpness.cs`（`float[] segments`） | 接觸點 u = 刀在砥石上的位置 0–1；每段權重三角窗 `SEG_WINDOW`；鋒利度 = 10 段平均。跨等級時播刃鳴（`AudioSource.PlayOneShot`）。刃口亮線用 Shader Graph 讀 10 段值（或 10 個子物件 emission）。 |
| 三顆砥石 粗/中/細（磨速 rate、上限 cap） | `WhetstoneSharpener.cs` ＋ `ScriptableObject StoneDef` | 每顆砥石一個 `StoneDef` 資產：grit、rate、cap、wear、顏色、粒子種類、聲音參數。接近上限時以 `ease` 放慢。 |
| 砥石磨耗：頂面 28×6 細分，高斯接觸區下凹，每 0.2 秒更新一次網格 | `StoneWear.cs`（新增） | `Mesh.SetVertices` 節流 0.2 s；刀的高度跟著下凹量 `stoneDishAt`。陣列預先配置，不在每幀 new。 |
| 火花（粗）／泥漿（中細）固定容量粒子池 | `ParticleSystem`（每種一個，`maxParticles` 手機較低）＋ `Emit()` | 速度×壓力決定發射率；換向時泥漿濺一下。粒子用 Additive 材質（火花）與 Alpha（泥漿）。 |
| WebAudio 磨刀聲：雜訊→帶通濾波，頻率/音量隨速度壓力，`setTargetAtTime` 平滑 | `GrindAudio.cs`（新增）：循環雜訊 `AudioSource` ＋ `AudioLowPassFilter`/`AudioHighPassFilter` | 每幀用 `Mathf.Lerp` 平滑 pitch/volume（等同 time constant 0.04–0.06 s）；三種砥石不同 f0/f1/q/hiss。解鎖時 `PlayOneShot(chime)`。 |
| 試刀目標表 TARGETS（紙→卷藁→鐵→巨石→冰山）與解鎖 | `TestCutController.cs` ＋ `ScriptableObject TargetDef` | 解鎖永久保留；目前鋒利度低於需求時標示「不足」。成功一刀會讓刀變鈍 `dull`。 |
| 預切兩半（建模時沿 30° 斜面切好兩半，平時隱藏） | **EzySlice** 執行時切（Unity 版保留）或預切 prefab | 網頁因效能與無 CSG 而預切；Unity 可繼續用 EzySlice，但手機目標建議也改成預切兩半 prefab（切面材質＝palette 切面色），切的瞬間 `SetActive` 交換，兩半加 `Rigidbody` 分開。 |
| 試刀過場狀態機 enter→windup→slash→freeze→(split｜recoil)→result | `TestCutController.cs`（Coroutine） | 每段用 `yield return` 對應網頁 tween；遊戲時間段用 `WaitForSeconds`，真實時間段用 `WaitForSecondsRealtime`。 |
| 慢動作 0.15 倍 | `SlowMotion.cs` | `Time.timeScale = 0.15f; Time.fixedDeltaTime = 0.02f * Time.timeScale;` 結束時用真實時間 0.15 s 漸回 1。 |
| 頓幀（hitstop）≤120 ms、之後鏡頭震動衰減 | `SlowMotion.cs`（`Hitstop(float s)`）＋ `CameraShake.cs` | `Time.timeScale = 0` 後 `WaitForSecondsRealtime(min(s, 0.12f))`；震動強度 = shake²，0.45 s 衰減到 0。 |
| 嚴格 2.39:1 黑邊（依實際視窗比例算上下或左右黑邊，0.6 s 滑入） | `Letterbox.cs`（新增）：調整 `Camera.rect` | `visible = 2.39`；若螢幕比 > 2.39 加左右黑邊，否則上下黑邊；直式手機也成立。過場水平 FOV 44°（換算成垂直 FOV 設給 Camera）。 |
| 失敗彈刀：刀反彈、目標完好、小火花＋繁中訊息 | `TestCutController.cs` | 頓幀 70 ms 後 recoil 0.75 s（遊戲時間）。 |
| 色盤 day/dusk/climax（/workspace/game-art/palettes.json） | URP Volume ＋ 材質顏色 ScriptableObject | 過場切換到 climax 色盤（背景 #0B0D12、邊光 #9FB7C9、強調 #D7263D）。 |
| 效能上限（像素比 1.5/2、陰影 1024/2048、粒子上限、背景分頁暫停） | URP Asset：Render Scale、Shadow Resolution；`Application.targetFrameRate` | 手機用較低 URP Asset。 |
| 除錯掛鉤 `window.__knife`（state/testCut/setSharpness/setAngle） | `DebugHooks.cs`（只在 Development Build） | 方便 PlayMode 測試。 |

## 2. 單一參數表

| 參數 | 值 | 說明 |
|---|---|---|
| 角度帶 `BAND_LO`–`BAND_HI` | 15°–20° | 帶內效率 1 |
| 角度範圍 / 起始角度 | 0°–30° / 26° | |
| 角度效率（帶外） | `max(0.06, 0.55·(1 − d/6))`，d = 離帶距離（度） | 沒有失敗狀態 |
| 角度靈敏度 `ANGLE_PER_PX` | 0.06°/px | 手指上下移動 |
| 手部飄移 | `(sin(1.3t)+sin(2.9t+1))·0.9°/s` | 玩家需修正 |
| 壓力綠區 `PRESS_LO`–`PRESS_HI` | 0.30–0.80 | |
| 壓力曲線 | p<0.3：`0.12+0.88·(p/0.3)^1.5`；0.3–0.8：1；p>0.8：`max(0.3, 1−((p−0.8)/0.2)·0.7)` | 太重起毛邊 burr（音色變粗、火花×3） |
| 壓力來源 | `0.25·hold + 0.7·speed`（hold 每秒 +2.5，上限 1） | |
| 刃口段數 `SEGS` / 等級 | 10 段 / 25%、50%、75%、100% | 跨等級播刃鳴 |
| 每次理想推過增益 `GAIN_PER_PASS` | 0.06 | × 角度效率 × 壓力效率 × 砥石 rate × `(1−0.55p)` × ease |
| 接近上限放慢 ease | `0.3 + 0.7·min(1, room/cap·3)` | |
| 粗砥 #220 | rate 2.2、cap 0.55、wear 1.0、火花 | 色 #5C5650 |
| 中砥 #1000 | rate 1.0、cap 0.85、wear 0.45、泥漿 | 色 #A8643C |
| 細砥 #6000 | rate 0.5、cap 1.00、wear 0.2、泥漿 | 色 #DCD3C3 |
| 磨耗 | 細分 28×6、最深 2.5 mm、每次推過 0.012、接觸寬 σ 0.02 m、網格更新 0.2 s | |
| 砥石尺寸 | 0.21 × 0.07 × 0.03 m（台高 0.035 m） | 05-model-specs |
| 解鎖門檻（=試刀需求） | 紙 0%、卷藁 30%、鐵 55%、巨石 75%、冰山 92% | |
| 各目標頓幀 | 紙 40、卷藁 60、鐵 90、巨石 110、冰山 120 ms | 上限 `HITSTOP_MAX` 120 ms |
| 成功一刀變鈍 `dull` | 紙 0、卷藁 1%、鐵 3%、巨石 4%、冰山 3% | |
| 失敗頓幀 / 彈刀 | 70 ms / 0.75 s 遊戲時間 | |
| 慢動作 `SLOWMO_SCALE` | 0.15 | 斬擊 0.14 s 遊戲時間 ≈ 0.9 s 真實 |
| 黑邊比例 / 滑入時間 | 2.39:1 / 0.6 s | 過場水平 FOV 44° |
| 預切面傾角 `CUT_TILT` | 30°（離垂直） | |
| 震動衰減 | 0.45 s，強度 shake² | |
| 粒子上限（手機/桌面） | 火花 120/220、泥漿 100/180、閃光 30/60 | |
| 像素比上限 / 陰影貼圖 | 手機 1.5、桌面 2 / 1024、2048 | |
| 評價（自由模式） | 鈍刀、入門、見習、利刃、名刀、神品（= 最高成功目標 +1） | 委託模式評分見第 3 節 |

## 3. 委託流程（第 4 輪）

標題 → 委託卡（客人、牛刀、指定目標）→ 磨刀 → 試刀 → 結果（分數 0–100、等級 S/A/B/C）→ 下一個委託／回標題。
Unity：`GameFlow.cs`（新增）用 enum 狀態 `Title, Order, Sharpen, Cut, Result` 與 uGUI 畫面切換；評分權重與等級門檻放在 `ScriptableObject ScoreDef`，數值同 `main.js` 的 `SCORE`／`RANK_TABLE`：

| 參數 | 值 | 說明 |
|---|---|---|
| 權重 鋒利度餘裕／角度／壓力／效率 | 40／25／20／15 | 總分 0–100 |
| 鋒利度餘裕 `marginFull` / `marginCeil` | 0.10 / 0.98 | 超過需求 10%（且不超過 98% 上限）得滿分 |
| 角度、壓力 | 磨刀距離中在 15°–20° 帶內、壓力綠區內的比例 | 沒磨（距離 0）時為 0 分 |
| 效率 par | `max(parMin 2, 從 orderStart 到目標的理想趟數 × parSlack 2)` | 在 par 內滿分；超過目標後繼續拋光不扣分 |
| 委託起始鋒利度 `orderStart` | 0.08（粗砥、角度 26°） | 砥石磨耗在委託之間保留 |
| 等級 | S ≥ 90、A ≥ 75、B ≥ 55、C ≥ 0；試刀失敗＝「失敗」（無分數，可「再磨一下」） | |
| 委託難度 | 第 n 件指定 TARGETS[min(n−1, 4)]（紙→卷藁→鐵→巨石→冰山，之後固定冰山） | 客人輪流 |

## 4. 移植順序建議

1. `KnifeSharpness.cs` 照抄角度／壓力曲線與 10 段進度（純邏輯，可寫 EditMode 測試對照網頁數值）。
2. `StoneDef` 三顆砥石＋換砥按鈕。
3. `SlowMotion.cs`（0.15、hitstop ≤120 ms）＋ `Letterbox.cs`（Camera.rect 2.39）。
4. `TestCutController.cs` 狀態機與 TargetDef 表；切開先用 EzySlice，手機效能不足再換預切 prefab。
5. 粒子、磨耗、聲音、委託流程。

## 變更紀錄
- 2026-10-26 | who: Executor via Grok Bot | reviewer: OpenAI Codex CLI (gpt-6-luna)（與第 4 輪一起對照 main.js 查核） | what: 新增 UNITY_PORT.md（機制對照＋單一參數表） | why: 使用者回到電腦後把網頁原型移植到 Unity KnifeProto
