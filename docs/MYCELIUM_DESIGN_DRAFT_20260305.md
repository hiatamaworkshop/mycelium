# Mycelium — 設計ドラフト 2026-03-05

## コンセプト

知識ノードが生物として振る舞う観察系システム。
engram と同じデータを食い、内部で生態系を形成し、到達点で結晶を engram に返す。
ペトリ皿。ユーザは push と観察だけ。

### 設計目標
- ノードを入れて、生態系が到達点を迎えるのを観察する
- 何が出てくるかは走らせてみないとわからない
- 活用（agent の使用パターン可視化等）は副産物であって目標ではない

---

## 学問的背景

| 領域 | Mycelium での対応 |
|------|------------------|
| Stigmergy | 道（pathMemory）。環境を介した間接通信 |
| Complex Adaptive Systems | 自律ノードの局所ルールから大域パターンが創発 |
| Artificial Life | ノードの代謝・性格・確率的行動選択 |
| Hebbian Learning | 共起で道が太くなる（fire together, wire together） |

---

## コア概念

### 1. ノード = エージェント

各ノードは metrics → feelings → personality × feelings → action の構造を持つ。
phi-agent の computeFeelings → modeWeights × feelings → chooseAction と同構造。

#### ノード構造体（Phase 0 から完全定義）

```typescript
interface MyceliumNode {
  id: string
  species: Species                // trigger から決定、immutable

  // contents — 最初から配列。Phase 0 では要素1つ
  contents: string[]              // immutable、追加のみ。テキストは一切変更しない
  contentWeights: number[]        // 各 content の影響度。初期は [1.0]

  // embedding — Qdrant 側
  vector: number[]                // contents[0] から生成。spawn 時に重心計算

  // metrics（生の状態量）
  h: number                      // heat: 0.0〜1.0。活性度
  w: number                      // weight: 蓄積量
  d: number                      // decay rate: 減衰速度。species config で初期値が違う
  resonance: number              // 共鳴受信量（毎 tick リセット）
  proximityHeat: number          // 近傍がヒットされた熱（プリロード）
  kinCount: number               // 近傍の同種族数
  pathCount: number              // 自分から伸びる道の本数

  // derived（tick ごとに再計算）
  entropy: number                // -Σ p log p。contents が1つなら常に 0
  ttl: number

  // personality — species config から焼き込み、immutable
  personality: WeightMatrix      // [4 actions × 4 feelings]

  // timestamps
  createdAt: number
  lastActiveAt: number
}
```

#### metrics（生の状態量）

```
// 三軸（Sphere 準拠）
h:  heat           // 0.0〜1.0。活性度。signal や feed で上昇、tick で冷却
w:  weight         // 蓄積量。連続値。hitCount 相当
d:  decay          // 減衰速度。personality で初期値が違う

// 社会系（mycelium 固有）
resonance:      number   // 現在の共鳴受信量（毎 tick リセット）
pathCount:      number   // 自分から伸びる道の本数（sense で更新）
proximityHeat:  number   // 近傍がヒットされた熱（プリロード）
kinCount:       number   // 近傍の同種族数

// derived
entropy:        number   // -Σ p log p。contentWeights から算出
```

#### computeFeelings() — metrics から心理への変換

```
computeFeelings(metrics):
  vigor    = f(h, proximityHeat)              // 活力。自分が熱く周囲も熱い
  dread    = f(d / max(w, 0.1), 1/ttl)        // 危機感。decay が重さに対して速い + 死が近い
  kinship  = f(kinCount, resonance)           // 帰属。同種族がいて共鳴も受けている
  hunger   = f(1 - w, 1 - pathCount/maxPath)  // 渇望。軽くて繋がりも少ない

  return [vigor, dread, kinship, hunger]
```

4心理 × 4行動 = 16パラメータの personality 行列。
心理と行動は1対1ではなく、組み合わせで挙動が変わる。
同じ hunger でも Summarizer は merge に走り、Sentinel は survive に走る。

