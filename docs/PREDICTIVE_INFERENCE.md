# Predictive Inference — Agent Emotion System + Mycelium 先読み推論

> Date: 2026-03-14
> Status: 構想段階
> 依存: engram, mycelium_universal, Sphere (neuron triangle), phi-agent (feelings)

## 概要

Agent の行動ストリームを暗黙的にモニタリングし、
感情システムレイヤで多次元の感情ベクトルを構成する。
発火シグナルは多重的・段階的に発生し、接続先（mycelium 先読み、engram push 推奨、
環境モニタリング等）は感情システムとは分離された別レイヤで処理する。
検索でも推薦でもない第三の情報提示方法。

## 全体アーキテクチャ

```
┌─────────────── 入力層 ───────────────┐
│  grep カウンタ → パスパタン整理       │
│  ワードマッチ (完成/すまない/...)     │
│  tool call パタン, engram hit/miss   │
├─────────────── 時間層 ───────────────┤
│  短期: spike 検知 (直近 N events)     │
│  中期: 時間ウィンドウ内の積分         │
│  メタ: 起動時間, やりとり回数, 文字数  │
├─────────── 感情システム ─────────────┤
│  ニューロントライアングル              │
│  → 感情ベクトル構成                   │
│  → 多重・段階的な発火判定             │
│  → learnedDelta による自己校正        │
├─────────────── 接続先 ───────────────┤
│  ├── mycelium 先読み推論              │
│  ├── engram push 推奨                │
│  ├── 環境モニタリング警告             │
│  ├── ストレス警告                    │
│  └── (将来: 何でも接続可能)           │
└──────────────────────────────────────┘
```

## 2段構成

### Stage 1: 暗黙蓄積フィルタ（既存パーツで構築可能）

```
hook 発火（全 tool call）
    → 簡易1次フィルタ（ノイズ除去）
    → embedding 化 → agent 世界 DB に蓄積
    → 一定量蓄積 → mycelium batch → クラスタ分析 → pushback
```

- hook は積極的に発火させる。選別は mycelium の仕事
- engram push の自動化版。手動 push の漏れを解消
- Claude 側に負荷なし。MCP server で完結

### Stage 2: 先読み推論（receptor 駆動）

```
receptor が「詰まり」を検出 → トリガー
    → 蓄積済みデータで第一世界を構築（agent の知識地図）
    → 現在の悩みリストをノードとして投入
    → 数十 ticks のシミュレーション × consensus N 回
    → 反応パターンを分類:
        merged   = agent が既に知っている知識と同質。冗長
        resonant = 関連はあるが新しい切り口。注目に値する
        loner    = agent の関心圏外。今は不要
    → レポートを非同期で返送
    → agent が悩んだ瞬間、推論候補が既に手元にある
```

## 感情システムレイヤ

感情システムは **検知と発火だけに責任を持つ** 独立レイヤ。
接続先を知らない。発火するだけ。何に繋ぐかは別レイヤの問題。
mycelium のノードが signal を出す設計と同じ原則。

### 入力源

| 入力 | 取得方法 | 時間軸 | 感情への寄与 |
|------|----------|--------|-------------|
| grep カウンタ + パスパタン整理 | hook (grep/glob) | 短期+中期 | frustration, uncertainty |
| ワードマッチ (完成/すまない/...) | hook (response) | 短期 | satisfaction, frustration |
| 同一ファイル反復アクセス | hook (read) | 短期 | frustration (迷い) |
| ビルドエラー連続 | hook (bash exit code) | 短期 | frustration (行き詰まり) |
| 検索対象の散乱/集中 | hook (grep/glob) | 短期 | uncertainty / confidence |
| Edit の取り消し/やり直し | hook (edit) | 短期 | frustration |
| engram pull 空振り | engram MCP | 短期 | hunger (知識ギャップ) ← 最強 spike 源 |
| engram pull query embedding 軌跡 | engram MCP | 中期 | 方向性の安定/散乱 |
| subagent 起動頻度 | hook (agent) | 短期 | isolation (自力で解けない) |
| 応答長の変化 | MCP response | 中期 | uncertainty |
| 起動時間 | system | メタ | fatigue |
| やりとり回数 | system | メタ | complexity |
| 総文字数 | system | メタ | cognitive load |

