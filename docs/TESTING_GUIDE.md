# Mycelium — Testing Guide

## テストツール

### scripts/analyze.cjs
単一コロニーの行動分析。現在のQdrantコレクションの状態をスナップショットし、1tick分の行動を読み取り専用でシミュレートする。

```bash
node scripts/analyze.cjs
```

**出力:**
- ACTION DISTRIBUTION BY SPECIES — 種族ごとのアクション選択分布
- ACTION COSTS — アクション別の平均エネルギーコスト
- REACTION DISTRIBUTION — リアクション分布と平均コスト
- CROSS-SPECIES INTERACTION MATRIX — 種間相互作用パターン
- H/W/TTL DISTRIBUTION — ノード状態のバケット分布
- HACK CHECK — 異常行動の検出（高h survive、モノカルチャー、枯渇状態での高コストアクション）
- ENERGY BUDGET — 全体のエネルギー収支（action cost + reaction cost + hCooling vs survive recovery）

**用途:** パラメータ調整前後の行動パターン比較、ハック的動作の検出

### scripts/scenario-test.cjs (v1: シナリオ A-D)
シナリオベースのテスト。環境条件を段階的に変化させ、種族の適応を検証する。

```bash
node scripts/scenario-test.cjs              # プレーン（δ=0）
node scripts/scenario-test.cjs --snapshot   # 最新スナップショットをロード
```

| ID | Name | Pattern |
|----|------|---------|
| A | Warm → Cold | hCooling 0.99→0.90 linear ramp |
| B | Cold → Warm | hCooling 0.90→0.99 linear ramp |
| C | Stable + Inject | Stable, tick 30 で新 node 注入 |
| D | Warm → Cold + Inject | A + C の組み合わせ |

**Tick logic:** Phase 2.1（resonance decay, proximity merge, spawn, mergeCtx 対応済み — 2026-03-07 更新）

### scripts/scenario-test-v2.cjs (v2: シナリオ E-I)
より極端な環境変動シナリオ。

```bash
node scripts/scenario-test-v2.cjs
node scripts/scenario-test-v2.cjs --snapshot
```

| ID | Name | Pattern |
|----|------|---------|
| E | Plague | tick 25 で ttlStep 急増→回復 |
| F | Oscillation | hCooling を sin 波で振動 |
| G | Famine | surviveHRecovery を段階的に削減 |
| H | Boom → Bust | initialH 急増→急落 |
| I | Gradient | deathMinW を段階的に引き上げ |

**Tick logic:** Phase 2.1（同上、2026-03-07 更新）

### scripts/parallel-scenario.cjs
blendMode（same vs cross）の並列比較テスト。同一 seed を2群に複製し、spawn 時の blendMode のみ変えて比較する。

```bash
node scripts/parallel-scenario.cjs
```

**Tick logic:** Phase 2.1。Qdrant 書き戻しなし（in-memory のみ）。

### scripts/hybrid-blend.cjs
blendMode の SAME→CROSS 切替テスト。同一 seed から3群を複製し、A) SAME-only, B) CROSS-only, C) HYBRID (SAME→CROSS) を並列比較する。

```bash
# デフォルト: 120 ticks, tick 40 で切替
node scripts/hybrid-blend.cjs

# カスタム: 80 ticks, tick 30 で切替
TICKS=80 SWITCH_TICK=30 node scripts/hybrid-blend.cjs
```

**ENV:**
- `TICKS` — 総 tick 数（default: 120）
- `SWITCH_TICK` — SAME→CROSS 切替 tick（default: 40）
- `DIGEST_INTERVAL` — digestor 間隔（default: metabolism.json から）

**Tick logic:** Phase 2.1。Qdrant 書き戻しなし（in-memory のみ）。

**設計意図:** SAME で種族特徴を熟成させてから CROSS で多様性を導入する戦略の検証。SWITCH_TICK の最適値を探る。

### scripts/semantic-filter-test.cjs
Pushback 3軸フィルタのN周コンセンサステスト。engram から全ノードを読み込み、N回のシミュレーションを実行して majority 投票で安定した結果を抽出する。

```bash
# デフォルト: 10周, 50 ticks, majority 4 (40%)
node scripts/semantic-filter-test.cjs

# カスタム: 3周, majority 2, dry run
RUNS=3 TICKS=50 MAJORITY=2 DRY_RUN=true node scripts/semantic-filter-test.cjs
```