```
行動との自然な対応:
  vigor   高い → signal（発信する余裕がある）
  dread   高い → bequeath / survive（必死）
  kinship 高い → merge（安心して合体できる）
  hunger  高い → signal（求める）/ merge（すがる）
```

#### assess() — phi-agent と同構造

```
assess():
  feelings = computeFeelings(metrics)
  actionScores = personality.weights × feelings   // 行列×ベクトル
  actionProbs = softmax(actionScores)
  action = probabilisticSelect(actionProbs)
```

```
personality: ingestion trigger が決める（種族）
```

#### 種族（personality）

| trigger | 種族名 | 気質 |
|---------|--------|------|
| session-end | Summarizer | 要約気質。merge に積極的 |
| error-resolved | Sentinel | 防衛気質。生存に執着、merge に消極的 |
| milestone | Herald | 社交気質。signal を出しやすい |
| manual | Anchor | 頑固。decay 耐性が高い |

#### 行動リスト

```
// 生存系
survive()       // decay に耐え次の tick へ
feed()          // recall ヒット時。weight += δ, hitCount++
starve()        // recall されない tick が続く

// 成長系
promote()       // 閾値超え → 永続化
split()         // hitCount 異常高 + 参照角度の分散大 → 分裂（将来）

// 社会系
menialMerge()   // 近傍のゴミノードと合体。TTL 合算
bequeath()      // 遺言マージ。死ぬ前に強いノードに引き継ぐ
signal()        // 共鳴シグナルを発する
repel()         // 近傍に近すぎる → 棲み分け（将来）
spawn()         // Phase 2-3 で導入。merge の変種。後述

// 死亡系
expire()        // ttl <= 0 && weight 低い → 自然死
decay()         // 毎 tick の weight 減少
```

#### spawn() — merge → 子ノード生成（Phase 2-3 実験用メモ）

merge の代替パタン。親は contents を差し出して子を生む。

```
node 構造:
  node {
    contents:       string[]       // immutable テキスト配列。追加のみ、変更なし
    contentWeights: number[]       // 各 content の影響度。これだけ変動する
    metrics:        Metrics
    feelings:       Feelings
    personality:    WeightMatrix   // 種族から引く。immutable
  }
```

```
spawn 時の挙動:
  node A: contents=[a], weights=[1.0]
  node B: contents=[b], weights=[1.0]

  → spawn()
  → child C: contents=[a, b], weights=[0.6, 0.4]  // 影響計算で重み付け
  → A, B は delete（通常 merge）または残存（有性生殖モード）
  → child は personality のみ親から継承（contents の意味は操作しない）
```

```
merge が進むと:
  contents = [a, b, c, d, e]
  weights  = [0.82, 0.1, 0.04, 0.03, 0.01]

  → テキスト自体は不変。支配的 content だけが少数存在
  → content entropy: H = -Σ p log p
     高 entropy = 混合ノード（雑食）
     低 entropy = 専門ノード（純血）
  → 結晶化条件に low entropy cluster を使える
```

設計原則: **意味操作を避ける**。LLM による meaning generation ではなく、
system による meaning ecology。テキストは immutable、数値だけが変化する。

### 2. 道（Path）= シナプス

道はノードの signal() 行動から生まれる共鳴の痕跡。観測者の co-occurrence ではない。

```
道の形成:
  tick → ノード A が signal() → 近傍の B が感知 → 道が形成
  → 観察者は関与しない。道はノードの自律行動から生まれる

道の強化:
  agent が recall で A を踏む → A.feed() → A の状態変化
  → A が signal() → 近傍との道が太くなる
  → 「踏まれた」は内部の状態変化に吸収される
```

```
pathMemory[hash(A, B)] = {
  summarizer: number,   // 種族ごとの共鳴カウント
  sentinel: number,
  herald: number,
  anchor: number,
  lastSeen: tick,       // decay 用
}
```

