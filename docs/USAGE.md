# Mycelium Universal — 利用ガイド

## 概要

Mycelium は生態系シミュレーションによるセマンティック・フィルタリングエンジン。
embedding 済みデータを投入し、tick ベースの生態系で競争・融合・淘汰させることで、
知識の価値を自律的に分類する。

**特徴**:
- Qdrant レスで動作可能（フィルタリングは完全インメモリ）
- 外部 Qdrant から直接読み込み（bridge 不要）
- 外部スコア（weight 等）を初期値に反映
- consensus 投票で再現性を保証
- 出力は digest / manifest / compact / structured / raw JSON

## クイックスタート

### 最小構成（Qdrant レス）

外部サービスの Qdrant から直接フィルタリング:

```bash
npm install && npm run build

SOURCE_QDRANT_URL=http://localhost:6333 \
SOURCE_COLLECTIONS=engram \
VIEW_FORMAT=compact \
npx tsx src/loader/main.ts
```

必要なもの: Node.js >= 18、外部 Qdrant にアクセス可能なこと。
mycelium 専用の Qdrant インスタンスは**不要**。

### 汎用データ（embedding から）

```bash
# 1. データ準備（Docker 経由で embedding + Qdrant 投入）
MSYS_NO_PATHCONV=1 docker run --rm \
  --network mycelium-universal-network \
  -v "$(pwd):/app" -w /app \
  prepare-source \
  python scripts/process_source.py data/raw/my_data.jsonl \
    --chunk-size 100 --collection source_mydata \
    --qdrant-url http://mycelium-universal-qdrant:6333

# 2. フィルタリング実行
SOURCE_COLLECTIONS=source_mydata \
VIEW_FORMAT=digest \
npx tsx src/loader/main.ts
```

---

## アーキテクチャ

```
[外部 Qdrant / JSON]
        ↓ source-scroll (payload 自動正規化)
  slot-allocator (sourceId 単位で分割)
        ↓
  IsolatedRunner × N (並列, in-memory)
    ├─ inject (species 割当, 外部 weight → 初期 w)
    ├─ tick loop (tickCore: 感情→行動→相互作用→淘汰)
    │   └─ digestor (種族学習 delta 蓄積)
    └─ harvest (pushback 3軸分類)
        ↓
  consensus 投票 (N runs の多数決)
        ↓
  SurvivorReport[] → formatters → stdout
```

**フィルタリング処理は完全インメモリ**。Qdrant は入力データの読み込みにのみ使用。

---

## 環境変数

### 入力設定

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `SOURCE_QDRANT_URL` | `QDRANT_URL` の値 | ソースデータの Qdrant URL |
| `QDRANT_URL` | `http://localhost:6334` | mycelium 作業用 Qdrant（CLEAN_WORLDS 用、通常不要） |
| `SOURCE_COLLECTIONS` | `source` | カンマ区切りのコレクション名 |
| `FILTER_SOURCE_IDS` | (全件) | 処理対象の sourceId（例: `8,14,17`） |

### フィルタリング設定

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `TARGET_TICKS` | `60` | tick 数（シミュレーション長） |
| `FILTER_HARDNESS` | `mid` | `soft` / `mid` / `hard` — harvest タイミング |
| `CONSENSUS_RUNS` | `10` | consensus 投票の run 数 |
| `CONSENSUS_THRESHOLD` | `0.4` | 分類安定化の最低投票率 |
| `CONSENSUS_JITTER` | `0.1` | 初期 w/h の ±揺らぎ（外部 weight がある場合は自動スキップ） |
| `SLOT_CAPACITY` | `100` | スロットあたりの最大ノード数 |
| `PARALLEL_SLOTS` | `3` | 並列実行スロット数 |

### 出力設定

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `VIEW_FORMAT` | (raw JSON) | `digest` / `manifest` / `compact` / `detailed` / `structured` |
| `DIGEST_TIERS` | (全 tier) | `meta,pure,clusters` のサブセット |
| `DIGEST_ROLES` | (全 role) | `claim,constraint,foundation,synthesis,hypothesis` |
| `DIGEST_MIN_CLUSTER` | `0` | 最小クラスタサイズ |
| `DIGEST_MAX_PURE` | (無制限) | ソースあたりの最大 pure 数 |
| `DIGEST_MAX_CLUSTERS` | (無制限) | ソースあたりの最大クラスタ数 |

### Cross-File Affinity

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `CROSS_FILE` | `false` | `true` で 2nd pass（ソース間親和性分析）を実行 |
| `CROSS_FILE_CAPACITY` | `300` | 2nd pass の最大ノード数 |

---

## 出力フォーマット

### compact（サマリ1行）

```
Mycelium Filter: 62/91 survived (68.1%) across 1 world(s)
  pure:52 merged:10 loner:7 redundant:7 dead:15
  engram:engram: 20/33 (61%) consensus:94%
  engram:mycelium-universal: 14/14 (100%) consensus:100%
```

### digest（構造化 JSON）

3-tier 構造: meta（統計） + pure（独自知識） + clusters（統合構造）。
AI エージェントが消費しやすい形式。詳細は [DIGEST_FORMAT.md](DIGEST_FORMAT.md)。

### manifest（軽量インデックス）

ソースあたり ~50 tokens。大量ソースのスキャン → 詳細ドリルダウンの2段階パターン用。

---