**ENV:**
- `RUNS` — シミュレーション周回数（default: 10）
- `TICKS` — 各周の tick 数（default: 50）
- `MAJORITY` — コンセンサス閾値（default: ceil(RUNS*0.4)）
- `DRY_RUN` — `true` で engram への書き込みを抑制（default: true）
- `EARLY_TICK` — loner 判定の早期死亡閾値（default: 10）
- `COSINE_THRESHOLD` — merge redundant 判定の cosine 閾値（default: 0.90）
- `ISOLATION_THRESHOLD` — loner 判定の socialHits 上限（default: 3）
- `DIGEST_INTERVAL` — digestor 間隔（default: metabolism.json から）

**3軸フィルタ:**
1. **Pure survivors** — absorbedCount=0, not spawned, majority 合意 → ユニーク知識（昇格候補）
2. **Loner (孤立死)** — decay 死 + socialHits <= ISOLATION_THRESHOLD, majority 合意 → 無関連ゴミ（redundant フラグ）
3. **Merger (クラスタ)** — w >= W_THRESHOLD(0.5) + depth-1 absorbed <= MAX_D1(6), majority 合意 → クラスタ候補メタデータ

**出力:**
- 各周のサマリ（alive, pure, merger, loner, avgHits, species分布）
- コンセンサス結果（majority フィルタ通過ノード一覧）
- merger cluster 詳細（origin + member engram IDs, species, w, clusterSize）
- `DRY_RUN=false` で loner を engram に redundant フラグ送信

**Tick logic:** Phase 2.1。Qdrant 書き戻しなし（in-memory のみ）。

**検証結果 (10周, 50tick, majority>=6):**
- Pure: 4/104 — anchor gotcha 2 (9/10, 8/10) + herald 2 (7/10, 6/10)
- Loner: 2/104 — train-species EN/JP 重複ペア
- Merger: 4/104 — **全て anchor species** (Docker系, Node/TS系, HTTP infra x2)

**重要知見:** merger が全て anchor — TTL 長寿 + 低 decay が吸収時間を確保。種族特性がクラスタ形成能力に直結。depth-1 のみ価値ある統合、depth-2+ は汚染源。

### scripts/parallel-test.cjs
複数のmetabolism設定を並列で比較テスト。各パタンは独立したQdrantコレクションを使う。

**Tick logic:** **Phase 2.0（旧）** — resonance リセット、spawn なし、mergeCtx なし。要更新。

```bash
node scripts/parallel-test.cjs
```

**出力:**
- 各パタンのtimeline（人口推移、平均h/w、survive/social比率）
- 比較テーブル（人口、avgW の推移比較）

**カスタマイズ:** `runExperiment()` のoverridesを変更してパラメータを差し替える。

```js
// 例: 4パタン並列
const [tA1, tA2, tB1, tB2] = await Promise.all([
  runExperiment("A-1", "mycelium_test_a1", { "birth.initialW": 1.0, "relief.surviveWRecovery": 0 }, TICKS),
  runExperiment("A-2", "mycelium_test_a2", { "birth.initialW": 1.0, "relief.surviveWRecovery": 0.02 }, TICKS),
  // ...
]);
```

**overridesのキー形式:** `"section.key"` — metabolism.jsonのドット区切りパス

### scripts/train-species.cjs
種族の学習デルタ（learnedDelta + learnedResonanceDelta）を蓄積するバッチ訓練スクリプト。

```bash
# デフォルト: 100バッチ × 80 ticks
node scripts/train-species.cjs

# カスタム: 200バッチ × 100 ticks
node scripts/train-species.cjs 200 100
```

**ENV:**
- `BATCHES` — バッチ数（default: 100、argv[2] でも指定可）
- `TICKS` — 各バッチの tick 数（default: 80、argv[3] でも指定可）
- `DIGEST_INTERVAL` — digestor 間隔（default: 20）
- `BLEND_ALPHA` — species δ vs global δ のブレンド比（default: metabolism.json から）
- `DELTA_DECAY` — δ の指数減衰率（default: metabolism.json から）

**出力:**
- 10バッチごとの進捗（surv/10, 種族別 max|δ|）
- 最終統計: 種族別 survivals / avgFitness / maxAbsDelta / Top-3 δ cells
- `data/species-weights.json` を更新（delta + runningDelta + resonanceDelta）
- `data/snapshots/species-weights-<timestamp>.json` を自動保存

**二層学習:**
- **Layer 1: personality δ** — 行動選択の学習（9行動×4感情）
- **Layer 2: resonanceDelta** — 種族間 resonance 感度の学習（5種族×5種族）
- resonanceDelta は `resonanceReceiveScale` で種族別に lr を調整（anchor=0.3 で dampened）