### 3時間軸処理

```
短期: 直近 N events の spike 検知
      → 瞬間的な状態変化を捉える
      → 高速減衰

中期: 時間ウィンドウ内の積分
      → セッション内の傾向を形成
      → 緩やかな減衰

メタ: 別角度からの環境モニタリング
      → 内容を見ずに状態がわかる（時間、量、頻度）
      → 内容非依存の疲労・複雑性指標
```

### 感情ベクトル構成

入力を3時間軸で処理し、多次元の感情ベクトルを構成する。
**単一スカラー（危機度）ではなく、ベクトル全体がタスクキューを生成する。**

```
感情ベクトル (多次元)
    ├── frustration: 0.7  → 関連知識の先読み (確率: 高)
    ├── uncertainty: 0.5  → 類似事例の検索 (確率: 中)
    ├── satisfaction: 0.2  → 成果の整理・保存 (確率: 低)
    ├── isolation: 0.6    → cross-project 橋渡し (確率: 中高)
    ├── hunger: 0.8       → 知識ギャップ補填 (確率: 最高)
    │
    ▼
タスクキュー (確率順、量子的グラデーション)
    1. hunger spike     → mycelium: 未知領域の知識を filter
    2. frustration spike → mycelium: エラー周辺の知識を filter
    3. isolation 上昇    → mycelium: cross-project データ投入
    ...
```

各感情成分がそれぞれ異なるバックグラウンドタスクにマッピングされる。
高いものから順に処理されるが、低いものも完全には切り捨てない。
spike の種類が「何を filter するか」を決定する。

### Neuron Triangle（Sphere 由来）

3軸バランスモデルで感情ベクトルを統合・可視化する。

- 3軸の定義は Sphere プロジェクト由来
- バランスの崩れ = 通常状態からの逸脱
- 各軸: 短期スパイク / 中期傾向 / メタ状態

```
危機度判定の例（性格層 × 状況層の組み合わせ）:

slow「粘る性格」+ fast「エラー連続」
  → 危機度: 中。本人のリズム内。先読みは準備だけ

slow「切り替え型」+ fast「エラー連続」
  → 危機度: 高。方向転換が近い。先読み結果を提示

slow「設計先行型」+ fast「長い沈黙」
  → 危機度: 低。考えている。邪魔しない
```

### learnedDelta — 自己校正ループ

エージェント自身が感情システムの推定を閲覧し、フィードバックを返す。

```
感情システムの推定状態
    ↕ 比較
エージェント自身が認識する状態
    ↓
差分 = learnedDelta
    ↓
sensitivity 調整 → 次の推定精度が上がる
```

- エージェントは自身の感情ベクトルを閲覧可能
- エージェント自身が認識する状態をシステムに投影し改善
- learnedDelta は engram に蓄積（`感情補正` タグ or MCP tool）
- 開発者ごと、エージェントごとに sensitivity が育つ
  - 同じ grep 10 回でも: ある開発者は「通常の作業スタイル」、別の開発者は「迷い」
- learnedDelta 自体が slow receptor (性格層) のデータになる
- mycelium の perception matrix 学習補正と同構造

```
例:
  感情システム推定: frustration 0.7
  エージェント申告: 「これは探索的な試行」
  → learnedDelta: frustration_sensitivity -= 0.1
  → 学習: 「反復 grep パタンは必ずしも frustration ではない」
  → 次回同パタン → 補正済み sensitivity で判定
```

### 発火と接続先の分離

**感情システムの責任範囲:**
- 入力の収集と処理
- 3時間軸での統合
- 感情ベクトルの構成
- 多重・段階的な発火判定
- learnedDelta による自己校正

**感情システムの責任範囲外（接続先レイヤ）:**

| 発火シグナル | 接続先の例 |
|-------------|-----------|
| frustration / hunger spike | mycelium 先読み推論起動 |
| satisfaction + milestone 検知 | engram push 推奨 |
| fatigue (メタ: 長時間稼働) | ストレス警告 |
| cognitive load (メタ: 文字数過大) | メモリファイル肥大警告、compact 推奨 |
| 複合的な高スパイク | 環境モニタリングアドバイス |

接続先は段階的に増やせる。感情システム自体は小さく堅く保つ。

## Receptor 実装

### MCP サイドカーとしての実装

