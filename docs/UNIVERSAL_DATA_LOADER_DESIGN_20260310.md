# Universal Data Loader — 設計メモ

**Date:** 2026-03-10
**Status:** Draft / Discussion

---

## 前提

- データソースは常に **ベクトル DB（Qdrant）** — Mycelium は生データを直接取得しない
- ベクトル DB へのデータ投入（embedding、チャンク化）は Mycelium の責務外
- ただしソースデータに tags がない場合、**タグパーサー** による自動付与が必要
- 最終的には投入側が **Mycelium System Protocol** に準拠すべき

---

## 現在のアーキテクチャ（engram 専用）

```
pollEngram() → scrollEngramNodes() → computeNutrition()
    ↓
resolveSpecies(trigger, tags, species?)   ← 汎用（再利用可）
    ↓
createNode(summary, content, trigger, ...) ← 汎用（再利用可）
    ↓
upsertPoints()                             ← 汎用（再利用可）
```

**汎用部品（そのまま使える）:**
- `resolveSpecies()` — tag/trigger → species マッピング（species-mapping.json）
- `createNode()` — ノード生成、species memory 継承
- `nodeToPayload()` / `payloadToNode()` — Qdrant シリアライズ
- tick エンジン全体（metabolism, receptor, digestor, pushback）

**engram 専用（汎用ローダーでは置き換え）:**
- `scrollEngramNodes()` — engram Qdrant スクロール
- `computeNutrition()` — engram metrics → 栄養マッピング
- `EngramPayload` インターフェース

---

## 汎用データローダー設計

### パイプライン全体像

```
[Source Qdrant] → [Tag Parser (if needed)] → [Batch Inject] → Mycelium Qdrant
                                                                    ↓
                                                               tick × N
                                                                    ↓
                                                             [Survivor Pool]
                                                                    ↓
                                                         [Interpretation Layer]
                                                                    ↓
                                                              Push / Flush
```

ベクトル DB から取得する時点でデータは完結エントリ（1 point = 1 node）。
チャンク化・embedding はソース DB 投入時に済んでいる前提。

### Layer 1: Source Qdrant Scroll

engram feeder の `scrollEngramNodes()` を汎用化:

```typescript
interface SourcePoint {
  id: string;
  vector: number[];
  payload: {
    text: string;            // summary or chunk text
    sourceId?: string;       // 元ドキュメントID（チャンクの場合）
    chunkSeqNo?: number;     // チャンク順序（チャンクの場合）
    tags?: string[];         // species マッピング用（あれば）
    [key: string]: unknown;  // ソース固有のメタデータ
  };
}
```

取得はページネーション付き scroll（既存の Qdrant クライアントで対応可能）。

### Layer 2: Tag Parser（タグ未付与データ用）

ソースデータに tags がない場合、テキスト内容から自動付与:

```typescript
function parseTags(text: string): string[] {
  // キーワードベースのルールマッチング
  // → species-mapping.json のタグ体系に合わせる
  // 例: "error", "bug" → anchor / "config", "docker" → anchor
  //     "release", "deploy" → herald / "idea", "draft" → spore
}
```

最終的にはソース側が Mycelium System Protocol に準拠して
tags を付与した状態で DB に入れるべき。Tag Parser は過渡期の補助。

### Layer 3: Batch Inject

既存部品をそのまま利用:

```
SourcePoint → parseTags (if needed) → resolveSpecies(tags) → createNode() → upsertPoints()
```

追加フィールド:
- `node.sourceId` — 元ドキュメントへの逆引きキー
- `node.chunkSeqNo` — 元ドキュメント内の位置（チャンクの場合）

### Layer 4: Interpretation Layer（回収）

tick を N 回まわした後、生存ノードを集計:

```typescript
interface SurvivorReport {
  sourceId: string;
  totalChunks: number;
  survivingChunks: number;
  survivalRate: number;          // surviving / total
  mergeCount: number;
  resonancePartners: string[];   // 共鳴した他ドキュメントの sourceId
  survivingTexts: string[];      // 生存チャンクのテキスト
}
```

**回収の流れ:**
1. 生存ノードの `sourceId` を集計
2. `survivalRate` でドキュメントをランク付け
3. 元テキストは Qdrant payload に保持（別ストレージ不要）
4. 共鳴先の `sourceId` から結合マップを生成

**回収タイミング:**
- 固定 tick 数（例: 60 tick = 本番1サイクル）で打ち切り
- または population 安定化を検知（observatory から判定）

