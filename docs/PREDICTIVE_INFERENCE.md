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
| **パスアクセスカウンタ** | hook (全tool call) | 中期 | 下記参照 |

### パスアクセスカウンタ（Path Heatmap）

全 tool call の対象パスを記録し、アクセス回数を重みとしてツリーに蓄積する。

```
/ (45)
└── src/ (41)
    ├── loader/ (27)        ← ホットな分岐点 = 作業の核心
    │   ├── feed-instance.ts (15)
    │   └── isolated-runner.ts (12)
    ├── output/ (8)
    │   └── formatters.ts (8)
    └── config/ (6)
        └── metabolism.json (6)
```

**構造的特性:**
- ネスト先端（ファイル）= 個別の重み
- 分岐点（ディレクトリ）= 配下の合算 → 文脈の重み
- 自然とネスト先端はスコアが低く、上位分岐点ほどスコアが高くなる

**感情システムへの入力:**

| パスパターンの変化 | 感情への寄与 |
|-------------------|-------------|
| ホットパスの急な変化（作業対象切替） | uncertainty |
| ホットパスの収束（1箇所に集中） | flow or frustration（他軸で判別） |
| 未知パスへの初アクセス | hunger（新領域に踏み込んだ） |
| 同概念を別パスで再検索 | frustration（最強の迷い信号） |

**engram/mycelium 連携:**
- ホットパス上位 N 件を engram に定期 push → セッション復帰時に即座に文脈取得
- パスツリー自体を mycelium 世界の初期メトリクスに変換可能
  - 高アクセスパスのチャンク → 高い初期 w
- mycelium なしでも単体で有用（軽量実装で即効性あり）

### コマンドカウンタ（時間ウィンドウ駆動）

tool call の種類と頻度を時間ウィンドウで集計し、パターンから感情を推定する。

```
時間ウィンドウ (例: 直近 5 分)
    Read:  ████████ 8
    Grep:  ██████   6
    Edit:  █        1
    Bash:  ███      3
    Agent: ██       2
```

**パターン分類と感情マッピング:**

| パターン | コマンド比率 | 感情 |
|---------|-------------|------|
| 探索型 | Read+Grep 高、Edit 低 | hunger（情報収集中） |
| 実装型 | Edit+Bash 高、Grep 低 | flow or confidence（書けている） |
| 試行錯誤型 | Edit→Bash→Edit→Bash 交互 | frustration（試しては直す） |
| 迷走型 | Grep 高、Read 高、Edit 0 | uncertainty（何を変えるかわからない） |
| 委譲型 | Agent 高 | isolation（自力で解けない） |
| 停滞型 | 全コマンド低頻度 | fatigue or 離脱 |

**時間ウィンドウの重ね合わせ:**

```
短期 (1分):  Edit→Bash(fail)→Edit→Bash(fail)  → frustration spike
中期 (10分): Grep 30回, Read 20回, Edit 2回     → hunger 傾向
メタ (全体): 総コマンド数 200+, 2時間経過        → fatigue 蓄積
```

短期ウィンドウの急変が spike、中期ウィンドウの安定パターンが傾向。
両者の **差分** が最も意味のある信号 — 中期は探索型なのに短期で試行錯誤型に変わった
= 「何かを見つけたが上手くいかない」= frustration の立ち上がり。

**感情マッパ（コマンドカウンタ → 6軸変換）:**

```
mapper(window) → {
  frustration: f(edit_bash_alternation, bash_fail_rate)
  hunger:      f(read_grep_ratio, grep_miss_rate)
  uncertainty: f(grep_diversity, edit_zero_flag)
  confidence:  f(edit_success_rate, bash_pass_rate)
  fatigue:     f(total_count, elapsed_time)
  flow:        f(edit_bash_success_chain, low_grep_ratio)
}
```

パスアクセスカウンタが「どこを」見ているかを示し、
コマンドカウンタが「何をしているか」を示す。
両者を組み合わせて「どこで何に詰まっているか」が特定できる。

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

### 感情ベクトル構成（6軸）

入力を3時間軸で処理し、6軸の感情ベクトルを構成する。
**単一スカラー（危機度）ではなく、ベクトル全体がタスクキューを生成する。**

