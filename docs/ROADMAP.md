# Mycelium Universal — 実装ロードライン

> Date: 2026-03-13 (updated 2026-07-17)
> Status: Phase 1 ✅, Phase 1b ✅, Phase 2 ✅, Phase 2b ✅ (MCP server), Phase F0–F3 ✅（燃料ループ完結）, Phase 3 ✅（engram キャッシュ統合、engram 側実装）— 次手: Phase 4（上澄み再投入・途中合流、実験）

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

## Phase 2b: Digest アクセスレイヤー ✅ (2026-07)

> 実装済み: A 案（MCP server）を採用。`src/server.ts` が `mycelium_filter`（on-demand 実行、
> viewFormat: digest / manifest / compact / structured 選択可）と `mycelium_status` を公開。
> MCP 経由の実行ではレポートを保存しない（永続化は呼び出し側 = receptor sink の責務）。
> 未実装の残り: 保存済みレポートに対する DigestQuery 単位の multi-turn アクセス
> （現状は run 単位。必要になった時点で B 案のファイル分割と合わせて再検討）。

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

## Phase F: 燃料ループ（Nutrition Feedback Loop）— GAP-1 根治

### 概要

生態系は「選別エンジン」として動作しているが、初期メトリクスがフラットなため
品質勾配が存在しない（GAP-1）。淘汰は冗長構造のみに反応し、「良い知識」と
「悪い知識」を区別する燃料がない状態。外部由来の品質シグナルを初期メトリクスに
変換する注入口と、利用実績を書き戻すフィードバックループでこれを解消する。

### 設計原則

- **燃料はバイアスであって決定ではない**: 初期 w への影響は clamp `[0.3, 1.5] × initialW`。
  燃料が良くても生態系内で淘汰されうるし、燃料ゼロでも生き残れる
- **機能的純粋性**: mycelium は stdout フィルタのまま。ファイル書き込み・DB 書き戻しは
  一切行わない。メトリクス差分はレポート（stdout / structured JSON）で表明し、
  適用は呼び出し側（receptor sink）の責務
- **エコーチェンバー対策**: 自己生存シグナル（弱）とエージェント利用シグナル（強）を区別。
  EMA decay で古い実績を減衰。consensusRate < 0.6 のノードには燃料を与えない。
  定期的に燃料オフの監査 run を回し、燃料なしでの分類とのドリフトを監視

### 2つの燃料チャネル

1. **著者側**: `payload.weight`（[-2, 4]）— push 時点で著者が付ける重要度
2. **利用側**: `payload.myceliumMetrics` — `{ survived, lastClass, hits, reads, updatedAt }`。
   フィルタ生存実績 + エージェントによる実利用実績

### フェーズ分割

**F0: 注入口 ✅ (2026-07-17)**
- `payload.weight` → 初期 w 変換（`nutrition.external` 設定、linear map + clamp）。
  weight 保持ノードは jitter を自動スキップ
- `pointId` を ChunkDetail / DeadBrief に追加 — 書き戻しキーの配管
- REPORT_DIR opt-in 化（純粋性の担保）

**F1: NutritionResolver + 呼び出し側書き戻し ✅ (2026-07-17)**
- `src/loader/nutrition-resolver.ts` 新設 — `applyUsageNutrition()` が
  `payload.myceliumMetrics {survived, lastClass, hits, reads, updatedAt}` を
  F0 の weight-scaled / jitter base の上に加算バイアスとして適用
  - survived → w バイアス（tanh 飽和）、hits+reads×0.5 → h バイアス/d バイアス
    （利用が多いほど h 高・decay 低）、lastClass==="pure" → 追加ボーナス
  - metrics 未設定なら no-op（既存 F0/jitter パスは無変更で回帰なし）
  - 旧 engram-native mycelium の feeder.ts（weight/hitCount/status=fixed →
    w/h/d バイアス）を汎用 myceliumMetrics 向けに一般化した設計
  - config: `nutrition.bias/weightSaturation/hitCountCap/fixedBonus`
    （旧 engram 専用ドキュメントを myceliumMetrics 向けに更新）