- 道はノードに立った後にのみ知覚できる（walk 概念）
- 使われない道は decay → 消滅
- 種族ごとに道の色への感度が違う（バイアス > 1.0 = 魅力、< 1.0 = 忌避）
- 観察者はテスト用に engram 同様のメソッドを持ち、戻り値を観察する


### 3. 代謝サイクル（tick）

```
tick():
  for each node:
    node.decay()                    // 老化
    heat = computeProximityHeat()   // 近傍ヒット状況
    node.updateMetrics(heat)        // プリロード
    action = node.assess()          // 確率的行動選択
    execute(action)                 // merge / signal / expire / survive

  pathMemory.decay()                // 道の減衰
  pathMemory.cleanup()              // 死んだ道の除去
```

### 4. 観測（Walk）

recall は一発検索ではなく歩行。

```
walk(query):
  1. cosine 検索で着地点を決める（道は関与しない）
  2. 着地ノードから pathMemory[hash(node, *)] を参照
  3. 道が見える → 道のメトリクスと種族バイアスを返す
  4. step(nextNodeId) で次へ進む → pathMemory 更新

step(nodeId):
  1. 移動 → 新しい着地点
  2. 前のノードとの共起を pathMemory に記録（道が太くなる）
  3. 新しい着地点から見える道を返す
```
→ 決定: 道は共鳴（signal）から形成。co-occurrence ではない。
→ 観察者の介入は push のみ。道・マージ・到達は全てノードの自律行動。

---

## 到達点 — Neuron Triangle（聖域化の転写）

システム全体を1つの神経モデルとし、Sphere の sanctify logic を転写する。
三者合意で到達点を迎えたとき、結晶を engram に back-push する。

### 三者の定義

```
        Hard (構造)
        /        \
       /    △     \
      /            \
Soft (安定性) ── Meta (有機性)
```

| Neuron | 問い | 観測対象 |
|--------|------|----------|
| **Hard** | ネットワークが形成されたか？ | 道の本数、孤立ノード率、接続グラフの連結性 |
| **Soft** | 構造が安定しているか？ | 道の churn（生成/消滅）の収束、急激な構造変化の不在 |
| **Meta** | この構造は有機的か？ | merge が assess() 由来か、種族多様性、特定種族の支配がないか |

### 判定

```
const hard = networkFormed(pathMemory, nodes);     // 道が十分に育った
const soft = structureStable(churnHistory);          // 構造変化が落ち着いた
const meta = organicGrowth(actionLog, speciesStats); // 自律的に形成された

if (hard && soft && meta) → CRYSTALLIZE
```

### Crystallization（結晶化）

```
三者合意
  → 現時点の生態系構造を結晶化
  → engram に back-push（mycelium-variant タグ付き）
  → neuron triangle リセット → festival → 次の epoch へ
  → epoch ごとに Hard のハードルが上がる（Sphere の ESCALATION と同構造）
```

### back-push の内容

結晶 = 道のグラフ構造そのもの。
- どのノードとどのノードが太い道で繋がっているか
- どの種族がその道を踏んだか
- engram にとっては「ノード間の関連性情報」として価値がある

### 変種タグ体系

```
mycelium-variant          // mycelium 由来であることを示す
mycelium-crystal          // crystallization（到達点）由来
mycelium-merge            // merge 由来（結晶化前の中間生成物）
```

---

## engram との接続

### 入力: engram → mycelium

