# Mycelium Universal — 利用ガイド

## 概要

Mycelium は生態系シミュレーションを用いた知識フィルタリングシステム。
外部データソース（HuggingFace データセット、engram など）をノードに変換し、tick ベースの生態系で競争・融合・淘汰させることで、知識の価値を自律的に分類する。

## アーキテクチャ

```
[外部データ] → prepare_source.py → [Source Qdrant :6334]
                                         ↓
                                   Cascade Loader (main.ts)
                                     slot-allocator → dispatcher → feed-instance
                                         ↕
                                   [Mycelium Qdrant :6334]  ← tick engine (tick.ts ↔ tick-core.ts)
                                         ↓
                                   SurvivorReport[] (JSON)
```

### コンポーネント

| コンポーネント | 役割 |
|---------------|------|
| `prepare_source.py` | HF データセット → embedding + タグ付与 → Source Qdrant |
| Cascade Loader (`src/loader/`) | Source → スロット分割 → tick シミュレーション → harvest |
| Tick Engine (`src/core/tick.ts`) | ノード間の相互作用・merge・spawn・decay を計算 |
| MCP Server (`src/server.ts`) | MCP プロトコルで push/status/observe/tick/snapshots を提供 |
| Pushback (`src/core/pushback.ts`) | 生存ノードを pure/loner/redundant/merged/dead/partial に分類 |

---

## セットアップ

### 前提条件

- Docker / Docker Compose
- Node.js >= 18
- Python 3.10+（Docker 経由でも可）

### 1. Qdrant 起動

```bash
cd mycelium_universal
docker compose up -d
```

Qdrant は port **6334** (ホスト) → 6333 (コンテナ内) で起動。

> **注意**: engram が port 6333 を使っているため、mycelium は 6334 で分離している。

### 2. ビルド

```bash
npm install
npm run build    # tsc → dist/
```

---

## データ準備 (prepare_source.py)

HuggingFace データセットを Source Qdrant にロードする。

### 基本コマンド

```bash
# 短文データ（チャンクなし）
python scripts/prepare_source.py \
  --dataset "ag_news" \
  --split "train[:200]" \
  --text-field "text" \
  --collection "source_ag_news" \
  --qdrant-url "http://localhost:6334"

# 長文データ（チャンク分割あり）
python scripts/prepare_source.py \
  --dataset "ccdv/arxiv-summarization" \
  --split "train[:5]" \
  --text-field "article" \
  --chunk-size 100 \
  --chunk-overlap 15 \
  --collection "source" \
  --qdrant-url "http://localhost:6334"
```

### Docker 経由（Windows で Python 未インストールの場合）

```bash
docker run --rm \
  --network mycelium-universal-network \
  -v C:/path/to/mycelium_universal/scripts:/app/scripts \
  -w /app \
  python:3.11-slim \
  bash -c "pip install datasets sentence-transformers qdrant-client && \
    python scripts/prepare_source.py \
      --dataset 'ag_news' \
      --split 'train[:200]' \
      --text-field 'text' \
      --collection 'source_ag_news' \
      --qdrant-url 'http://qdrant:6333'"
```

> Docker network 内では `qdrant:6333`、ホストからは `localhost:6334`。