**Tick logic:** Phase 2.1（resonance decay, proximity merge, spawn, mergeCtx 対応済み — 2026-03-09 更新）

**設計:**
- anchor は偶数バッチのみ seed（δ飽和済みのため奇数バッチは除外）
- 10バッチごとに running δ を中間更新（バッチ間で学習を伝搬）
- greedy nearest-neighbor ターゲット選択（tick.ts の softmax とは意図的に異なる）

### scripts/single-run.cjs
単発の tick シミュレーション実行。個別ノードの挙動確認やデバッグに使う。

**Tick logic:** Phase 2.1。Qdrant への書き戻しあり（survivors を mycelium コレクションに upsert）。

## Universal Loader テスト

### 基本コマンド

```bash
# ビルド必須
npm run build

# 1ファイル単体テスト（推奨）
SOURCE_COLLECTIONS=source_patent_8 \
CONSENSUS_RUNS=10 \
CONSENSUS_JITTER=0.1 \
TARGET_TICKS=60 \
FILTER_HARDNESS=mid \
CLEAN_WORLDS=true \
npx tsx src/loader/main.ts > result.json 2> result.log
```

stdout に JSON、stderr にログが出力される。`> result.json 2> result.log` で必ず分離すること。混ぜると JSON が壊れる。

### 重要: 1ファイル = 1 mycelium

**異なるファイル（sourceId）のデータを同一 mycelium に混在させてはならない。**

- Mycelium はファイル内の情報密度を評価する装置
- 異なるファイルのセマンティクスが混ざるとフィルタリング精度が落ちる
- `slot-allocator` は sourceId 単位でスロットを割り当てる（1 source = 1 slot）
- 複数ソースを `SOURCE_COLLECTIONS` に指定した場合、各 sourceId が独立スロットとして直列実行される

```bash
# 10 sourceId → 10 スロット × 直列実行（各スロット独立 mycelium）
SOURCE_COLLECTIONS=source_patent npx tsx src/loader/main.ts

# 1 sourceId だけテストしたい場合は専用コレクションを用意する
# （source_patent の sourceId=8 だけ抽出した source_patent_8 など）
```

### テスト用コレクションの準備

Qdrant に 1 sourceId 分だけのコレクションを手動作成する場合:

```bash
# 1. 元コレクションの sourceId 分布を確認
curl -s -X POST http://localhost:6334/collections/source_patent/points/scroll \
  -H "Content-Type: application/json" \
  -d '{"limit": 500, "with_payload": true, "with_vector": false}' \
  | node -e "..." # sourceId ごとの chunk 数を集計

# 2. 特定 sourceId のポイントを抽出して新コレクションに upsert
#    （with_vector: true で取得し、PUT /collections/{name} → PUT /points）
```

### ENV 一覧

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `SOURCE_COLLECTIONS` | `source` | カンマ区切りのソースコレクション名 |
| `CONSENSUS_RUNS` | `10` | コンセンサス投票の周回数 |
| `CONSENSUS_THRESHOLD` | `0.4` | 安定判定の最低投票率 |
| `CONSENSUS_JITTER` | `0.1` | 初期 w/h の ±揺らぎ幅（0.1 = ±10%） |
| `TARGET_TICKS` | `60` | 各 run の tick 数 |
| `FILTER_HARDNESS` | `mid` | `soft`/`mid`/`hard` — harvest タイミングを制御 |
| `CLEAN_WORLDS` | `false` | `true` で mycelium コレクションを毎回再作成 |
| `PARALLEL_SLOTS` | `3` | 同時実行スロット数（p-limit 方式、空いたら次を投入） |
| `TICK_INTERVAL_MS` | `0` | tick 間の待機（ms）— デフォルト 0（全速）。本番で Qdrant 負荷を抑えたい場合のみ設定 |
| `ISOLATION` | `shared` | `shared`/`domain`/`custom` — world 分離モード |
| `REPORT_DIR` | `data/reports` | レポート JSON の保存先 |

### 実行時間の目安

consensus 10 run × 60 ticks × 1 ソース（61 chunks）で約 10 分。
チャンク数に比例し、consensus runs にも線形で伸びる。

### フォーマッタの確認

レポート保存後、フォーマッタで出力を確認できる:

```bash
cat > _test_fmt.ts << 'SCRIPT'
import { readFileSync, writeFileSync } from "fs";
import { formatReports } from "./src/output/formatters.js";
const report = JSON.parse(readFileSync("data/reports/<filename>.json", "utf8"));
writeFileSync("_compact.txt", formatReports(report, { format: "compact" }), "utf8");
writeFileSync("_detailed.txt", formatReports(report, { format: "detailed", sampleLimit: 2 }), "utf8");
console.error("done");
SCRIPT
npx tsx _test_fmt.ts
```

