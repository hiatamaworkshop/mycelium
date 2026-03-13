# Digest Output Format — AI consumption layer

## 概要
Mycelium フィルタ結果を AI エージェントが推論手前で参照できる形式に成型する出力レイヤー。
`VIEW_FORMAT=digest` で有効化。`VIEW_FORMAT=manifest` で軽量インデックスモード。

**翻訳レイヤー**: 生の SurvivorReport（内部データ構造）をキーワード文脈抽出で圧縮し、
AI が最小トークンで最大情報を得られる形に変換する。

## 構造 (3-tier: meta / pure / clusters)

```jsonc
{
  "meta": {
    "sourceId": "source_arxiv:17",
    "collection": "source_arxiv",
    "totalChunks": 131,
    "survivingChunks": 45,
    "survivalRate": 0.344,
    "classification": { "pure": 27, "merged": 18, "loner": 15, "redundant": 6, "dead": 65 },
    "consensusRate": 0.695,
    "headline": "inflation generically predicts a primordial spectrum of density perturbations...",
    "topSpecies": "herald",
    "survivorTags": { "methodology": 4, "results": 6, "definition": 2 },
    "sourceMetadata": { "dataset": "ccdv/arxiv-summarization", ... }
  },
  "pure": [
    { "seq": 0, "text": "inflation generically predicts a primordial spectrum of density perturbations...", "species": "anchor" },
    { "seq": 29, "text": "…it follows that [x1] can be estimated using the rule [x20] where we have recalled that [x2]…", "species": "sentinel" }
  ],
  "clusters": [
    { "seq": 92, "size": 5, "depth1": 1, "deep": 3, "species": "herald", "text": "components of [x119] and hence are only sensitive to the local value o…" }
  ]
}
```

## キーワード文脈抽出 (extractContext)

チャンクテキスト全文の代わりに、タグキーワード周辺の文脈窓のみを抽出する。

### パラメータ
| 定数 | 値 | 意味 |
|------|-----|------|
| `CONTEXT_RADIUS` | 40 | キーワード前後 ±40 chars（≈80 chars/window） |
| `MAX_CONTEXT_WINDOWS` | 3 | 1チャンクあたり最大3窓 |
| `FALLBACK_LENGTH` | 80 | キーワードヒットなし時の先頭切り出し |

### 処理フロー
1. `cleanText()` でノイズ除去（@xmath → [x{N}]、LaTeX コマンド除去等）
2. 改行・複数空白をフラット化
3. `hintTags`（そのソースの survivorTags キー）で検索スコープを絞り込み
4. `TAG_CONTEXT_PATTERNS` の正規表現でキーワード位置を検出
5. 各ヒット周辺 ±40 chars を窓として抽出、重複窓はマージ
6. ヒットなし → 先頭 80 chars + `...`（fallback）

### TAG_CONTEXT_PATTERNS
`process_source.py` の `TAG_RULES` キーワードを TypeScript 正規表現化したもの。
タグ分類と同じキーワードを使うため、**なぜそのチャンクが生存したか**の根拠を直接示す文脈が抽出される。

```
sentinel:  definition, theorem, constraint, bound, rule, error
herald:    methodology, comparison, performance, results, findings, refactor, release, commit
summarizer: caveat, summary, debug, monitoring, dependency, config
spore:     experiment, hypothesis, idea, temporary, obsolete
anchor:    abstract, conclusion, crash
```

## 読み方（AI エージェント向け）

### 2段階アクセスパターン
1. **manifest** (`VIEW_FORMAT=manifest`) — ソース一覧のスキャン用。~50 tokens/source。headline + topSpecies + survivorTags で「何のデータか」を即判定
2. **digest** (`VIEW_FORMAT=digest`) — 関心のあるソースの詳細取得。3-tier 出力

### digest 優先順位
1. **meta** — ソース全体の品質判定。survivalRate + classification + headline + topSpecies で「どの程度信頼できるデータか」を即判定
2. **pure** — フィルタを単独で通過したユニークな知識断片。概要把握はここだけで可能
3. **clusters** — 複数チャンクが融合した知識クラスタ。size/depth1/deep で吸収構造を示す。text はキーワード文脈抽出済み

### meta の post-filter フィールド
| フィールド | 導出元 | 用途 |
|-----------|--------|------|
| headline | pure[0].text or sourceMetadata.abstract | ソースの一行要約（~120 chars） |
| topSpecies | survivors の species 頻度 | 支配的な知識タイプ |
| survivorTags | 生存チャンクの tags 集計 | フィルタ後のテーマ分布 |

### classification の意味
| 分類 | 意味 | フィルタでの扱い |
|------|------|------------------|
| pure | 他ノードを吸収せず単独生存 | ユニークな知識 |
| merged | 他ノードを吸収して生存 | クラスタの核 |
| redundant | 高cosine早期merge死 | 近傍重複（既知情報） |
| loner | 低posRes早期死 | 孤立（文脈に接続しない断片） |
| dead | 上記以外の死亡 | フィルタで除去 |

