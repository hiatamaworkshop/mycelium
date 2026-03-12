# Mycelium Universal — 実装ロードライン

> Date: 2026-03-12
> Status: 計画

## ビジョン

Mycelium を RAG の拡張モジュール / サイドカーとして位置づける。
関連 DB から必要なジャンルを抜き取り、生態系ダイナミクスで高速フィルタリングし、
エージェントが即座に利用できる形で提供する。

```
[関連DB群] → ジャンル抽出 → [Source Qdrant]
                                    ↓
                            Cascade Loader
                            (スロット分割 × 並列フィルタ)
                                    ↓
                            ┌─ soft  (粗い上澄み)
                            ├─ mid   (標準フィルタ)
                            └─ hard  (厳選)
                                    ↓
                            [閲覧レイヤー]
                            (エージェント向けデータ成型)
                                    ↓
                            [engram キャッシュ]
                            (フィルタ結果のインメモリ保持)
                                    ↓
                            LLM / Agent
```

---

## Phase 1: フィルタリングハードネス制御

### 概要
tick 数と代謝パラメータの組み合わせで選択圧を3段階制御する。

### 実装内容
- metabolism.json にプリセット定義（soft / mid / hard）
  - **soft**: 低 decay、短 tick（~30）。粗い上澄み。量を残す
  - **mid**: 標準代謝、標準 tick（~60）。現行デフォルト相当
  - **hard**: 高 decay、長 tick（~100）。厳選。pure のみ生存
- Cascade Loader に `FILTER_HARDNESS` 環境変数追加
- プリセット切替は metabolism.json の差し替えではなく、オーバーレイ方式
  （ベースパラメータ × hardness 係数）

### 変更対象
- `src/config/metabolism.json` — hardness プリセット定義追加
- `src/loader/main.ts` — プリセット読み込み・適用
- `src/core/tick.ts` — 代謝パラメータのランタイム注入（現行は静的読み込み）

---

## Phase 2: スナップショットタイミング制御

### 概要
tick 途中の任意時点でスナップショットを取得し、フィルタリング深度を段階的に評価する。

### 実装内容
- 3段階スナップショット: early（全体の 30%）、mid（60%）、final（100%）
- 各スナップショット時点の生存ノード・分類を記録
- early snapshot で十分なフィルタ結果が得られた場合の早期終了オプション
- スナップショット間の差分レポート（early→mid で消えたノード = ボーダーライン知識）

### 変更対象
- `src/loader/feed-instance.ts` — snapshot フック追加
- `src/core/pushback.ts` — snapshot 時点の分類実行
- 新規: `src/loader/snapshot-manager.ts` — タイミング制御・差分算出

---

## Phase 3: 閲覧レイヤー（エージェント向けデータ成型）

### 概要
SurvivorReport の生データをエージェントが直接利用可能な形に成型する。
現状の出力は JSON 配列で、エージェントのコンテキストウィンドウに載せるには生々しすぎる。

### 実装内容
- 生存ノードの contents をクラスタリング（cosine 近傍グループ化）
- クラスタごとの代表テキスト選出（最高 fitness ノードの contents）
- 出力フォーマット:
  - **compact**: クラスタ代表テキストのみ（コンテキスト節約）
  - **detailed**: クラスタ + メンバー一覧 + 分類ラベル
  - **structured**: JSON — エージェントのツール入力として利用可能
- token 数制限オプション（指定 token 数以内に収まるよう上位クラスタから切り詰め）

### 変更対象
- 新規: `src/output/view-layer.ts` — クラスタリング・成型ロジック
- 新規: `src/output/formatters.ts` — compact / detailed / structured フォーマッタ
- `src/loader/main.ts` — 出力パイプラインに閲覧レイヤーを接続

---

## Phase 4: engram キャッシュ統合

### 概要
フィルタリング結果を engram に push し、以降は mycelium を回さず engram recall で即時取得する。
mycelium は「初回の重い計算」、engram は「結果のキャッシュ」。cache miss 時のみ mycelium が走る。

### 実装内容
- フィルタ結果の engram push（`mycelium-filtered` タグ付き）
  - pure → weight 高で push（長期キャッシュ候補）
  - merged → 統合テキストを push
  - loner / redundant / dead → push しない（フィルタ済み）
- cache hit 判定: engram recall で `mycelium-filtered` タグ付きノードが十分な数返れば skip
- cache invalidation: ソース DB の更新検知（point count / 最新タイムスタンプ比較）
- engram 側の TTL による自然なキャッシュ期限切れ

### 変更対象
- 新規: `src/output/engram-cache.ts` — push / hit 判定 / invalidation
- `src/loader/main.ts` — キャッシュ判定を Cascade Loader の前段に挿入
- engram gateway 側の変更は不要（既存の push API をそのまま利用）

---

## Phase 5: 上澄み再投入・途中合流（実験）

### 概要
実用性未検証。静的フィルタリングでは得られない結果が出るかの検証を目的とする。

### 実験内容

