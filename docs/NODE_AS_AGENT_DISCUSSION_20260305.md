# ノードのエージェント化 — 議論記録 2026-03-05

## 出発点

`DATA_QUANTIZATION_AND_METRIC_DRIVEN_MERGE_20260305.md` の議論から派生。
データ量子化・メトリクス駆動マージ・生物ノードの概念を深掘りし、
phi-agent の行動選択構造がノードに降りてくるところまで到達した。

---

## 1. 道 — 観測の履歴としての関係性

### 原則
関係性はノードの属性ではなく、観測の歴史である。
mcp-memory-service がエッジをノード側に埋め込んで失敗した教訓から、
道を **観測者の側に** 置く。

### 道の実体
```
pathMemory[hash(A,B)] = { coOccurrence: number, lastSeen: tick }
```
- 道はノードに何も書かない
- recall で共起したペアの履歴として観測者の pathMemory に蓄積
- 使われなければ decay → 消滅（代謝対象）

### 道は rerank ではない（場に潰れる問題）
recall の結果全体に道バイアスをかけると、場と同じ効果に退化する。

道が道であるための条件: **起点が必要**。
```
1. recall → cosine で着地（道は関与しない）
2. ノードに「立った」後、そこから伸びる道が見える
3. 道のメトリクスを感じ、次の一歩を選ぶ
```
recall は一発の検索ではなく **歩行（walk）** になる。

### 道の色（種族バイアス）
```
pathMemory[hash(A,B)] = { hot: 8, deep: 1 }
```
- 道は単なるスカラーではなくベクトル
- 通った種族が色を塗る（moth が踏めば hot 成分が太くなる）
- 種族によって同じ道の見え方が違う（hot: 1.5倍 vs deep: 0.7倍）
- 忌避（< 1.0）が生まれると棲み分けが自然発生する

---

## 2. プリロード — 近傍ヒットによるノード状態変化

### 概念
```
recall → ノード B がヒット → 近傍のノード A が「温まる」
→ A はまだ返されていないが、次に浮上しやすくなる
```

### 量子化での位置づけ
```
S × P → D

道:       P が変わる（観測者の射影が歪む）
プリロード: S が変わる（観測対象の状態が変わる）
```
道は観測者側の変化。プリロードはノード側の状態変化。

---

## 3. ノード = エージェント（phi-agent のノード化）

### 対応表
| phi-agent | knowledge node |
|-----------|---------------|
| feelings (hunger, curiosity...) | metrics (weight, ttl, hitCount, proximity heat) |
| modeWeights (種族固定) | personality (ノードの性格) |
| action (hot, deep, explore, return) | action (merge, signal, repel, hibernate, expire) |
| 環境刺激 (food nearby, field) | 環境刺激 (近傍ヒット, 共鳴) |

### 構造
```
phi-agent:
  feelings → computeFeelings() → modeWeights × feelings → action

knowledge node:
  metrics  → assess()          → personality × metrics  → action
```

### personality の由来 = 生まれ方（ingestion trigger）
```
session-end で生まれたノード   → 要約気質。merge に積極的
error-resolved で生まれたノード → 防衛気質。生存に執着、merge に消極的
milestone で生まれたノード      → 社交気質。signal を出しやすい
manual で生まれたノード         → 頑固。decay 耐性が高い
```

### 同じ刺激、異なる行動
近傍ノード B がヒット → ノード A の proximity heat 上昇:
```
A が error-resolved 生まれ:
  assess() → merge 確率: 低い、signal 確率: 高い
  → 自分は動かないが「ここにいるぞ」と叫ぶ

A が session-end 生まれ:
  assess() → merge 確率: 高い、signal 確率: 低い
  → 静かに合体に向かう
```

---

## 4. 到達の経路

```
Sphere original
  → ノードに代謝（weight, ttl, decay）
  → 免疫系（flag, expire）
  → だがノードの行動は Digestor が外から決めていた

phi-agent
  → feelings × modeWeights → action
  → 種族ごとの行動差異
  → 確率的自己決定（shouldReturn）

engram
  → 代謝モデルを知識ノードに適用
  → Digestor の promote / expire

この議論
  → 量子化: 観測者が関係性を決める
  → 道: 観測の履歴が次の観測を変える（walk 概念）
  → 道の色: 種族が踏んだ道は種族色に染まる
  → プリロード: 近傍ヒットがノードの状態を変える
  → ノード = エージェント: personality × metrics → action
  → personality = ingestion trigger（生まれが種族を決める）
```

---

## 関連ドキュメント

- `reports/DATA_QUANTIZATION_AND_METRIC_DRIVEN_MERGE_20260305.md` — 前提となる量子化・マージの議論
- `reports/MOVEMENT_LOGIC_REDESIGN_MEMO_20260223.md` — feelings × modeWeights の実装
- `phi-agent/src/fast-gate.ts` — chooseAction, computeFeelings, modeWeights
- `gateway/src/digestor.ts` — 現行の promote / expire ロジック