Claude 側に負荷をかけず、MCP server で行動ストリームを監視する。

```
Claude → tool call → hook 発火 → receptor MCP server (engram 内)
                                    ├── 行動ログ蓄積
                                    ├── 感情ベクトル算出
                                    └── 発火シグナル → 接続先へ
```

### engram サイドカーの双方向翻訳

agent ↔ mycelium 世界の間に立ち、双方向の翻訳を行う。

```
agent の行動
    ↓
engram サイドカー
    ├── 行動ログ → mycelium 世界のメトリクスに還元（世界を育てる）
    ├── クエリ検出 → probe として世界に投入（世界に問う）
    └── 結果を agent に返送（世界が答える）
```

agent はサイドカーの存在を意識しない。
普通に engram を使っているだけで、裏でサイドカーが世界を育て、問い、答えを用意する。

### 成熟世界のメトリクス効果

フィードバックループで w/h/d が育った世界は、クエリへの反応品質が自然に上がる:

- 頻繁に参照された知識（高 w）→ signal が強い → resonance しやすい
- 放置された知識（低 w）→ 弱い反応 → loner になりやすい
- クラスタの核（高 h、多数 merge 済み）→ 吸引力が強い → クエリを引き込む

フラットスタートでは全ノードが均等に反応して差が出ない。
メトリクスが分化した世界では「本当に関連するものだけが強く反応する」。

## LLM との関係

**補完であって競合ではない。**

- LLM が苦手なのは「自分が何を知らないか」
- コンテキストにない知識は推論しようがない
- mycelium の先読みが効くのは「agent のコンテキストに今ない、
  でも過去の蓄積に関連する何かがある」を浮上させること
- LLM の推論力に **材料を先に並べておく** 仕組み

## メトリクスフィードバックループとの統合

```
mycelium filter → digest → engram/DB → agent access → eval
    → source Qdrant payload に書き戻し (myceliumHits, myceliumWeight)
    → 次回 mycelium run で初期 w/h/d に反映
```

- GAP-1（初期メトリクス均一性）の根本解決
- 旧 engram の computeNutrition() と同構造だが N agents × M sources に拡張
- 汎用ローダーの真価: 入口だけでなく出口（メトリクス push）も汎用

## クラウド集合知（将来）

- N 開発者 × M agent のインタラクションパターンを種族データとしてブレンド
- ある性格傾向の開発者がある状況で詰まった時、
  別の開発者-agent ペアで有効だった解法が浮上する
- 開発者-agent ペア = ノード、インタラクションパターン = species、
  クラウド上の集合 = 生態系
- これは mycelium そのもの、メタスケールで

## engram watch モード

receptor の実装基盤。engram MCP server に watch 機能を追加する。

### ツール

```
engram_watch(mode: "on" | "off")  — トグル + 設定
engram_probe(text)                — 保存済み世界に問いを投入、反応を返す
```

### watch ON 時の動作

```
engram_watch(on)
    ├── FIFO buffer 開始
    │     ├── agent クエリ → embedding → buffer 蓄積
    │     ├── hooks 経由の行動ログ → buffer 蓄積
    │     └── 3軸モニタリング (短期spike/中期傾向/メタ状態)
    │
    ├── 閾値超過 → background mycelium 起動
    │     ├── buffer データで世界構築 (batch 40 ticks)
    │     ├── consensus N 回
    │     ├── 分析結果を engram に push
    │     └── 成熟世界をインメモリ snapshot 保存 ★
    │
    └── 追加クエリ時 → engram_probe()
          ├── snapshot copy から世界を復元
          ├── 新ノード1つ投入
          ├── 10-20 ticks 追加実行
          ├── 反応パターンを返送
          └── 世界を snapshot に巻き戻し（非破壊）
```

### watch OFF

```
engram_watch(off)
    → buffer flush → 最終 push → 世界破棄 or 永続化（選択可）
```

## Mycelium インメモリ世界の運用

### Phase 1: バッチ構築（40 ticks）

engram 蓄積データを汎用ローダーで投入し世界を構築する。
40 ticks で merge チェーンのピークを過ぎ、主要クラスタが形成される。
（現行 tuning: clusterPct=0.7 × 60 ticks = tick 42 がスナップショット地点）

### Phase 2: インメモリ保持

