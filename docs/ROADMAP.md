# Mycelium Universal — 実装ロードライン

> Date: 2026-03-13
> Status: Phase 1 ✅, Phase 1b ✅, Phase 2 ✅, Phase 2b 設計完了（次手）

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

## Phase 1: フィルタリングハードネス制御 ✅

### 概要
代謝パラメータは変えない。同じ生態系を走らせ、**スナップショットタイミング（何%地点で生存判定するか）**のみで選択圧を制御する。

### 設計判断
当初は「代謝パラメータ × hardness 係数」のオーバーレイ方式を検討したが、
パラメータ空間が広がりすぎるため却下。代謝は固定し、観測タイミングだけを変える
シンプルな方式を採用。旧 Phase 2（スナップショットタイミング制御）を Phase 1 に統合。

### 実装済み
- `src/config/metabolism.json` — `hardness.presets` に `harvestPct` のみ定義
  - **soft**: `harvestPct: 0.3` — 30% 地点で生存判定。粗いフィルタ、量を残す
  - **mid**: `harvestPct: 0.6` — 60% 地点。標準フィルタ（デフォルト）
  - **hard**: `harvestPct: 0.9` — 90% 地点。厳選、pure のみ生存
- `src/loader/hardness.ts` — `resolveHardness()` でプリセット解決
- `src/loader/feed-instance.ts` — per-chunk 3軸分類（pure/merged/loner/redundant/dead）
  - `classifyChunks()` で全ノードを個別分類
  - `SurvivorReport.classificationBreakdown` で chunk 分布を公開
- `FILTER_HARDNESS` 環境変数で切替

### 変更対象ファイル
- `src/config/metabolism.json`
- `src/loader/hardness.ts`
- `src/loader/feed-instance.ts`
- `src/loader/main.ts`

---

## Phase 1b: N-run コンセンサス（crossVote）

### 概要
単一実行の分類はシミュレーションの確率的揺らぎに左右される。
同一データで N 回実行し、多数決で安定した分類を得る。

### 背景
旧 `semantic-filter-test.cjs` では N=3 回実行 × majority vote で
分類のブレを吸収していた。現行 Cascade Loader は 1-run のため、
実行ごとに結果が変わりうる。mycelium はバックグラウンド実行のため
N-run のコスト増は許容範囲。

### 実装内容
- 各 feed-instance を N 回（デフォルト 3）実行
- ノードごとに N 回の分類結果を集計、多数決で最終分類を決定
- コンセンサス率（N 回中何回一致したか）をレポートに含める
- 全会一致でないノードはボーダーライン知識として識別可能

### 変更対象
- `src/loader/feed-instance.ts` — N-run ループ、投票集計
- `src/loader/main.ts` — `CONSENSUS_RUNS` 環境変数、レポート出力更新

---

## Phase 2: 閲覧レイヤー（エージェント向けデータ成型）✅

### 概要
SurvivorReport の生データをエージェントが直接利用可能な形に成型する。
AI の逐次処理特性（attention 機構）を考慮し、構造自体が自然な読み順を持つ設計。

### 実装済み

**出力フォーマット（5モード）**:
- **compact**: クラスタ代表テキストのみ（コンテキスト節約）
- **detailed**: クラスタ + メンバー一覧 + 分類ラベル
- **structured**: JSON — エージェントのツール入力として利用可能
- **digest**: 3-tier per-source 出力（meta / pure / clusters）+ DigestQuery
- **manifest**: 軽量ソースインデックス（~50 tokens/source）

**3-tier digest 構造**:
- meta → pure → clusters の順で情報密度が増加
- キーワード文脈抽出（±40 chars 窓）でトークン 62% 削減
- `TAG_CONTEXT_PATTERNS`: process_source.py TAG_RULES のミラー正規表現

**AI-native role mapping**:
- 内部 species 名（herald, sentinel 等）→ 機能的ロール名に変換
- claim / constraint / foundation / synthesis / hypothesis
- 出力境界でのみ変換、内部コードは species のまま

**Progressive disclosure（DigestQuery）**:
- manifest → digest meta → filtered detail の3段階アクセス
- sourceIds, tiers, roles, minClusterSize, contextRadius, maxPure, maxClusters
- ステートレス設計 — 各クエリが独立、行き来自由

**Post-filter re-aggregation**:
- headline: pure[0].text or sourceMetadata.abstract（~120 chars）
- topRole: 生存者の支配的機能ロール
- survivorTags: 生存チャンクのタグ頻度分布

### 変更対象
- `src/output/formatters.ts` — 全フォーマッタ、cleanText、extractContext、role mapping
- `src/loader/feed-instance.ts` — ChunkDetail, ClusterDetail, DeadBrief, SurvivorReport 拡張
- `src/loader/isolated-runner.ts` — harvest() でチャンク詳細・タグ集計
- `src/loader/main.ts` — VIEW_FORMAT + DIGEST_* 環境変数
- `docs/DIGEST_FORMAT.md` — 3-tier 構造、extractContext 仕様

---

## Phase 2b: Digest アクセスレイヤー（次手）

### 概要
Phase 2 で構築した progressive disclosure（manifest → digest meta → filtered detail）は
multi-turn アクセスを前提に設計されているが、実行手段が single-shot CLI のみ。
AI エージェントが実際に段階的アクセスを行えるインターフェースを提供する。