- レポートは既存の pointId + classification（=lastClass）+ consensusRate
  （ChunkDetail/DeadBrief, F0 で pointId 追加済み）がそのまま書き戻し用
  メトリクス差分として機能 — 新規フィールド追加は不要だった
- receptor sink 側: レポートを受け取り source Qdrant の `myceliumMetrics` に適用
  （mycelium リポジトリ外、subsystem 統合の一部、未実装）
- 検証: 単体（applyUsageNutrition の手計算一致）+ 実 engram データでの
  無回帰確認（myceliumMetrics 不在時に F0 と同一結果）

**F2: 利用側シグナル + 減衰 ✅ (2026-07-17, engram 側実装)**
- engram gateway `POST /mycelium/report` — receptor sink がフィルタ結果
  （pointId + classification + consensusRate）を書き戻す共有プロトコル。
  survivors (pure/merged) は survived+1、全言及ノードは lastClass 更新
- hits/reads push — engram digestor の bump キューに統合。focused fetch →
  hits、recall 出現 → reads（既存 hitCount/weight と同一 setPayload で追記）
- EMA decay — updatedAt 基準の半減期減衰（デフォルト 14 日、
  `MYCELIUM_USAGE_HALFLIFE_DAYS` で調整）。書き込み時に lazy 適用。
  survived は減衰しない（mycelium 側 tanh 飽和が担当）
- 自己/利用シグナルの重み分離は F1 の metabolism.json nutrition 設定に集約済み
- mycelium リポジトリ側の変更なし — 全て engram 側
  （`gateway/src/mycelium-metrics.ts`, `mcp-server/src/receptor/mycelium-sink.ts`）

**F3: 監査と評価 ✅ (2026-07-17)**
- `FUEL_OFF=true` — 両燃料チャネル（payload.weight / myceliumMetrics）を無視する
  flat run（燃料オフ監査）
- `AUDIT_AB=true` — 全 slot を fueled + flat の2回実行し、ドリフト監査 JSON を
  stdout に出力（`src/loader/audit.ts`）: agreement / transitions /
  fuel-dependent・fuel-suppressed survivors / survival・consensus 比較。
  `AUDIT_AB + FUEL_OFF` = flat vs flat で jitter ノイズフロアを測定。
  監査モードは SurvivorReport を stdout に出さないので receptor sink の
  書き戻しは発生しない（純粋な測定）
- MCP tool `mycelium_filter` に `fuelOff` / `auditAB` パラメータ追加
- engram gateway 側: consensusRate < 0.6 のエントリに燃料クレジットを与えない
  ゲート（`MYCELIUM_MIN_CONSENSUS`、設計原則のエコーチェンバー対策の実装）
- バグ修正: consensus で survivor に昇格した chunk が chunkDetails / deadBriefs の
  両方から消えていた（buildConsensusReports）— 書き戻し配列の完全性を修復
- 初回 A/B 実測（engram collection 166 chunks, 10 runs）:
  drift 30.7% vs ノイズフロア 24.1% → 燃料起因 ≈ 6.6pp。
  生存率ほぼ不変（fueled 49.4% / flat 50.0%）、avg consensus は fueled +2.5pp
  → 「燃料はバイアスであって決定ではない」を定量確認

### 変更対象
- `src/loader/isolated-runner.ts` — NutritionResolver 呼び出し（F1）
- 新規: `src/loader/nutrition-resolver.ts`（F1）
- `src/loader/feed-instance.ts` (types) — レポートへのメトリクス差分追加（F1）
- receptor / sink 側リポジトリ — 書き戻し適用、hits/reads push（F1/F2）
- 新規: `src/loader/audit.ts` — fueled vs flat ドリフト監査（F3）
- `src/loader/main.ts` / `src/server.ts` — FUEL_OFF / AUDIT_AB 配線（F3）

---