40 ticks 終了時点のノード群をそのまま保持。各ノードが持つ状態:
- h/w/d メトリクス（生存者は安定値に収束済み）
- resonance テーブル（ノード間の親和性マップ）
- contents（merge で吸収したテキスト群）
- feelings（vigor/dread/kinship/hunger の現在値）

tick ループを止めるだけ。isolated-runner の既存構造がそのまま使える。

### Phase 3: 個別投入シミュレーション（engram_probe）

```
保存済み世界 (40t 成熟) ← snapshot copy (JSON deep clone)
    ↓
新ノード1つ投入 (engram data or agent query)
    ↓
10-20 ticks 追加実行
    ↓
観察:
  merged     → 既知クラスタに吸収された。冗長な情報
  resonant   → 高い resonance を獲得。関連性あり、新しい切り口
  loner      → 誰とも反応しない。現在の関心圏外
  cluster形成 → 複数の既存ノードを巻き込んだ。重要なハブ候補
    ↓
結果返送 → 世界を snapshot に巻き戻し（次の probe に影響しない）
```

### パフォーマンス見積もり

| 操作 | ノード数 | 所要時間 |
|------|----------|----------|
| batch 構築 (40t × consensus 5) | ~200 | 数十秒 |
| 個別 probe (15t × consensus 5) | ~200+1 | 数秒 |
| snapshot copy (JSON clone) | ~200 | <100ms |

engram データは数百件規模。Qdrant cosine search が律速だが、
インメモリ世界なら点数が少なく十分高速。
バックグラウンド実行で agent をブロックしない。

### 技術的な追加作業

| 要素 | 現状 | 追加 |
|------|------|------|
| 世界の snapshot/restore | なし | ノード配列の deep copy (JSON clone) |
| tick の途中再開 | なし | runTick を既存ノード群で呼ぶだけ |
| 1ノード動的追加 | なし | slot.nodes に push + Qdrant point 追加 |
| 結果の差分抽出 | なし | 投入前後の resonance/merge 差分 |

いずれも既存コードの小規模拡張で実現可能。

## 実装順序

| 段階 | 内容 | レイヤ | 依存 |
|------|------|--------|------|
| 0 | engram push の自動化改善 | 基盤 | engram 側 |
| 1 | hook → 行動ログ蓄積パイプライン | 入力 | MCP server |
| 2 | 蓄積 → mycelium batch → pushback | 接続先 | mycelium_universal loader |
| 3 | 感情モジュール: 短期 spike 検出 | 感情 | 段階1 |
| 4 | 感情モジュール: 中期積分 + メタ監視 | 感情 | 段階3 |
| 5 | ニューロントライアングル統合 | 感情 | Sphere 由来 + 段階4 |
| 6 | 感情ベクトル → タスクキュー生成 | 感情→接続 | 段階5 |
| 7 | learnedDelta 自己校正ループ | 感情 | 段階6 + engram |
| 8 | engram watch + probe (成熟世界) | 接続先 | 段階2 + 段階6 |
| 9 | 先読み推論 + 非同期レポート | 統合 | 全統合 |

## 既存パーツの対応

| 必要な機能 | 既存パーツ |
|------------|-----------|
| hook 機構 | Claude Code hooks |
| embedding 化 | engram embedding pipeline |
| 汎用ローダー | mycelium_universal loader |
| consensus シミュレーション | mycelium_universal (動作確認済み) |
| digest 出力 | formatters.ts (動作確認済み) |
| 感情モデル | phi-agent feelings (vigor/dread/kinship/hunger) |
| perception matrix | mycelium species profile |
| ニューロントライアングル | Sphere プロジェクト由来 |
| **足りないもの** | **行動ログ→感情変換**, **タスクキュー**, **learnedDelta 蓄積** |

## Sphere との関係

engram + mycelium = Sphere の小規模プロトタイプ。同原理、異スケール。

- 種族設計、consensus、clusterPct、receptor — 全てスケール非依存の設計原則
- ここでの知見はそのまま Sphere に持っていける
- engram+mycelium は「1ユーザーのナレッジベースを1台で回す」ため動作が見える
- Sphere は同じことを N ユーザー × M ドメインで行うため、効果の実感に臨界量が必要
- engram+mycelium が Sphere のプロトタイピング環境として機能している