---

## Mycelium System Protocol（投入側の準拠仕様）

ソースデータを Qdrant に投入する際の推奨フォーマット:

```json
{
  "id": "unique-point-id",
  "vector": [0.1, 0.2, ...],
  "payload": {
    "text": "チャンクテキスト（300-500字推奨）",
    "sourceId": "元ドキュメントID",
    "chunkSeqNo": 0,
    "tags": ["error", "docker"],
    "timestamp": 1710000000000
  }
}
```

- **vector**: 384d（all-MiniLM-L6-v2）推奨、同一モデルで統一
- **tags**: species-mapping.json のタグ体系に準拠
- **text**: embedding 元テキスト（回収時の復元用に保持）
- **sourceId + chunkSeqNo**: チャンクの場合の逆引き情報

---

## engram feeder との責務比較

| 項目 | engram feeder | 汎用ローダー |
|------|--------------|-------------|
| ソース | engram Qdrant（単一） | 任意の Qdrant コレクション |
| embedding | engram と共有（再利用） | ソース側で計算済み |
| 栄養マッピング | engram metrics → w/h/d | なし（デフォルト初期値） |
| タグ | engram が付与済み | Protocol 準拠 or Tag Parser |
| 回収 | pushback → engram feedback | 解釈レイヤー → 外部出力 |
| 目的 | engram 知識の生態系フィルタ | 汎用データのセマンティック選別 |

---

## フォーク方針

1. **mycelium-core**: tick エンジン + species + metabolism（共通）
2. **mycelium** (現行): engram feeder + pushback（engram 統合用）
3. **mycelium-loader** (新規): 汎用ローダー + Tag Parser + 解釈レイヤー

mycelium-core を npm パッケージ or git submodule として共有。

---

## 並列インスタンス設計

### 方針: カスケード起動 + 独立 tick

1インスタンスあたり **700-1000 nodes** を処理。
**1記事 = 1インスタンス固定**（sourceId がインスタンスを跨がない）。

```
t=0   : Feeder A 開始 (記事群 α, 1000 nodes)
t=~12 : A 一瞬 pause → Feeder B inject (記事群 β) → A resume
t=~24 : 先行インスタンス一瞬 pause → Feeder C inject (記事群 γ) → resume
  ... 各自独立に tick カウント ...
t=60  : A 完了 → harvest A
t=72  : B 完了 → harvest B
t=84  : C 完了 → harvest C
```

- 各インスタンスは独立した tick カウンタで走行、完了も順次
- 後発 inject 時に先行インスタンスを一瞬 pause（Qdrant I/O 衝突回避）
- 1記事が1インスタンスに閉じるため、跨ぎ統合ロジック不要
- マシンパワーがあればインスタンス数を増やすだけで横スケール可能

### スケーリング容量

| nodes/instance | cosine計算/tick | 所要時間目安 |
|---------------|-----------------|-------------|
| 700 | ~245,000 | 軽い |
| 1,000 | ~500,000 | 数百ms |
| 2,000 | ~2,000,000 | 重い（非推奨） |

ボトルネックは CPU（cosine `O(N²)`）ではなく **Qdrant I/O**
（毎 tick の scroll + batch upsert + delete）。
スロットリング判定は Qdrant 応答時間で行う。

### Dispatcher の役割

協調ロジックは最小限:

1. **記事振り分け**: sourceId 単位でインスタンスに割り当て（1記事 = 1インスタンス固定）
2. **inject 時 pause**: 後発インスタンスの inject 中、先行インスタンスを一瞬 pause
3. **順次 harvest**: 各インスタンスの完了を待ち、個別に SurvivorReport を回収

各インスタンスが自分の担当記事の SurvivorReport を単独で完成させるため、
InterpretationBuffer のような跨ぎ統合は不要。

### 障害対応

**インスタンス crash / 無応答:**
- Dispatcher が各インスタンスの tick 完了通知を監視
- タイムアウト（例: 最終通知から 5分）で dead 判定
- dead インスタンスの担当記事は `status: "lost"` としてマーク
- lost 記事の再投入は**しない**（生態系の途中状態は復元不能）
- 他インスタンスには影響なし（記事が跨がないため）

**Qdrant 接続断:**
- tick 内の upsert/delete 失敗 → そのインスタンスの tick をスキップ（状態はメモリに残る）
- 3連続失敗 → インスタンス自体を pause、Dispatcher に通知
- 復帰後は pause 時点のメモリ状態から再開（Qdrant と差分同期）