## 3軸分類（Pushback）

| 分類 | 意味 | 判定基準 |
|------|------|----------|
| **pure** | 独自知識 | 生存 + 未 merge + 他ノードに吸収されていない |
| **merged** | 知識統合 | 生存 + merge で他ノードを吸収（クラスタ中心） |
| **loner** | 孤立 | 早期死亡 + 低 posRes（社会的交流なし） |
| **redundant** | 重複 | 早期 merge + 高 cosine（意味的に他と同じ） |
| **dead** | 淘汰 | 上記に該当しない死亡 |

---

## 外部サービス連携

### 外部 Qdrant から直接読み込み

`SOURCE_QDRANT_URL` で外部 Qdrant を指定。payload の自動正規化:

| 外部フィールド | 正規化先 | 対応例 |
|---------------|---------|--------|
| `summary` + `content` | `text` | engram スキーマ |
| `projectId` | `sourceId` | engram スキーマ |
| `tags` | `tags` | そのまま |
| `weight` | 初期 `w` ([0.3, 1.5] にマッピング) | engram weight |

```bash
# engram の Qdrant から直接フィルタリング
SOURCE_QDRANT_URL=http://localhost:6333 \
SOURCE_COLLECTIONS=engram \
VIEW_FORMAT=digest \
npx tsx src/loader/main.ts
```

### 外部 weight の反映

`payload.weight` が数値の場合、初期 `w` に自動マッピング:

```
[-2, 4] → normalize [0, 1] → scale [0.3, 1.5] × initialW
```

- 低 weight → w=0.3（社会的行動なしだと 60 tick で死亡）
- 高 weight → w=1.5（余裕をもって生存、ただし圧倒的有利にはならない）
- 外部 weight がある場合、consensus jitter は自動スキップ

### payload 最低要件

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `vector` | Yes | embedding ベクトル（384 次元、MiniLM 互換） |
| `text` or `summary` | Yes | テキスト内容（正規化で `text` に変換） |
| `sourceId` or `projectId` | No | ソース識別（なければ point ID を使用） |
| `tags` | No | タグ配列（種族解決に使用） |
| `weight` | No | 外部スコア（初期 w にマッピング） |

---

## Cross-File Affinity（ソース間親和性分析）

1st pass のフィルタ後、生存者を全ソース混合で 2nd pass に投入し、
ソース間の意味的親和性を測定する。

### 仕組み

1. 1st pass の pure + merged + loner を収集
2. 全ノードを **herald**（社交的種族）に変換
3. 1つの大型 slot で tick シミュレーション実行
4. merge / loner / resonance を sourceId ペアで集計

### 出力

- **Affinity Matrix**: sourceId × sourceId の merge 回数 + 平均 cosine
- **Per-source stats**: input / survived / pure / merged / loner / dead / avgResonance
- **Resonance detail**: 生存ノードの種族別 resonance 平均

### 3段階の親和性モデル

| 段階 | 意味 | 検出条件 |
|------|------|---------|
| **merge** | 強い関連（意味的重複） | cosine が近傍内かつ merge 閾値以上 |
| **resonance のみ** | 弱い関連（signal 交流あり） | cosine が近傍に入るが merge には至らない |
| **何もなし** | 無関係 | cosine が近傍の外 |

### 構造的制約

cosine 近傍制約（`neighborLimit=5`）により、同一ソースのノードが近傍を占有しやすい。
異分野の文書間では cross-source merge が起きにくいが、これは正しい挙動
（無関係な文書間に偽の親和性を検出しない）。

同一ドメインの文書セットで最も有効。

```bash
CROSS_FILE=true VIEW_FORMAT=compact \
SOURCE_QDRANT_URL=http://localhost:6333 \
SOURCE_COLLECTIONS=engram \
npx tsx src/loader/main.ts
```

---

## 種族（Species）

| 種族 | 役割 | 社交性 | 特徴 |
|------|------|--------|------|
| anchor | 構造的骨格 | 低 | 長寿、低 decay、merge 対象にされにくい |
| sentinel | 監視・検証 | 中 | エラー/ルール系の知識 |
| herald | 変更伝播 | **高** | signal/merge が活発、cross-file で使用 |
| summarizer | 汎用集約 | 中 | デフォルト種族 |
| spore | 仮説・草案 | 中 | 淘汰されやすい、未検証の知識 |

### merge の方向性

merge accept 時、**w が高い方が absorber（生存）**、低い方が consumed（死亡）。
クラスタ中心は常に「より価値の高いノード」になることが保証される。

---

## 設定ファイル

| ファイル | 説明 |
|---------|------|
| `src/config/metabolism.json` | tick エンジンの全パラメータ |
| `src/config/species.json` | 種族 DNA（perception/personality マトリクス） |
| `src/config/species-mapping.json` | タグ → 種族のマッピングルール |

---

## レガシーコード

以下は Phase 0 時代のコードで、現行パスでは使用されない:

| ファイル | 状態 | 説明 |
|---------|------|------|
| `src/server.ts` | レガシー | MCP Server（手動 tick 操作用） |
| `src/core/tick.ts` | レガシー | spawn → Qdrant upsert を含む旧 tick ラッパー |
| `src/loader/dispatcher.ts` | レガシー | isolated-runner 以前のフロー |

現行の実稼働パス: `loader/main.ts → isolated-runner.ts → tick-core.ts`