3 モード: `compact`（LLM 向け最小）、`detailed`（人間精査用）、`structured`（JSON）

### 結果の読み方

- **survivalRate**: harvest 時点（mid=60%=tick 36）の生存率。全 tick 終了時ではない
- **consensusRate**: 10 run 中 threshold 以上で同じ分類が安定した chunk の割合。100% 未満の source は jitter で揺れた = 境界線上のチャンクが多い
- **3 軸分類**: pure（ユニーク生存）、merged（クラスタ統合）、loner（孤立死）、redundant（冗長）、dead（自然死）
- **species**: summarizer/sentinel/herald/anchor/spore の分布。偏りが大きすぎる場合は種族ローテーションに問題がある可能性

### 踏みやすい罠

1. **stdout/stderr 混在**: `> file 2>&1` は厳禁。JSON が壊れる。必ず `> out.json 2> out.log` で分離
2. **CLEAN_WORLDS=true 忘れ**: 前回の mycelium コレクションが残っていると ensureCollection が既存を再利用し、前回のノードが混入する可能性
3. **ファイル混在**: 複数 sourceId を同一 mycelium に投入すると意味が混ざる。常に 1 sourceId = 1 mycelium
4. **jitter=0 での consensus 100%**: 初期条件が完全同一 → 乱数源は softmax のみ → ほぼ同じ結果 → 偽の高 consensus。必ず jitter > 0 で実行
5. **大量 source の実行時間**: source_patent（10 sourceId × 10 runs）は数十分かかる。バックグラウンド実行推奨

## Tick Logic Versions

### Phase 2.0 (旧)
- Resonance: 毎 tick `zeroResonance()` でリセット
- Merge: action 選択のみ（proximity trigger なし）
- `react()`: `mergeCtx` 引数なし
- Spawn: なし
- Species: 4種（summarizer, sentinel, herald, spore）

### Phase 2.1 (現行)
- Resonance: decay carry-over（`resonanceDecay * 前tick値`、デフォルト 0.95）
- Proximity merge: similarity ≥ 0.85 で 30% の確率で merge に override
- `react()`: `mergeCtx: { similarity }` を渡す（similarity-gated acceptance）
- Spawn: 4-gate eligibility → 2親消費 → 2子生成
  - contents ≥ 3, fitness ≥ 0.3, positiveResonance ≥ 0.15, partnerSimilarity ≥ 0.5
- Species: 5種（summarizer, sentinel, herald, anchor, spore）— `ALL_SPECIES` を使用
- 二層学習（2026-03-09 追加）:
  - Layer 1: `learnedDelta` — personality δ（行動選択の学習）
  - Layer 2: `learnedResonanceDelta` — resonance sensitivity δ（知覚感度の学習）
  - `computeFeelings` で `effective = baseSensitivity * (1 + learnedResonanceDelta[sp])` として適用
  - Digestor Pass 3 で survivors の平均 resonance → tanh → cross-species blend → clamp で学習
  - `resonanceReceiveScale` で種族別に学習率を調整（anchor=0.3 で dampened）

### Phase 2.0 → 2.1 更新チェックリスト
旧ロジックスクリプトを更新する際の変更項目：

1. `require("../dist/core/spawn.js")` の追加（isSpawnEligible, isCompatiblePartner, executeSpawn）
2. Resonance: `nv.node.resonance = zeroResonance()` → decay loop に変更
3. Proximity merge trigger ブロック追加（action 選択後、interaction 前）
4. `react()` に `mergeCtx` 引数追加
5. Spawn phase 追加（action phase 後、decay phase 前）
6. Species リストを `ALL_SPECIES`（5種）に変更
7. 出力フォーマットに `spn` 列追加

## スナップショット運用

### 概要

種族メモリ（learnedDelta + learnedResonanceDelta）はファイルベースで永続化される。Qdrant には保存しない。
δ なし（プレーン）とδ あり（スナップショット）で行動パターンが大きく異なるため、目的に応じて使い分ける。

スナップショットには2層のδを含む:
- **`delta`** — personality δ（9行動×4感情の WeightMatrix）
- **`resonanceDelta`** — resonance sensitivity δ（5種族×5種族の感度調整）

### ファイル構成