#### 6軸定義

| 軸 | 極性 | 主な入力源 | 意味 |
|----|------|-----------|------|
| **frustration** | 負 | Edit失敗→Read→Editループ、同概念の言い換え再検索、エラー連続 | 行き詰まり。解法が見えない |
| **hunger** | 負 | engram pull 空振り、Grep 0件連続、大量のファイル Read | 知識ギャップ。必要な情報が存在しない |
| **uncertainty** | 負 | 検索パターンの散乱、hedging表現の増加、応答が長い | 方向性の喪失。何をすべきかわからない |
| **confidence** | 正 | テスト通過、Edit一発成功、検索パターンの収束 | 確信。仮説が正しいと確認された |
| **fatigue** | メタ | compact発生、セッション長時間化、同一ファイルRead 3回+ | 認知負荷の蓄積。内容非依存 |
| **flow** | 正 | tool call→成功→次のtool callがスムーズに連鎖 | 没入。思考と行動が一致している |

#### 感情→タスクキュー マッピング

```
感情ベクトル (6軸)
    ├── frustration: 0.7  → 関連知識の先読み (確率: 高)
    ├── hunger: 0.8       → 知識ギャップ補填 (確率: 最高)
    ├── uncertainty: 0.5  → 類似事例の検索 (確率: 中)
    ├── confidence: 0.6   → engram push 推奨 (確率: 中高)
    ├── fatigue: 0.4      → ストレス警告待機 (確率: 低)
    ├── flow: 0.9         → 全介入を抑制 ★ (確率: —)
    │
    ▼
タスクキュー (確率順、量子的グラデーション)
    1. hunger spike     → mycelium: 未知領域の知識を filter
    2. frustration spike → mycelium: エラー周辺の知識を filter
    3. confidence 持続   → engram push: 今の知見を保存せよ
    ...
```

#### 正の感情の役割

負の感情がタスクを **起動** するのに対し、正の感情はシステムの **抑制と保存** を担う。

| 発火 | 接続先 |
|------|--------|
| confidence 持続 | engram push 推奨（知見を保存せよ） |
| confidence spike 後の安定 | milestone 検知 → レポート整理推奨 |
| flow 状態 | **全介入を抑制**（邪魔するな） |
| flow → confidence 連鎖 | 最も生産的な状態。記録だけして一切介入しない |

**flow が最も重要な軸かもしれない。**
先読みシステムが「助けるべき時」だけでなく「黙るべき時」を知るために不可欠。
これがないと有能だが空気の読めないアシスタントになる。

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

感情システムの sensitivity を継続的に校正する。4つの方法を併用する。

#### 校正方法（優先度順）

| 優先度 | 方法 | 信頼性 | コスト | 備考 |
|--------|------|--------|--------|------|
| 1 | **暗黙フィードバック（結果ベース）** | 中 | ゼロ（常時） | ベースライン。鈍化偏向あり |
| 2 | **閾値初回確認** | 高 | 極小（初回のみ） | 新パターン初回のみ発火 |
| 3 | **開発者の任意チューニング** | 最高 | 任意 | いつでも上書き可能 |
| 4 | **初期キャリブレーション** | 高 | 初回のみ | baseline 測定 |

#### 方法1: 暗黙フィードバック（常時稼働）

```
感情システムが frustration 高 と判定
  → mycelium 先読みを実行、結果を提示
  → エージェントがその結果を使った → 判定は正しかった → sensitivity 維持
  → エージェントが無視した → 判定が過剰だった → sensitivity -= 0.05
```

- 動作保証できる。結果の利用/無視は hook で観測可能
- 誰も意識的に何かをする必要がない
- 学習は遅い（何度も繰り返して初めて補正が効く）
- バックグラウンド動作のため鈍化方向に偏りがち → 他の方法で補正

#### 方法2: 閾値初回確認

```
感情システムが初めて frustration > 0.7 を検出
  → エージェントに1回だけ確認:「困っていますか？」
  → yes/no で sensitivity を大きく調整
  → 同じパターンでは二度と聞かない（learnedDelta に記録済み）
```

- 最小限の介入で最大の情報を得る
- 「初回のみ」が重要 — うるさくならない
- たまに発火するのは許容範囲