### species の意味
| 種族 | 役割 | pure での解釈 |
|------|------|---------------|
| herald | 情報伝播者 | 論文の主張・結論に近い |
| summarizer | 要約者 | 事実の集約 |
| anchor | 基盤保持者 | 文書の骨格（定義・前提） |
| sentinel | 規則執行者 | 制約・条件・手法の記述 |
| spore | 仮説生成者 | 未確定・探索的な記述 |

### clusters の読み方
| フィールド | 意味 |
|-----------|------|
| seq | 起点チャンクの連番（文書内位置） |
| size | クラスタ内ノード総数（起点 + 吸収された数） |
| depth1 | 直接吸収されたノード数 |
| deep | 間接吸収（2段以上の連鎖） |
| species | 起点ノードの種族 |
| text | キーワード文脈抽出済みテキスト |

size が大きいクラスタ = 周辺の類似チャンクを多数吸収 = そのトピックの知識密度が高い。

## cleanText 処理
extractContext 内部で適用:
- `@xmath{N}` → `[x{N}]` — 変数同一性を保持しつつ可読化
- `@xcite` → `[ref]` — 引用マーカー正規化
- LaTeX コマンド除去: `\command{content}` → `content`
- テーブル断片除去: `&` が5個以上の行 → `[table]`
- 空白正規化: 3行以上の改行 → `\n\n`、3空白以上 → `  `

## 設計判断

### 4-tier → 3-tier 統合 (2026-03-13)
旧構造は meta / pure / clusters / merged の 4 層だったが:
- merged と clusters は同じ「吸収して生存したチャンク」を指す — 概念的に同一
- clusters に text フィールドを追加し merged を吸収、3-tier に統合
- 情報欠落なし: clusters が吸収構造（size/depth1/deep）+ テキストを一元管理

### dead セクション削除 (2026-03-13)
dead briefs（死亡チャンクの snippet + 死因）は AI 消費時にほぼ参照されない。
必要な情報は meta.classification の集計値で十分把握できるため削除。

### キーワード文脈抽出の導入 (2026-03-13)
チャンク全文出力 → キーワード周辺窓抽出に変更。
- 1ソースあたり 509行 → 196行（62% 削減、arxiv:17 測定）
- 3-tier 統合後はさらに削減
- `hintTags` による検索スコープ絞り込みで高精度なヒット

### 80 chars の根拠
- キーワードヒット時: ±40 chars ≈ 80 chars/window → 1つの論理的主張を十分に捉える
- fallback: 先頭 80 chars → タグ外コンテンツは頭だけで十分
- `snippetText()` も 80 chars → 全体で統一
- 不足なら `CONTEXT_RADIUS` を 50-60 に上げるだけで対応可能

## Manifest 構造

```jsonc
{
  "format": "manifest",
  "timestamp": "...",
  "summary": { "totalSources": 20, "totalChunks": 1769, "survivingChunks": 237, "survivalRate": 0.134 },
  "sources": [
    {
      "sourceId": "source_arxiv:17",
      "collection": "source_arxiv",
      "totalChunks": 131,
      "survivingChunks": 45,
      "survivalRate": 0.344,
      "headline": "inflation generically predicts a primordial spectrum...",
      "topSpecies": "herald",
      "survivorTags": { "methodology": 4, "results": 6 },
      "pureCount": 27,
      "mergedCount": 18,
      "consensusRate": 0.695
    }
  ]
}
```

AI エージェントは manifest でソース一覧をスキャンし、関心のある sourceId のみ digest で詳細取得する。

## 使用方法

```bash
# manifest（軽量インデックス）
VIEW_FORMAT=manifest npx tsx src/loader/main.ts

# digest 出力（3-tier）
VIEW_FORMAT=digest npx tsx src/loader/main.ts

# compact テキスト（LLM コンテキスト向け軽量版）
VIEW_FORMAT=compact npx tsx src/loader/main.ts

# 従来の生 JSON
npx tsx src/loader/main.ts
```

## 既知の制限

### 参考文献チャンクが pure に混入
arxiv データでは参考文献リスト（bibliography）のチャンクがタグなし（`tags: []`）で入力され、
フィルタで「ユニーク」と判定されて pure に入ることがある。
- 原因: process_source.py の TAG_RULES に `references`/`bibliography` 検出ルールがない
- 対策案: TAG_RULES にヘッダ検出を追加（`## references`, `bibliography` 等）

## 関連ファイル
- `src/output/formatters.ts` — digest/manifest 構築ロジック + cleanText + extractContext + post-filter re-aggregation
- `src/loader/isolated-runner.ts` — harvest() で ChunkDetail/ClusterDetail/DeadBrief/survivorTags を構築
- `src/loader/feed-instance.ts` — 型定義 (ChunkDetail, ClusterDetail, DeadBrief, SurvivorReport)