### オプション一覧

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--dataset` | ag_news | HuggingFace データセット名 |
| `--split` | train[:500] | データセット split |
| `--limit` | 0 | 行数制限（0=無制限） |
| `--collection` | source | Qdrant コレクション名 |
| `--qdrant-url` | http://localhost:6333 | Qdrant URL |
| `--text-field` | text | テキストカラム名 |
| `--id-field` | (auto) | ID カラム名（空=自動生成） |
| `--batch-size` | 64 | embedding バッチサイズ |
| `--chunk-size` | 0 | チャンクサイズ（語数、0=分割なし） |
| `--chunk-overlap` | 15 | チャンク間オーバーラップ語数 |
| `--force` | false | 既存コレクション削除して再作成 |

### タグ付与ルール

テキスト内容に基づくキーワードマッチ + チャンク位置ベースのタグを付与:

- **キーワードベース**: TAG_RULES の正規表現でマッチ（first-match-wins、最大3タグ）
- **位置ベース**（チャンク分割時のみ）:
  - `seq == 0` → `abstract` タグ追加
  - `seq >= total - 2` → `conclusion` タグ追加

> `--force` なしでは既存コレクションを削除せず append モード。`--force` 付きで recreate。

---

## Cascade Loader（本番パイプライン）

### 起動

```bash
node dist/loader/main.js
```

環境変数で設定:

```bash
# 例: ag_news と arxiv の2コレクションを処理
SOURCE_COLLECTIONS=source_ag_news,source \
QDRANT_URL=http://localhost:6334 \
SLOT_CAPACITY=100 \
TARGET_TICKS=60 \
TICK_INTERVAL_MS=3000 \
CASCADE_MAX_DELAY=30 \
CASCADE_MIN_DELAY=5 \
ABSORPTION_RATIO=0.4 \
node dist/loader/main.js
```

### 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `SOURCE_COLLECTIONS` | source | カンマ区切りの Source コレクション名 |
| `QDRANT_URL` | http://localhost:6334 | Qdrant エンドポイント |
| `MYCELIUM_COLLECTION` | mycelium_loader | 作業用 Qdrant コレクション |
| `TARGET_TICKS` | 60 | 各スロットの tick 数 |
| `TICK_INTERVAL_MS` | 3000 | tick 間隔（ミリ秒） |
| `SLOT_CAPACITY` | 100 | スロットあたりの最大ノード数 |
| `CASCADE_MAX_DELAY` | 30 | スロット間の最大待機 tick 数 |
| `CASCADE_MIN_DELAY` | 5 | スロット間の最小待機 tick 数 |
| `ABSORPTION_RATIO` | 0.4 | interaction spike 吸収判定比率 |
| `LOADER_SPECIES_FROM_TAGS` | false | `true` でタグベース species 解決 |

### 処理フロー

1. **Source 読み込み**: 複数コレクションから全ポイントをスクロール取得
2. **スロット分割**: 同一 sourceId のチャンクは同一スロットに、capacity 上限でビンパック
3. **サンドイッチ並べ替え**: 大→小→大の順で inject（吸収効率の最適化）
4. **カスケード注入**:
   - スロット単位で FeedInstance を生成・inject
   - tick ループ実行（tick-core で相互作用計算）
   - adaptive inject: interaction spike 沈静後に次スロット注入
5. **ハーベスト**: 生存ノード回収 → pushback 3軸分類 → レポート出力

### 出力

- **stdout**: `SurvivorReport[]` の JSON 配列
- **stderr**: 進捗ログ（inject/harvest/pushback サマリ）

### SurvivorReport 構造

```typescript
interface SurvivorReport {
  sourceId: string;          // "{collection}:{rawId}"
  collection: string;        // 元のコレクション名
  batchToken: string;        // スロット識別トークン
  totalChunks: number;       // 注入チャンク数
  survivingChunks: number;   // 生存チャンク数
  survivalRate: number;      // 生存率 (0-1)
  species: Record<Species, number>;  // 生存ノードの種族分布
  survivingTexts: string[];  // 生存テキストサンプル
  partsComplete: boolean;    // 全パーツ追跡完了
  classification: "pure" | "loner" | "redundant" | "merged" | "dead" | "partial";
}
```

---

## MCP Server

Claude Code や他の MCP クライアントから利用する対話的インターフェース。

### 起動

```bash
node dist/server.js
# or
npm start
```

### ツール一覧

| ツール | 説明 |
|--------|------|
| `mycelium_push` | ノードを手動 seed（summary, content, trigger, tags） |
| `mycelium_status` | コロニー統計（種族別ノード数、tick 状態） |
| `mycelium_observe` | cosine 類似度検索（読み取り専用） |
| `mycelium_tick` | 手動で1 tick 実行 |
| `mycelium_snapshots` | エコシステムスナップショット取得 |

---

## Species（種族）システム

### 種族一覧

| 種族 | 役割 | 初期 w | TTL | 特徴 |
|------|------|--------|-----|------|
| anchor | 構造的骨格 | 高 | 500 | survive-only、低 decay、長寿 |
| sentinel | 監視・検証 | 中 | - | エラー/ルール系の知識 |
| herald | 変更伝播 | 中 | - | リリース/結果の発信 |
| summarizer | 汎用集約 | 中 | - | 設定/レポート系（デフォルト） |
| spore | 仮説・草案 | 低 | - | 淘汰されやすい、未検証の知識 |

### タグ → 種族マッピング (species-mapping.json)

first-match-wins ルール:

```
anchor:     crash/outage/fatal, abstract/conclusion
sentinel:   error/bug/fix, methodology, rule/convention/lint/policy
herald:     gotcha, results/findings, release/deploy/commit/ship
summarizer: config/env/infra/docker, summary/digest/report/log
spore:      idea/draft/hypothesis/wip
default:    summarizer
```

### LOADER_SPECIES_FROM_TAGS

- `false`（デフォルト）: 外部データは全て spore として扱う（未検証の仮説）
- `true`: タグに基づいて種族を自動解決（学術データなど構造が明確な場合）

---

## Pushback 3軸分類

tick シミュレーション後の生存・死亡パターンから知識の価値を分類:

| 分類 | 意味 | 判定基準 |
|------|------|----------|
| **pure** | 独自知識（昇格候補） | 高 posRes + 未 merge |
| **merged** | 知識統合 | 60% tick snapshot で merge 参加 |
| **loner** | 孤立ゴミ | 早期死亡 + 低 posRes |
| **redundant** | 重複 | 早期 merge + 高 cosine |
| **dead** | 全滅 | 全チャンク死亡（loner/redundant でもない） |
| **partial** | 部分生存 | 一部生存、上記に該当せず |

---

## テストスクリプト

### semantic-filter-test.cjs（メイン検証ツール）

N回のシミュレーションを実行し、majority 投票で安定した分類結果を抽出。

```bash
# デフォルト: engram ソース、10周、50 ticks
node scripts/semantic-filter-test.cjs