**Dispatcher 自体の crash:**
- 配布記録は永続化（ファイル or DB）しておく
- 再起動時に記録をリロード → 各インスタンスに状態問い合わせ → 回収再開

### 却下した案

**ランダムサンプル（70%処理）**: 行動漏れノードが decay だけ食らい
受動的に死ぬ。生態系の公平性が崩れるため不採用。

**チャンク跨ぎ分散**: 1記事のチャンクを複数インスタンスに分散し、
InterpretationBuffer で統合する案。協調ロジックが複雑になるため不採用。
カスケード方式で十分にスケールする。

---

## 実装ロードライン

### Phase 0: mycelium-core 抽出 → フォーク方式に変更

~~tick エンジン・species・metabolism を共通パッケージとして切り出し。~~
**決定（2026-03-11）:** npm パッケージ分離ではなく `mycelium_universal` としてフォーク。
engram 版 mycelium と設計が混ざらないよう独立リポジトリで開発する。

- [x] mycelium → mycelium_universal フォーク（e8d7992 から分岐）
- [x] 独立 git リポジトリとして初期化

### Phase 1: 汎用ローダー最小構成（カスケード対応）

Source Qdrant → Mycelium Qdrant のパイプラインを1本通す。
Phase 2 のカスケード並列化を最初から意識した構造。

**外部スクリプト（Python）: `scripts/prepare_source.py`**
- [x] HuggingFace dataset ロード → all-MiniLM-L6-v2 embedding (384d)
- [x] キーワードマッチによるタグ自動付与（species 特性に忠実な分類）
  - anchor: error/bug/fix/crash, config/env/infra/docker/k8s
  - sentinel: rule/convention/policy/compliance/security/validation
  - herald: release/deploy/ship/launch, changelog/migration/breaking
  - spore: idea/draft/hypothesis/experiment/prototype/proposal
  - summarizer: summary/digest/overview/report/review/analysis (+ タグなしデフォルト)
- [x] Mycelium System Protocol 準拠で Source Qdrant に投入

**tick エンジン分離: `src/core/tick.ts`**
- [x] `runTickCore()` — engram 依存なしの純粋 tick 関数を切り出し
- [x] `runTick()` — engram polling 付きラッパー（既存互換）

**ローダーモジュール: `src/loader/`**
- [x] `source-scroll.ts` — Source Qdrant scroll + sourceId グルーピング
  - `SourcePoint` インターフェース（Protocol 準拠）
  - `scrollSourcePoints()` — ページネーション付き全件取得
  - `groupBySourceId()` — sourceId 単位でグループ化
- [x] `feed-instance.ts` — FeedInstance クラス（インスタンスライフサイクル）
  - ステータス: pending → injecting → running → harvesting → done / lost
  - `inject()` — SourcePoint → resolveSpecies(tags) → createNode → upsert
  - `onTick()` — 独立 tick カウント
  - `harvest()` — 生存ノード回収 → SurvivorReport 生成 → クリーンアップ
  - `SurvivorReport` — survivalRate, species 分布, survivingTexts
- [x] `dispatcher.ts` — Dispatcher（カスケード制御）
  - `partitionIntoBatches()` — sourceId 単位でインスタンス容量まで詰める
  - `injectSchedule` — cascadeDelayTicks 間隔でインスタンス inject タイミング決定
  - inject 中は tick を回さない（Qdrant I/O 保護）
  - `runTickCore()` で全ノードを同一コレクションで相互作用
  - Phase 1: データが少なければ自動的に単一インスタンス動作
  - Phase 2: データが多ければ自動的にカスケード発動
- [x] `main.ts` — CLI エントリポイント（環境変数で設定）

**未実装（Phase 1 残タスク）:**
- [ ] `node.sourceId` フィールド追加（harvest 時の sourceId 別集計に必要）
- [ ] 共鳴マップ生成（resonancePartners）
- [ ] 実データでの動作検証

### Phase 2: カスケード並列化（強化）

基本構造は Phase 1 で実装済み。以下は強化項目。

- [ ] 配布記録の永続化（Dispatcher crash 対策）
- [ ] heartbeat / dead 判定 / lost マーク
- [ ] Qdrant 応答時間ベースのスロットリング
- [ ] 大量データでのカスケード動作検証