## Phase 3: engram キャッシュ統合 ✅ (2026-07-17, engram 側実装)

### 概要
フィルタリング結果を engram に push し、以降は mycelium を回さず engram recall で即時取得する。
mycelium は「初回の重い計算」、engram は「結果のキャッシュ」。cache miss 時のみ mycelium が走る。

### 実装（当初案からの設計変更）
当初案（`src/output/engram-cache.ts` を mycelium 側に置く）は F0–F3 実装前に書かれたもので、
F2 で確立した「stdout をどう扱うかは全部 receptor 側の責務、mycelium は純粋 stdout フィルタのまま」
という設計原則と噛み合わないため、**キャッシュ判定・push ロジックは全て engram/mcp-server 側**
（`mycelium-cache.ts`、F2 の `mycelium-sink.ts` と同じ層）に実装。engram gateway 側は無改修
（既存の `/ingest` `/scan` `/recall` のみで完結）。mycelium 側の変更は汎用の除外フックのみ。

- `mycelium-cache.ts`（engram/mcp-server/src/receptor/、新規）
  - `checkMyceliumCacheGate(args)` — callMcpTool 呼び出し**前**のゲート。メタノード
    （タグ `mycelium-cache-meta:{collection}:{hardness}`、content に `{collection,pointCount,ts,...}`）
    の pointCount が現在のソース Qdrant point count と一致すれば hit → mycelium 実行を完全スキップ
  - `pushMyceliumCache(raw, args)` — 実行後の postProcessor。pure/merged のみ
    `mycelium-filtered` + `mycelium-src:{collection}:{hardness}` タグ付きで `/ingest`（8件ずつバッチ）、
    メタノードを push し直し
  - cache invalidation は point count 比較のみ（タイムスタンプ比較は不採用、シンプルさ優先）
  - キャッシュの鮮度切れは engram 自身の TTL 経済（weight=0 で始まり使われなければ自然消滅）に
    そのまま乗せる ―― 独自の鮮度クロックは持たない
  - `pure → weight 高で push` は不採用: `/ingest` は常に `weight:0` 固定（実装確認済み）で
    上書き手段がなく、gateway 無改修の制約と衝突するため。通常ノードと同じ weight/TTL 経済に委ねる
- `service-loader.ts`: `postProcessors` を単一関数→配列化（F2 の `processMyceliumResult` と
  F3 の `pushMyceliumCache` が両方動く）、新規 `preGates`（callMcpTool 前のスキップ判定）を追加
- `receptor-rules.json`: `mycelium_filter` の args に `filterHardness: "mid"`,
  `excludeTags: "mycelium-filtered"` を追加
- mycelium 側: `EXCLUDE_TAGS` 汎用フック（`src/loader/main.ts` で解釈・適用、`src/server.ts` に
  zod パラメータ追加）―― **自己参照ループ対策**。本番設定は `collections:"engram"`
  （mycelium が engram 自身のコレクションを自己フィルタ）のため、無対策だと push したキャッシュ
  ノードが次回実行で「新しい未フィルタ入力」として再度拾われ増殖する。receptor が
  `excludeTags: "mycelium-filtered"` を渡すことでこれを遮断
- 検証: 実インフラ（Qdrant + gateway 稼働中）に対しスクラッチのソースコレクション・project で
  miss→push→hit→ソース変更→miss の往復を確認。EXCLUDE_TAGS 単体でも、タグ付きノードを混在させた
  ソースに対し「除外なし=12チャンク」「除外あり=1件除外され11チャンク」を実測confirm

### 変更対象
- 新規: `engram/mcp-server/src/receptor/mycelium-cache.ts`
- `engram/mcp-server/src/receptor/service-loader.ts`, `receptor-rules.json`
- `mycelium_universal/src/loader/main.ts`, `src/server.ts`（EXCLUDE_TAGS のみ）
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

**4c. Meta-World（Cross-file クラスタ統合）**