```
data/
  species-weights.json                          ← train-species.cjs の最新出力（mutable）
  snapshots/
    species-weights-baseline-20260307.json       ← 手動で固定した初期ベースライン
    species-weights-20260307T153247.json          ← digestor.persist() が自動保存（タイムスタンプ付き）
    species-weights-20260308T091500.json          ← ...蓄積される
```

- `digestor.persist(config)` 呼び出し時に `data/snapshots/species-weights-<timestamp>.json` を保存
- `train-species.cjs` は追加で `data/species-weights.json` も更新
- `data/snapshots/` 配下のファイルは追記のみ（上書きしない）
- `baseline` 付きファイルは手動で作成した固定ベースライン

### speciesMemory 設定（types.ts: MyceliumConfig）

本番の digestor は `MyceliumConfig.speciesMemory` でロードモードを制御する:

| モード | 値 | 動作 |
|--------|---|------|
| 最新 | `"latest"` (デフォルト) | `snapshotDir` 内のファイル名ソートで最新を自動ロード |
| なし | `"none"` | δ=0 で開始（学習なし） |
| ファイル指定 | `"./data/snapshots/species-weights-xxx.json"` | 指定パスから直接ロード |

```typescript
// types.ts
export interface MyceliumConfig {
  // ...
  speciesMemory: "latest" | "none" | string;
  snapshotDir: string;  // default: "./data/snapshots"
}
```

digestor の `load()` / `persist()` は同期（sync）。Qdrant アクセスは一切しない。

### テストスクリプトの使い方

テストスクリプト（`scenario-test.cjs`, `scenario-test-v2.cjs`, `parallel-test.cjs`）は共通の `--snapshot` オプションを持つ。

```bash
# プレーン（δ=0 からスタート、比較用ベンチマーク）
node scripts/scenario-test.cjs

# 最新のスナップショットをロード（ファイル名ソートで最後）
node scripts/scenario-test.cjs --snapshot
node scripts/scenario-test.cjs --snapshot latest

# 特定のスナップショットを指定
node scripts/scenario-test.cjs --snapshot ./data/snapshots/species-weights-20260307T153247.json
```

### 使い分けの指針

| 目的 | コマンド | 理由 |
|------|---------|------|
| パラメータ調整の効果測定 | `--snapshot` なし（プレーン） | δ の影響を排除して純粋なパラメータ差を見る |
| 本番挙動の再現 | `--snapshot` または `--snapshot latest` | 実運用に近い条件でテスト |
| 特定時点の再現 | `--snapshot <path>` | 回帰テスト、特定の訓練結果との比較 |
| 訓練前後の比較 | プレーン → `--snapshot` の順で実行 | δ の効果を定量比較 |

### 訓練→テストの標準フロー

```
1. node scripts/train-species.cjs [BATCHES] [TICKS]
   → data/species-weights.json 更新
   → data/snapshots/species-weights-<timestamp>.json 自動保存

2. node scripts/scenario-test.cjs --snapshot latest
   → 今の訓練結果でテスト

3. node scripts/scenario-test.cjs
   → プレーンと比較して δ の効果を確認

4. 結果が良ければ baseline として固定:
   cp data/snapshots/species-weights-<timestamp>.json \
      data/snapshots/species-weights-baseline-<date>.json
```

### 汚染対策

- **metabolism.json のパラメータ変更時**: `data/species-weights.json` は汚染される可能性がある。テストは必ず `--snapshot` で固定スナップショットを指定する
- **本番ロードモード**: `MyceliumConfig.speciesMemory` がデフォルト `"latest"` なので、`snapshotDir` 内の最新ファイルが自動ロードされる。汚染された weight を避けるには `"none"` か固定パスを指定
- **訓練とテストを混ぜない**: パラメータを変更したら、まずプレーンでテスト → 問題なければ訓練 → スナップショット保存の順

## 未更新スクリプト一覧

| Script | 状態 | 必要な作業 |
|--------|------|-----------|
| `parallel-test.cjs` | Phase 2.0 | Tick logic 全面更新 |
| `analyze.cjs` | N/A (静的) | neighborSpecies に anchor 追加 |

## 注意事項（踏んだ罠）

### 1. Qdrant の write は非同期
`upsertPoints`, `deletePoints`, `setPayload` は `?wait=true` なしだと非同期。upsert直後の `scrollAll` が空を返す。

**対処:** qdrant.ts の全mutation endpointに `?wait=true` を追加済み（2026-03-06）。テストスクリプト内で直接fetchする場合も同様に付けること。