### Phase 3: Tag Parser 改善 + Mycelium System Protocol

- [ ] Tag Parser 精度評価（キーワードベースの限界を測定）
- [ ] 必要に応じて LLM 分類に切り替え
- [ ] Protocol ドキュメント整備（外部投入者向け仕様書）

### テスト計画

各 Phase の検証は独立して実施可能。
Phase 1 が最重要 — ここで生存パターンが engram feeder と同質であることを確認する。

### 実装済みファイル一覧

```
mycelium_universal/
├── scripts/
│   └── prepare_source.py          ← 外部スクリプト（HF → embed → tag → Source Qdrant）
├── src/
│   ├── core/
│   │   └── tick.ts                ← runTickCore() 分離済み
│   └── loader/
│       ├── source-scroll.ts       ← Source Qdrant scroll
│       ├── feed-instance.ts       ← FeedInstance ライフサイクル
│       ├── dispatcher.ts          ← カスケード Dispatcher
│       └── main.ts                ← CLI エントリポイント
```

### 実行手順

```bash
# 1. Source Qdrant にテストデータ投入
python scripts/prepare_source.py --dataset "ag_news" --split "train[:500]"

# 2. Loader 起動（60 tick, 3秒間隔 = 約3分）
npx tsx src/loader/main.ts

# 環境変数で調整可能:
#   SOURCE_COLLECTION=source
#   MYCELIUM_COLLECTION=mycelium_loader
#   TARGET_TICKS=60
#   TICK_INTERVAL_MS=3000
#   INSTANCE_CAPACITY=1000
#   CASCADE_DELAY=12
```

---

## テストデータ調達

### 調査結果（2026-03-11）

384d dense embedding（all-MiniLM-L6-v2）の小規模 pre-embedded データセットは
HuggingFace・Qdrant 公式ともに存在しない。

**HuggingFace**: テキスト + メタデータで配布、embedding は利用者が計算する前提。
**Qdrant 公式 snapshot**: ArXiv（768d, InstructorXL, 2.3M件）、Wolt Food（512d, CLIP, 1.7M件）
— いずれも次元・モデル・サイズが不適合。

### 方針: 自前 embedding（外部スクリプト）

all-MiniLM-L6-v2 は軽量モデル（22M パラメータ）。
CPU でも 1000 テキスト = 数十秒、GPU なら数秒。

```python
from sentence_transformers import SentenceTransformer
from datasets import load_dataset
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

model = SentenceTransformer("all-MiniLM-L6-v2")
ds = load_dataset("...", split="train[:1000]")  # 小規模テキストデータ

vectors = model.encode(ds["text"])
points = [
    PointStruct(
        id=i,
        vector=vec.tolist(),
        payload={
            "text": ds["text"][i],
            "sourceId": ds["id"][i],       # or generate
            "tags": [],                     # Tag Parser で補完
            "timestamp": int(time.time() * 1000),
        },
    )
    for i, vec in enumerate(vectors)
]

client = QdrantClient("http://localhost:6333")
client.upsert(collection_name="source", points=points)
```

Mycelium System Protocol に準拠した形で Source Qdrant に投入。
Tag Parser テストの場合は tags を空にして投入し、loader 側で自動付与させる。

---

## テスト戦略

### Phase 1: Qdrant → Mycelium パイプライン検証

1. 外部スクリプトでテキストデータを all-MiniLM-L6-v2 で embedding → Source Qdrant に投入
2. 汎用ローダーで scroll → inject
3. 60 tick（tick 間隔 3-5秒、所要 3-5分）で打ち切り
4. 生存率・共鳴パターンを観察
5. engram feeder と同質の生存パターンであることを確認

### Phase 2: Tag Parser + 解釈レイヤー

1. tags 未付与データで Tag Parser の精度検証
2. 生存ノードの sourceId 集計 → 元テキスト復元
3. 共鳴マップ生成

---

## Open Questions

1. **Tag Parser の精度**: キーワードベースで十分か、LLM による分類が必要か？
2. **回収の粒度**: ドキュメント単位の生存率で十分か、チャンク間の共鳴グラフまで必要か？
3. **フォークの境界**: mycelium-core にどこまで含めるか（digestor, pushback は core か応用か）
4. **Qdrant スロットリング閾値**: 応答時間何ms超で inject を遅延させるか？
5. **テストデータソース**: どのテキストデータセットを使うか（ニュース記事、技術文書、etc.）