#### 方法3: 開発者の任意チューニング

```
engram_tune({ frustration_sensitivity: -0.1, context: "grep 多用は通常作業" })
```

- 開発者が「これは迷いじゃない」と明示的に補正
- 最も信頼性が高い信号源。開発者が言ったことは正しい
- 任意タイミングでいつでも発火可能

#### 方法4: 初期キャリブレーション

初回セットアップ時に擬似作業を流し、baseline の sensitivity profile を測定する。

```
engram_calibrate()
    │
    ├── Phase 1: 探索シミュレーション
    │   → Grep/Read を連続実行（正常な探索パターン）
    │   → この時の感情ベクトルを baseline として記録
    │   → 「これは frustration ではない」を学習
    │
    ├── Phase 2: 実装シミュレーション
    │   → Edit/Bash を連続実行（正常な実装パターン）
    │   → flow/confidence の baseline を記録
    │
    ├── Phase 3: 意図的な困難パターン
    │   → Edit 失敗 → Read → Edit を繰り返す
    │   → frustration 閾値のキャリブレーション
    │
    └── 結果: 開発者固有の sensitivity profile を engram に保存
```

**体験型キャリブレーション（テストスクリプト方式）:**

座学ではなくエージェントに擬似的な状況を **体験** させ、対話的に sensitivity を測定する。

```
engram_calibrate() — テストスクリプト実行

  [テスト 1] 正常探索パターン
  → 擬似 grep: 5件ヒット → 3件ヒット → 8件ヒット
  → システム推定: hunger 0.1, frustration 0.0
  → エージェントに提示:「frustration 0.0 — do you agree?」
  → 「yes」→ baseline 記録

  [テスト 2] 空振りパターン
  → 擬似 grep: 0件 → 0件 → 0件
  → システム推定: hunger 0.6, frustration 0.3
  → 「hunger 0.6 — do you agree?」
  → 「もう少し高い、0.8 くらい」→ sensitivity 上方修正

  [テスト 3] 試行錯誤パターン
  → 擬似 Edit → Bash(fail) → Edit → Bash(fail)
  → システム推定: frustration 0.8
  → 「frustration 0.8 — do you agree?」
  → 「yes」→ 閾値確定

  [テスト 4] flow パターン
  → 擬似 Edit → Bash(pass) → Edit → Bash(pass)
  → システム推定: flow 0.7, confidence 0.5
  → 「flow 0.7 — do you agree?」
  → 「yes」→ baseline 記録
```

- エージェント自身が「この状況で自分はこう感じる」を体験的に申告
- テストスクリプトだから動作が保証される（通常作業中の自主申告と違い確実に発火）
- エージェントの回答が learnedDelta の初期値になる
- mycelium の consensus と同じ発想 — 初期状態の不確実性を制御する手法

- 初回の偽陽性を大幅に減らす
- 開発者ごとの「通常パターン」が異なるため、最初に測定しておく
- 硬派だが確実。ここまでやるプログラムは信頼できる

#### 校正の全体フロー

```
初期キャリブレーション (方法4)
    → baseline sensitivity profile
    ↓
常時: 暗黙フィードバック (方法1) が少しずつ補正
    ↓
新パターン検出時: 閾値初回確認 (方法2) で急速校正
    ↓
いつでも: 開発者チューニング (方法3) が上書き
    ↓
全ての補正 → learnedDelta として engram に蓄積
    → slow receptor (性格層) のデータになる
    → mycelium の perception matrix 学習補正と同構造
```

エージェント自主申告（MCP tool で感情を明示的に投入）は optional として残す。
動作保証できないが、動いた時の情報価値は高い。

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
| frustration spike | mycelium: エラー周辺の関連知識を filter |
| hunger spike | mycelium: 未知領域の知識を filter |
| uncertainty 持続 | mycelium: 類似パターンの過去事例を filter |
| confidence 持続 | engram push 推奨（知見を保存せよ） |
| fatigue 上昇 | ストレス警告、compact 推奨、メモリファイル肥大警告 |
| flow 状態 | **全介入を抑制**（黙るべき時を知る） |
| frustration + hunger 複合 | 高優先度で mycelium 先読み起動 |
| confidence → flow 連鎖 | 記録のみ、一切介入しない |