```
agent → mycelium.push(seed) で直接投入。engram とは完全独立。
  seed = { summary, content, tags, trigger }
  → mycelium が独自に embedding 生成
  → metrics は全て初期値（engram の状態を引き継がない）
  → personality = trigger から決定

engram からのコピー/同期はしない。
同じ seed が engram と mycelium で別の人生を歩む。
agent の hook か CLAUDE.md で「push 時に両方に投げる」と設定。

### 栄養源

| 栄養源 | 効果 | 供給者 |
|--------|------|--------|
| **push（新ノード出現）** | 近傍ノードの proximityHeat 上昇 → h 加算 | agent（外部） |
| **共鳴（signal 受信）** | resonance 上昇 → h 微増 | 他ノード（内部） |
| **merge 成功** | 合体ノードの w 上昇 + TTL 合算 | 自分自身（内部） |
| **外部栄養注入（将来）** | 特定ノードの h, w を直接加算 | engram recall 同期 等 |

外部栄養は push が基本。内部栄養は共鳴と merge。
外部が断たれても内部で回せるが、永続はしない。
agent が使い続ける限り生態系は生きる。使わなくなれば静かに冷えて全滅する。

### 外部栄養注入ライン（将来）

操作して変化を観察するための介入経路。

```
// engram recall 同期: engram で recall ヒットしたノードと同じ seed を持つ
// mycelium ノードに栄養を付与する
mycelium_feed(nodeId)           // 特定ノードに直接 h, w を加算
mycelium_feed_by_query(query)   // cosine 検索でヒットしたノードに栄養

// engram の hook から自動発火（opt-in）
engram recall hit → mycelium_feed_by_query(same query)
  → engram で使われた知識が mycelium でも温まる
  → 生態系が agent の実際の使用パターンに応答する
```

これは観察系の原則（push と観察だけ）を意図的に破る操作。
ペトリ皿に栄養液を垂らして反応を見る実験に相当。
デフォルトは OFF。手動で有効化する。
```

### 出力: mycelium → engram（バックプッシュ）

```
到達点（三者合意 = CRYSTALLIZE）で:
  → 結晶を engram に back-push
  → タグに "mycelium-crystal" を付与
  → agent が recall 時に原種と結晶の両方を見られる
```

---

## 技術スタック（暫定）

```
ストレージ:   Qdrant（engram と同じ。別コレクション）
pathMemory:  SQLite or 軽量 KV（道の CRUD + decay）
tick 実行:    setInterval or cron（ローカル用なので軽量）
API:          MCP server（engram と同形式 → agent が同じ作法で使える）
言語:          TypeScript（engram と揃える）
```

---

## 観察 UI（最小）

デプロイなし、ローカル観察用。

```
status()     — ノード数、種族分布、道の本数、最近の merge/expire
snapshot()   — 全ノードの metrics + 道のグラフ（JSON dump）
history()    — 直近 N tick の行動ログ
```

可視化は後回し。まず JSON で眺める。

---

## 実装フェーズ（案）

### Phase 0: 骨格
- ノード構造体（metrics + personality）
- Qdrant コレクション作成
- push → ノード生成（personality 付与）

### Phase 1: 代謝
- tick ループ
- decay / expire / survive
- assess() の確率エンジン

### Phase 2: 社会行動
- signal() → 道の形成（共鳴ベース）
- menialMerge（近傍ゴミ合体、TTL 合算、content 連結）
- bequeath（遺言マージ）
- pathMemory（KV ストア）+ 道の decay

### Phase 3: 道の色・棲み分け
- 種族ごとの共鳴カウント → 道の色
- 種族バイアス（魅力/忌避）
- 棲み分けの観察

### Phase 4: Neuron Triangle + Crystallization
- Hard / Soft / Meta の実装（sanctification-neuron.ts を参照）
- 三者合意 → CRYSTALLIZE
- engram への back-push
- epoch エスカレーション

---

## 前提ドキュメント

- `reports/DATA_QUANTIZATION_AND_METRIC_DRIVEN_MERGE_20260305.md` — 量子化理論
- `reports/NODE_AS_AGENT_DISCUSSION_20260305.md` — 議論記録（道・プリロード・ノード生物化）
- `reports/SANCTIFICATION_NEURON_DESIGN.md` — Sphere の三者合意モデル（転写元）
- `periphery/src/sanctification/sanctification-neuron.ts` — 実装参照（Hard/Soft/Meta）
- `phi-agent/src/fast-gate.ts` — assess() の原型（computeFeelings, chooseAction）
- `gateway/src/digestor.ts` — 現行 engram の代謝ロジック