### 設計方針
データ構造で誘導する（強制制御しない）。モデルの進化と順方向に整合する設計。
- 処理順序をハードコードしない — 構造が良ければモデルは適切な順で読む
- DigestQuery はモデル側が「必要だと判断したら」使うオプション
- モデルが賢くなるほど、この構造をより上手く活用する

### 候補アプローチ（優先順）

**A. MCP server（推奨）**
- `manifest` と `digest` を MCP tool として公開
- DigestQuery パラメータがそのまま tool parameters になる
- Claude Code や他エージェントが直接 multi-turn で呼べる
- 前提: フィルタ結果が事前に保存されていること（loader 実行後のレポートファイル）

**B. File-based split**
- manifest.json + per-source digest ファイルを生成
- エージェントが Read で必要なファイルだけ読む
- インフラ不要、最小構成
- progressive disclosure は「ファイルを開くかどうか」で自然に実現

**C. HTTP API**
- `/manifest` `/digest?sourceIds=...&tiers=...` を提供
- 汎用だが構築コスト最大、現段階では過剰

### 変更対象（未定）
- 新規: MCP server or ファイル分割ロジック
- `src/loader/main.ts` — レポート保存形式の拡張

---

## Phase 3: engram キャッシュ統合

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

## Phase 4: 上澄み再投入・途中合流（実験）

### 概要
実用性未検証。静的フィルタリングでは得られない結果が出るかの検証を目的とする。

### 実験内容

**4a. 上澄み再投入（learnedDelta 引継ぎ）**
- 1周目の生存ノードを新しい皿に再投入し、2周目を回す
- **learnedDelta 引継ぎ**: 再投入時に前世の learnedDelta / learnedResonanceDelta をリセットせずそのまま渡す
  - 実装コスト最小（createNode 呼び出し時に前回のδを渡すだけ、コア変更ゼロ）
  - 前世で学んだ行動戦略（merge 回避、accept 傾向等）がそのまま生存力になる
  - round を重ねるほどδが洗練される（自然な emerges）
  - 環境が変われば古い学習は不利 → 過適応も自然に淘汰される
- 2周目で生き残るノードが1周目と質的に異なるかを観察
- 反復選択圧の効果測定

**多段設計方針** (2026-03-13):
- **順次進行**: 1データセットずつ処理。並列混合はしない（前段完了を待つ必要があるため）
- **最大3段程度**: 実用上の上限。これ以上は計算コスト対効果が薄い
- **origin はインメモリのみ**: Qdrant payload には入れない。再現性は元データから再試験で担保
- **DeltaPool**: Dispatcher レベルのインメモリキャッシュ
  - harvest 後にサバイバの learnedDelta + learnedResonanceDelta を回収
  - 次段 inject 時に同一 sourceId+chunkSeqNo で引き当て、初期δとしてセット
  - dead チャンクのδは持ち越さない（前段で脱落 = 学習価値なし）
  - consensus モードとの組合せ: 最終ラン結果のδを使用（平均は過学習リスク）
  - プロセス終了で消滅（永続化不要）

**代替案（不採用の理由）**:
- メトリクスボーナス (w/h/ttl 加算): 即効性あるが恣意的、チューニング地獄
- 三世界テスト式 (前世結果をメタに): 情報は豊富だが消費方法が曖昧、origin 肥大化
- origin を Qdrant に永続化: チャンク毎の差異がなく無駄、テストデータ自体の重要度も低い

**4b. 途中合流（Wave Injection）**
- 成熟した生態系（tick 30 時点）に新データを注入
- 新参者が吸収されるか、ニッチを見つけるかを観察
- 増分更新型フィルタとしての可能性を検証

**4c. 世界統合（DRI 発展形）**
- 異なるソースデータで別々に回した生態系の統合
- synthesis-unique survivors に意味的共通性があるかの検証
- ここで初めて LLM サイドカーが必要になる可能性あり
  （「この生存者群に共通する意味は何か」の解釈）

### スナップショットタイミングと hardness の関係
- スナップショットタイミング（harvestPct）= filtering hardness そのもの
- 次世界（4a 再投入）への入力品質ゲートとして機能する
  - soft で通過したノードを hard で再投入 → 二段階選別
  - hardness の差が learnedDelta の質に直結する

### 判定基準
- 再投入・合流で1周目と異なる分類結果が出る → 有望、Phase 化を検討
- 同じ結果が出る → 計算コストに見合わない、打ち切り

---

## Phase 5: LLM サイドカー統合（将来構想）

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
Phase 1  (hardness)   ✅ 完了 — harvestPct ベースのスナップショット制御
Phase 1b (consensus)  ✅ 完了 — N-run majority vote、デフォルト 10 回
Phase 2  (閲覧)       ✅ 完了 — 5モード出力、3-tier digest、progressive disclosure、role mapping
Phase 2b (アクセス)   ← Phase 2 の typed API に依存、次手
Phase 3  (engram)     ← Phase 2b のアクセス方式に依存
Phase 4  (実験)       ← Phase 1/1b の制御基盤があると効率的
Phase 5  (LLM)        ← Phase 2b + Phase 4c の知見に依存
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