各ファイルを独立した世界でフィルタリングした後、生存クラスタを meta-world に投入し
cross-file の意味的関係をダイナミクスで発見する。ベクトル DB の KNN とは質的に異なる。

**原則**: 1 file = 1 mycelium は維持。meta-world は後段の統合ステップ。

**投入ノード構成**:
- 各ソースの **anchor** → そのまま anchor 種族（不動の座標基準点）
- クラスタ **origin ノード** → herald に変換（社交的、signal で他クラスタを検出）
- クラスタ **最終 merge ノード** → herald に変換（origin とは異なるベクトル位置 → 検出範囲拡大）
- origin + 最終 merge の2ノードで「意味的幅」を暗黙表現（仮想セントロイド不要）
- 活性が不足する場合は padding ノード追加を検討

**ベクトル**: origin ノードのベクトルをそのまま使用。
ノードは embedding 空間で不動のため、仮想セントロイドとの差は小さい。
meta-world の search radius / hardness 緩和で吸収可能。

**vs ベクトル DB ネイティブ KNN**:
| | Vector DB KNN | Meta-world |
|---|---|---|
| 入力 | 生チャンク（ノイズ含む） | フィルタ済みクラスタ（証明された知識） |
| 比較単位 | 個別チャンク | 知識クラスタ（複数チャンクの凝縮） |
| 関係の種類 | cosine スコア（数値1つ） | signal/merge/survive の動的相互作用 |
| ノイズ耐性 | なし（ノイズ同士もマッチ） | 1st pass で除去済み |
| 関係の質 | 「近い」のみ | merged=同じ話 / resonant=関連 / loner=ユニーク |

**出力と閲覧レイヤー連携（回り込み提示）**:
- meta-world の結果を metaCluster として保存
- 各 metaCluster に参加クラスタの sourceId + clusterSeq + relation を記録
- digest 閲覧時に links フィールドで関連クラスタへの動線を提供:
  `A ←metaCluster→ B ←metaCluster→ D`
- エージェントが File A を見ている時、自動的に File B の関連クラスタを発見可能
- **推薦システム不要** — 生態系ダイナミクスの結果そのものが推薦になる

**規模見積もり**:
1ファイルあたり anchor 2-3 + cluster pairs 4-6 = 6-9 ノード。
5ファイルで 30-45 ノード → SLOT_CAPACITY=100 なら十分な密度。

**セマンティックタグの活用**:
meta-world ノードに元クラスタのタグ情報を付与すれば、
タグベースのクラスタリング精度向上も期待できる。

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
Phase 2b (アクセス)   ✅ 完了 — MCP server (mycelium_filter / mycelium_status)
Phase F0 (燃料注入口) ✅ 完了 — weight→w 変換 + pointId 配管 + REPORT_DIR opt-in
Phase F1 (燃料解決)   ✅ 完了 — myceliumMetrics → w/h/d バイアス（NutritionResolver）
Phase F2 (利用シグナル) ✅ 完了 — engram 側実装（/mycelium/report + hits/reads push + EMA decay）
Phase F3 (監査/評価)  ✅ 完了 — FUEL_OFF / AUDIT_AB 監査 + consensus 燃料ゲート、初回 A/B 実測済み
Phase 3  (engram)     ✅ 完了 — engram/mcp-server 側にキャッシュゲート+push、EXCLUDE_TAGS 除外フック
Phase 4  (実験)       ← 次手。Phase 1/1b の制御基盤があると効率的。4a は F1-F3 の結果次第で再評価
Phase 5  (LLM)        ← Phase 2b + Phase 4c の知見に依存
```

**Phase F と Phase 4a の関係**: 4a の learnedDelta 引継ぎは「セッション内の反復選択圧」、
燃料ループは「run を跨ぐ永続的な品質勾配」で、同じ問題（歴史を次の run に運ぶ）への
別解。F1-F3 で燃料が機能すれば 4a の実験価値は下がる可能性があるため、
4a 着手は F3 の A/B 評価後に判断する。

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