### 2. resolveInteraction 内の reaction cost 二重適用
`resolveInteraction()` 内部で target の reaction cost を適用している。テストスクリプトの `runTickLocal` で手動適用すると二重消費 → 即全滅。

**対処:** テストスクリプト内では reaction cost を手動適用しない。`resolveInteraction()` に任せる。

### 3. ESMプロジェクトでの .cjs
package.json に `"type": "module"` があるため、`require()` を使うスクリプトは `.cjs` 拡張子が必要。

### 4. engram feeder の重複ingestion
feeder は `lastPollTimestamp` でフィルタするが、サーバー再起動で 0 にリセットされる。テスト時に毎回 engram の全ノードを再取り込みする。並列テストでは `seedFromEngram()` で直接 engram を読んで seed するため影響なし。

### 5. 並列テストのコレクション分離
各パタンは `mycelium_test_a1`, `mycelium_test_b2` 等の独立コレクションを使う。テスト終了時に自動cleanup。本番コレクション `mycelium` には触らない。

### 6. anchor personality と softmax の罠（解決済み）
personality weight が 0 でも softmax は `exp(0/temp) > 0` の確率を割り当てる。anchor の merge/signal 行が 0 だと survive 29% まで低下し merge で自滅していた。**対処:** 抑制したい行は `-0.5` の負の値を設定。結果: survive 86%, merge 0%, accept 82%（target 時）。また、テストスクリプトで species round-robin 上書き時に personality を再適用していないバグがあった（2026-03-07 修正済み）。

### 7. 旧ロジックスクリプトとの結果混同
`parallel-test.cjs` は Phase 2.0 のまま。spawn なし、resonance リセット、mergeCtx なし。Phase 2.1 スクリプトの結果と直接比較しないこと。

### 8. single-run の書き戻し
`single-run.cjs` は終了時に survivors を mycelium コレクションに upsert する。連続実行すると前回の survivors が残る（スクリプト冒頭で clear して engram から再 seed する）。

### 9. parallel-scenario の blendMode hack
`parallel-scenario.cjs` は `M.spawn.blendMode` をグローバルに書き換えて復元する方式。将来 metabolism.json を freeze する場合は要修正。

### 10. 乱数の非決定性
spawn eligible 判定、proximity merge trigger、species 継承はすべて `Math.random()` 依存。同じパラメータでも結果が毎回変わる。重要な比較は複数回実行して傾向を見る。

### 11. semantic-filter-test の majority 閾値
N周コンセンサスの majority 閾値が低すぎると確率的揺らぎを拾う。10周なら majority>=6 が安定ライン。merge-redundant（単体）は cosine-gated early merge の確率的揺らぎが大きく合意に達しないため不採用。

### 12. merge depth と汚染
`»` プリフィックスで merge 深度を追跡（depth = `»` の数）。depth-1 は意味のある統合だが、depth-2+ はキーワード衝突による汚染源（例: "sentinel" が mycelium 種族と Redis sentinel の両方にマッチ）。merger cluster 抽出は depth-1 のみをフィルタする。

## テスト実行フロー

```
1. npm run build              — TypeScript をコンパイル
2. node scripts/analyze.cjs   — 現状分析（任意）
3. parallel-test.cjs を編集    — テストしたいパラメータを設定
4. node scripts/parallel-test.cjs — 並列実行
5. 結果の比較テーブルから最良パタンを選択
6. metabolism.json に反映
7. npm run build
8. node scripts/analyze.cjs   — 反映後の確認
```

## これまでのテスト結果サマリ

### hCooling テスト (2026-03-06)
| パタン | hCooling | tick 30 pop | tick 50 pop |
|--------|----------|-------------|-------------|
| A | 0.97 | 12 | 2 |
| B | 0.98 | 5 | 2 |

**結論:** 0.97 の方が安定。0.98 は活発すぎて merge 消滅が増える。

### W exploration テスト (2026-03-06)
| パタン | initialW | wRecovery | tick 30 | tick 50 | tick 60 |
|--------|----------|-----------|---------|---------|---------|
| A-1 | 1.0 | 0 | 8 | EXTINCT(43) | - |
| A-2 | 1.0 | 0.02 | 15 | 4 | 4 |
| B-1 | 1.5 | 0 | 13 | 4 | 1 |
| B-2 | 1.5 | 0.02 | 21 | 4 | 1 |

**結論:** `surviveWRecovery=0.02` が最重要。初期バッファ(initialW)より回復手段の有無が決定的。
**注:** 現在は `surviveWRecovery=0` に戻した（外部栄養前提の closed w economy 設計）。

### 種族チューニング (2026-03-07)