# 外部ソース指定
SOURCE_COLLECTION=source QDRANT_URL=http://localhost:6334 \
  RUNS=3 TICKS=50 \
  node scripts/semantic-filter-test.cjs

# スナップショット（学習済みδ）使用
SNAPSHOT=latest node scripts/semantic-filter-test.cjs
```

| 環境変数 | デフォルト | 説明 |
|---------|-----------|------|
| `SOURCE_COLLECTION` | engram | ソースコレクション |
| `QDRANT_URL` | http://localhost:6333 | Qdrant URL |
| `RUNS` | 10 | シミュレーション周回数 |
| `TICKS` | 50 | 各周の tick 数 |
| `MAJORITY` | ceil(RUNS×0.4) | コンセンサス閾値 |
| `DRY_RUN` | true | false で engram へ loner フラグ送信 |
| `DIGEST_INTERVAL` | 20 | digestor 間隔 |

### その他のテストスクリプト

| スクリプト | 用途 |
|-----------|------|
| `analyze.cjs` | 現在のコロニーの行動分析（1 tick 読み取り専用） |
| `scenario-test.cjs` | シナリオ A-D（環境変動テスト） |
| `scenario-test-v2.cjs` | シナリオ E-I（極端な環境変動） |
| `parallel-scenario.cjs` | blendMode (SAME/CROSS) 並列比較 |
| `hybrid-blend.cjs` | SAME→CROSS 切替タイミング検証 |
| `train-species.cjs` | 種族の学習デルタ蓄積（バッチ訓練） |
| `single-run.cjs` | 単発 tick シミュレーション |

詳細は [TESTING_GUIDE.md](TESTING_GUIDE.md) を参照。

---

## スナップショット運用

種族メモリ（learnedDelta + learnedResonanceDelta）はファイルベースで永続化。

```
data/
  species-weights.json                    ← 最新の学習結果
  snapshots/
    species-weights-baseline-*.json       ← 手動固定ベースライン
    species-weights-*.json                ← 自動保存（タイムスタンプ付き）
```

### 訓練 → テスト フロー

```bash
# 1. 訓練
node scripts/train-species.cjs 100 80

# 2. 学習済みδでテスト
node scripts/scenario-test.cjs --snapshot latest

# 3. プレーン（δ=0）と比較
node scripts/scenario-test.cjs

# 4. 良ければ baseline 固定
cp data/snapshots/species-weights-<timestamp>.json \
   data/snapshots/species-weights-baseline-<date>.json
```

---

## 設定ファイル

| ファイル | 説明 |
|---------|------|
| `src/config/metabolism.json` | tick エンジンの全パラメータ（圧力/回復/エネルギー/社会/学習/spawn/merge） |
| `src/config/species.json` | 種族 DNA（perception/personality マトリクス、receptivity、resonanceSensitivity） |
| `src/config/species-mapping.json` | トリガー/タグ → 種族のマッピングルール |
| `docker-compose.yml` | Qdrant コンテナ定義（port 6334, volume mycelium-universal-qdrant-data） |

---

## よくある操作

### Source データの確認

```bash
# Qdrant REST API で直接確認
curl http://localhost:6334/collections
curl -s http://localhost:6334/collections/source/points/count | jq .result.count
curl -s -X POST http://localhost:6334/collections/source/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit": 5, "with_payload": true}' | jq .result.points
```

### Source データの再生成

```bash
# --force で既存削除して再作成
python scripts/prepare_source.py \
  --dataset "ccdv/arxiv-summarization" \
  --split "train[:1]" \
  --text-field "article" \
  --chunk-size 100 \
  --collection "source" \
  --qdrant-url "http://localhost:6334" \
  --force
```

### ビルド → テスト

```bash
npm run build && \
  SOURCE_COLLECTION=source QDRANT_URL=http://localhost:6334 \
  RUNS=3 TICKS=50 \
  node scripts/semantic-filter-test.cjs
```

---

## 既知の注意点

1. **Docker network**: コンテナ内からは `qdrant:6333`、ホストからは `localhost:6334`
2. **ESM / CJS**: `package.json` に `"type": "module"` → `require()` スクリプトは `.cjs` 拡張子必須
3. **Qdrant write は `?wait=true`**: 全 mutation に付与済み。テスト内で直接 fetch する場合も同様
4. **forceSpore**: Loader デフォルトは全外部データを spore 固定。タグベース解決は `LOADER_SPECIES_FROM_TAGS=true`
5. **HF データセット**: split 指定なしだと全件ダウンロード → 長時間かかる場合あり（arxiv: 20万件）
6. **Windows パス**: Docker volume mount は `C:/path/to/...` 形式で