接続先は段階的に増やせる。感情システム自体は小さく堅く保つ。

## Receptor 実装

### 配置: engram MCP の拡張モジュール

独立 MCP server ではなく、engram MCP の拡張モジュールとして実装する。

**理由:**
- Qdrant が既にある — 感情システムが参照する知識も push 先も同じ DB。接続が二重にならない
- tool 命名が自然 — `engram_watch`, `engram_probe`, `engram_calibrate` は engram の tool として違和感がない
- デプロイが増えない — `claude_desktop_config.json` の変更不要
- 司令塔機能 — engram が「記憶」だけでなく「知覚」も持つ。receptor は engram の感覚器官

```
engram MCP server (拡張後)
├── 既存: push / pull / flag / ls / status
├── 新規: watch(on/off)  ← hook 受信開始/停止
├── 新規: probe(text)    ← mycelium 世界に問い合わせ
├── 新規: calibrate()    ← 体験型キャリブレーション
├── 新規: tune(delta)    ← 開発者の任意チューニング
└── 内部モジュール（疎結合）
    ├── receptor: hook イベント受信 + ログ蓄積
    ├── emotion: 6軸ベクトル算出 + 発火判定
    ├── heatmap: パスアクセスカウンタ
    └── commander: コマンドカウンタ + 時間ウィンドウ
```

**疎結合の原則:** 内部モジュールは engram 本体のコードとは分離。
receptor が肥大化しても engram の push/pull には影響しない。

### IDE 非依存の原則

入力源は IDE 固有の機能に依存してはならない。

| 入力源 | IDE 依存? | 備考 |
|--------|----------|------|
| tool call hooks (Read/Edit/Grep/Bash) | **No** | Claude Code 自体の機能 |
| bash exit code | **No** | shell |
| engram pull/push | **No** | MCP |
| ファイルアクセスパス | **No** | tool call の引数から取得 |
| VSCode selection/open file | **Yes** | 使わない |
| IDE diagnostic (赤波線) | **Yes** | 使わない |

**原則: tool call hooks + engram MCP だけで構成する。IDE 固有の入力には触れない。**

### 環境マッパ（Agent Framework Normalizer）

receptor は正規化されたイベントだけを受け取る。
tool 名の違いは環境マッパが吸収し、receptor は元の agent framework を知らない。

```
┌─────────── 環境マッパ ───────────┐
│                                  │
│  Claude Code hooks               │
│    Read  → "file_read"           │
│    Edit  → "file_edit"           │
│    Grep  → "search"             │
│    Bash  → "shell_exec"         │
│    Agent → "delegation"          │
│                                  │
│  Cursor (将来)                   │
│    composer.read → "file_read"   │
│    composer.edit → "file_edit"   │
│                                  │
│  自作 agent (将来)               │
│    readFile() → "file_read"      │
│    exec()     → "shell_exec"    │
│                                  │
│  出力: 正規化イベント             │
│    { action, path, result, ts }  │
└──────────────────────────────────┘
         ↓
    receptor（正規化イベントだけ知っている）
```

**正規化アクション一覧:**

| 正規化 action | 意味 | 感情システムでの用途 |
|--------------|------|-------------------|
| `file_read` | ファイル読み取り | パスヒートマップ、反復検出 |
| `file_edit` | ファイル編集 | 実装/試行錯誤パターン |
| `search` | コード検索 | 探索/迷走パターン |
| `shell_exec` | シェル実行 | ビルド成功/失敗 |
| `delegation` | サブエージェント起動 | isolation 検出 |
| `memory_read` | 記憶検索 (engram pull) | hunger / hit/miss |
| `memory_write` | 記憶保存 (engram push) | confidence |

環境マッパは薄いレイヤ。マッピング定義は設定ファイルで差し替え可能にする。

### MCP サイドカーとしての動作

Claude 側に負荷をかけず、engram MCP 内の receptor モジュールで行動ストリームを監視する。

```
Claude → tool call → hook 発火 → engram MCP (receptor モジュール)
                                    ├── 環境マッパで正規化
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