#### 変更点
- **anchor**: receptivity 0.1→0.2、resonanceSensitivity herald/spore のマイナス値を 0.0 に、perception kinship 感度上昇、bequeath 傾向強化、reject/retaliate 傾向低下
- **sentinel**: receptivity 0.2→0.25、retaliate dread 0.6→0.4（自滅抑制）、accept dread 0.0→0.1（危機時受容）
- **学習パラメータ**: rate 0.03→0.05、deltaClamp 0.3→0.5

#### シナリオテスト 5× 結果
| 種族 | Plain 生存 | Snapshot 生存 |
|------|-----------|-------------|
| summarizer | 3 | 5 |
| sentinel | 14 | 8 |
| herald | 8 | 10 |
| spore | 9 | 11 |
| **total** | **34** | **34** |

**結論:**
- sentinel がチューニング前の 0 生存から 14 生存に大幅改善（retaliate 自滅の解消）
- 全4種族が生存するバランスを達成（anchor は TTL=500 で別枠、テスト range 外で安定）
- herald 一強が解消され種族多様性が向上
- スナップショット（学習済みδ）はさらに種族分布を均等化

### anchor personality 修正 + personality bug 修正 (2026-03-07)

#### 変更点
- **anchor personality**: signal/merge/bequeath/reject/retaliate/flee 行を `-0.5` に（softmax 抑制）
- **テストスクリプト**: species round-robin 上書き時に personality/decay/ttl を species.json から再適用（全4スクリプト修正）

#### 通しテスト結果
| Script | 結果 |
|--------|------|
| single-run (80t) | 11 alive, anchor 8体 (73%), spawn gen 11 |
| v1-A Warm→Cold | 8 alive, anchor 8, drift 0.032 |
| v1-B Cold→Warm | 7 alive, anchor 6, drift 0.013 |
| v1-C Stable+Inject | 12 alive, anchor 8, drift **0.084** |
| v1-D Warm→Cold+Inject | 10 alive, anchor 7, drift 0.020 |
| v2-E Plague | 2 alive, anchor 0, drift 0.010 |
| v2-F Oscillation | 8 alive, anchor 8, drift 0.017 |
| v2-G Famine | 5 alive, anchor 5, drift 0.010 |
| v2-H Boom→Bust | 13 alive, anchor 13, drift **0.026** |
| v2-I Gradient | 1 alive, anchor 0, drift **0.044** |
| parallel SAME | 13 alive, anchor 7, gen 4 |
| parallel CROSS | 11 alive, anchor 4, gen **17** |

**結論:** anchor drift が 0→0.01-0.08 に改善。anchor は全シナリオで survive-only + accept-dominant として安定動作。CROSS blendMode は世代が深い（gen 17 vs 4）が人口はやや少ない。

### SAME ベースライン + Hybrid Blend テスト (2026-03-07)

#### SAME ベースライン (single-run x3, 80 ticks)
| | P1 | P2 | P3 | avg |
|---|---|---|---|---|
| final pop | 10 | 8 | 8 | **8.7** |
| survivors | anchor 9, herald 1 | anchor 8 | anchor 5, herald 2, spore 1 | anchor dominant |
| max gen | 4 | 9 | 5 | 6.0 |
| avgW @80 | 0.775 | 0.912 | 0.655 | 0.781 |
| anchor drift | 0.062 | 0.020 | 0.040 | 0.041 |

#### parallel-scenario SAME vs CROSS (80 ticks)
| | SAME | CROSS | delta |
|---|---|---|---|
| final pop | 6 | 10 | +4 |
| max gen | 0 | 1 | +1 |
| avgW | 0.944 | 0.790 | -0.154 |
| survivors | anchor 6 | anchor 9, sentinel 1 | CROSS +多様性 |

#### Hybrid Blend (120 ticks, switch at tick 40)
| tick | SAME pop | CROSS pop | HYBRID pop | note |
|------|----------|-----------|------------|------|
| 20 | 39 | 49 | 34 | 熟成フェーズ中盤 |
| **40** | **19** | **19** | **17** | **SWITCH POINT** |
| 60 | 11 | 13 | 11 | CROSS フェーズ |
| 80 | 9 | 6 | 8 | CROSS 先に減少 |
| 120 | **6** | **1** | **7** | HYBRID 最多生存 |

**結論:**
- HYBRID (pop=7) > SAME (pop=6) > CROSS (pop=1) — HYBRID が最も安定
- CROSS-only は 120 ticks でほぼ絶滅。多様性は出るが長期安定性が低い
- tick 40 が切替適正値: pop 17-19、anchor 優勢確立後で種族特徴が固まった直後
- SAME 期間で熟成した personality traits が CROSS 切替後も安定性の基盤になる