**5a. 上澄み再投入（learnedDelta 引継ぎ）**
- 1周目の生存ノードを新しい皿に再投入し、2周目を回す
- **learnedDelta 引継ぎ**: 再投入時に前世の learnedDelta / learnedResonanceDelta をリセットせずそのまま渡す
  - 実装コスト最小（createNode 呼び出し時に前回のδを渡すだけ、コア変更ゼロ）
  - 前世で学んだ行動戦略（merge 回避、accept 傾向等）がそのまま生存力になる
  - round を重ねるほどδが洗練される（自然な emerges）
  - 環境が変われば古い学習は不利 → 過適応も自然に淘汰される
- origin payload 拡張でトレーサビリティを確保:
  ```json
  origin: { source: "arxiv", round: 2, prevClassification: "pure", prevSurvivalRate: 0.85 }
  ```
- 2周目で生き残るノードが1周目と質的に異なるかを観察
- 反復選択圧の効果測定

**代替案（不採用の理由）**:
- メトリクスボーナス (w/h/ttl 加算): 即効性あるが恣意的、チューニング地獄
- 三世界テスト式 (前世結果をメタに): 情報は豊富だが消費方法が曖昧、origin 肥大化

**5b. 途中合流（Wave Injection）**
- 成熟した生態系（tick 30 時点）に新データを注入
- 新参者が吸収されるか、ニッチを見つけるかを観察
- 増分更新型フィルタとしての可能性を検証

**5c. 世界統合（DRI 発展形）**
- 異なるソースデータで別々に回した生態系の統合
- synthesis-unique survivors に意味的共通性があるかの検証
- ここで初めて LLM サイドカーが必要になる可能性あり
  （「この生存者群に共通する意味は何か」の解釈）

### 判定基準
- 再投入・合流で1周目と異なる分類結果が出る → 有望、Phase 化を検討
- 同じ結果が出る → 計算コストに見合わない、打ち切り

---

## Phase 6: LLM サイドカー統合（将来構想）

### 概要
軽量 LLM を mycelium の消費者として接続し、フィルタ結果を直接推論に利用する。

### 構想内容
- 閲覧レイヤー出力 → LLM プロンプトへの自動注入
- mycelium の分類ラベル（pure / merged）を LLM へのコンテキスト優先度に変換
- 実験的: ノードに LLM を仮想的に割り当て、assess() を LLM 推論で代替
  - softmax の代わりに LLM が行動選択
  - 通信相手のノードに LLM を乗せ換えて receptor 判定
  - 「細胞としてのライフタイムを体感させる」観察実験

---

## 依存関係

```
Phase 1 (hardness)  ← 独立、即着手可能
Phase 2 (snapshot)  ← Phase 1 の代謝制御基盤に依存
Phase 3 (閲覧)      ← 独立、Phase 1-2 と並行可能
Phase 4 (engram)    ← Phase 3 の出力フォーマットに依存
Phase 5 (実験)      ← Phase 1-2 の制御基盤があると効率的
Phase 6 (LLM)       ← Phase 3 + Phase 5c の知見に依存
```

## engram 連携モデル

engram は動的メモリの軽量機能。mycelium は重い計算（フィルタリング）担当。

```
engram: push → push → push ... (蓄積、時限付きメモリ)
              ↓ (エージェント判断: "十分溜まった" or "特定テーマで必要")
         mycelium run (domain filter, on-demand)
              ↓
         filtered cache → agent consumption
```

**トリガーはエージェント任意**。自動トリガーではない。理由:
- 少量の push で mycelium を回す必要性は低い
- engram 自体が時限付きメモリであり、古いデータは自然に decay/flag される
- ある程度データが蓄積されてからエージェントが判断して実行すれば十分
- engram の鮮度フィルタ → mycelium の生態系フィルタ = 二重フィルタ構造

---

## 初回テスト結果（2026-03-12）

### World Isolation テスト（domain モード、60 ticks）

| World | Points | Survived | Rate | Slots | Ticks |
|-------|--------|----------|------|-------|-------|
| patent | 408 | 24 | 5.9% | 5 | 102 |
| pubmed | 833 | 62 | 7.4% | 11 | 131 |

### 所見
- **フィルタリングは機能**: 90%以上が淘汰
- **anchor が支配的**: 長寿 TTL + 低 decay で merge 吸収の時間を確保
- **classification は merged が大半**: pure（ユニーク知識）は稀
- **後半スロットの生存率が高い傾向**: 前のスロットの残存ノードとの合流効果
  - ドメイン内のクロス相互作用は設計意図通り（世界内は shared）
- **tag なしノードが多い（60-80%）**: 学術テキストに対するキーワード規則の限界
  - 改善案: ドメイン特化タグ規則の追加

---

## 設計原則（全 Phase 共通）

- **セマンティクスに触れない**: 意味の解釈は LLM の仕事。mycelium は量を減らすことに徹する
- **疎結合**: mycelium はデータソースの構造を知らない。前処理レイヤーが翻訳する
- **閉鎖系維持**: tick 中に外部から介入しない。初期条件とパラメータのみで制御
- **観察優先**: 最適化ではなく、生態系の振る舞いを観察する。結果の解釈は外部に委ねる