### 共通観察
- w は外部栄養（engram feeder からの注入）前提の closed economy。内部だけでは w は生成されない
- anchor は不動のシステムコア（TTL=500, decay=0.01）。survive-only initiator, accept-dominant target。personality に負の weight を使って不要な行動を抑制
- 人口崩壊は spawn（Phase 2.1）で対処済み。シナリオ H（Boom→Bust）で spawn による人口回復を確認

### Pushback 3軸フィルタ検証 (2026-03-08)

#### 概要
engram → mycelium 変換後の生態系シミュレーションで、ノードの価値を3軸で分類する pushback パイプライン。

#### パラメータ
| パラメータ | 値 | 意味 |
|-----------|---|------|
| RUNS | 10 | シミュレーション周回数 |
| TICKS | 50 | 各周の tick 数 |
| MAJORITY | 6 | コンセンサス閾値 (6/10) |
| W_THRESHOLD | 0.5 | merger 判定の最低 w |
| MAX_D1 | 6 | merger の最大 depth-1 吸収数 |
| ISOLATION_THRESHOLD | 3 | loner 判定の socialHits 上限 |

#### 結果
| 軸 | 件数/全体 | 内容 |
|----|----------|------|
| Pure survivors | 4/104 | anchor gotcha x2 (9/10, 8/10), herald x2 (7/10, 6/10) |
| Loner (孤立死) | 2/104 | train-species EN/JP 重複ペア |
| Merger (クラスタ) | 4/104 | 全て anchor — Docker系, Node/TS系, HTTP infra x2 |

#### Merge depth 分布 (50 ticks)
| depth | 件数 |
|-------|------|
| d1 | 72 |
| d2 | 44 |
| d3 | 22 |
| d4 | 2 |

**結論:**
- anchor species がクラスタ形成を独占 — TTL 長寿 + 低 decay が吸収時間を確保
- depth-1 のみが意味のある統合、depth-2+ はキーワード衝突による汚染
- loner 検出は EN/JP 重複ペアを正しく検出 — 孤立死 + 低 socialHits の組み合わせが有効
- merge-redundant（単体）は確率的揺らぎが大きく不採用
- 実装: `src/core/pushback.ts` (extractPureSurvivors, extractMergerClusters, extractRedundantIds)

### 二層学習 訓練結果 (2026-03-09)

#### 設定
100バッチ × 80 ticks, blendAlpha=0.7, lr=0.05, deltaClamp=0.5

#### 生存統計
| 種族 | survivals | avgFitness | maxAbsDelta |
|------|-----------|------------|-------------|
| summarizer | 13 | 0.699 | 0.0897 |
| sentinel | 11 | 0.398 | 0.0516 |
| herald | 16 | 0.528 | 0.0700 |
| anchor | 258 | 1.041 | 0.1952 |
| spore | 3 | 0.978 | 0.1250 |

#### Top-3 δ cells
- **summarizer**: merge×kinship=-0.090, merge×vigor=-0.068, survive×kinship=-0.042
- **sentinel**: merge×kinship=-0.052, flee×kinship=-0.031, retaliate×kinship=-0.027
- **herald**: merge×kinship=-0.070, accept×kinship=+0.039, merge×vigor=-0.031
- **anchor**: flee×kinship=-0.195, retaliate×kinship=-0.184, merge×kinship=-0.180
- **spore**: merge×kinship=-0.125, merge×vigor=-0.074, accept×kinship=+0.064

#### resonanceDelta（注目値）
| 種族 | 対自種 | 特記 |
|------|--------|------|
| herald | -0.051 | 自種 resonance 感度を最も強く抑制（過剰反応回避） |
| summarizer | -0.024 | 同様の自種抑制傾向 |
| sentinel→herald | -0.018 | herald からの resonance に鈍感化 |
| anchor | 全て 0 | resonanceReceiveScale=0.3 による dampening が有効 |
| spore | 全て 0 | 生存 3 のみで学習機会不足 |

**結論:**
- 全種族で **merge×kinship が最大の負δ** — kin 多い環境での merge 自滅を学習回避
- herald/spore で **accept×kinship が正δ** — 社会性（受容傾向）の発達
- resonanceDelta は herald の自種抑制が最も顕著 — herald 同士の signal 連鎖による過熱を自律的に抑制
- anchor の resonanceDelta=0 は設計通り（不動のシステムコアは感度を変えない）
