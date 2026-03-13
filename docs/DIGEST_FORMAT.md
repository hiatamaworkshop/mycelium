# Digest Output Format — AI consumption layer

## 概要
Mycelium フィルタ結果を AI エージェントが推論手前で参照できる形式に成型する出力レイヤー。
`VIEW_FORMAT=digest` で有効化。`VIEW_FORMAT=manifest` で軽量インデックスモード。

## 構造 (per sourceId)

```jsonc
{
  "meta": {
    "sourceId": "source_arxiv:14",
    "collection": "source_arxiv",
    "totalChunks": 156,
    "survivingChunks": 45,
    "survivalRate": 0.288,           // 小数3桁に丸め
    "classification": { "pure": 30, "merged": 15, "loner": 13, "redundant": 35, "dead": 63 },
    "consensusRate": 0.801,          // consensus mode のみ、丸め済み
    "headline": "We propose a novel...",  // pure[0] or abstract から導出、~120 chars
    "topSpecies": "summarizer",      // 生存者の最頻 species
    "survivorTags": { "methodology": 3, "results": 2 },  // 生存チャンクのタグ頻度
    "sourceMetadata": { "dataset": "ccdv/arxiv-summarization", ... }
  },
  "pure": [                          // ← 主役。概要把握に最適
    { "seq": 5, "text": "cleaned text...", "species": "herald" }
  ],
  "clusters": [                      // ← 傾向把握。どこに知識が集約されたか
    { "seq": 68, "clusterSize": 5, "depth1": 1, "deep": 3, "species": "summarizer", "sample": "..." }
  ],
  "merged": [                        // ← pure を除外した merged のみ。必要時に参照
    { "seq": 11, "text": "cleaned text...", "species": "spore" }
  ],
  "dead": [                          // ← 軽量ブリーフ。snippet + 死因
    { "seq": 2, "cls": "loner", "snippet": "cleaned snippet...", "cause": "merge", "cosine": 0.635, "posRes": 0 }
  ]
}
```

## 読み方（AI エージェント向け）

### 2段階アクセスパターン
1. **manifest** (`VIEW_FORMAT=manifest`) — ソース一覧のスキャン用。~50 tokens/source。headline + topSpecies + survivorTags で「何のデータか」を即判定
2. **digest** (`VIEW_FORMAT=digest`) — 関心のあるソースの詳細取得。full 4-tier 出力

### digest 優先順位
1. **meta** — ソース全体の品質判定。survivalRate + classification + headline + topSpecies で「どの程度信頼できるデータか」を即判定
2. **pure** — フィルタを単独で通過したユニークな知識断片。概要把握はここだけで可能
3. **clusters** — 複数チャンクが融合した意味的クラスタ。トピック傾向の把握に使用
4. **merged** — pure 以外の生存チャンク。詳細が必要な場合のみ参照
5. **dead** — 死亡チャンクの簡易記録。redundant/loner/dead の内訳確認用

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

## cleanText 処理
全テキストフィールド（pure.text, merged.text, clusters.sample, dead.snippet）に適用:
- `@xmath{N}` → `[x{N}]` — 変数同一性を保持しつつ可読化
- `@xcite` → `[ref]` — 引用マーカー正規化
- LaTeX コマンド除去: `\command{content}` → `content`
- テーブル断片除去: `&` が5個以上の行 → `[table]`
- 空白正規化: 3行以上の改行 → `\n\n`、3空白以上 → `  `

## pure / merged の排他性
**pure と merged は完全に排他**。重複なし。
- pure = `classification === "pure"` のチャンクのみ
- merged = `classification === "merged"` のチャンクのみ
- 全生存チャンクを見たい場合は pure + merged を結合

## 設計判断

### survivors → merged へのリネーム (2026-03-13)
旧 `survivors` は pure + merged の全生存チャンクを含んでいたが:
- pure との 100% 重複でペイロードの ~25% が無駄
- AI が pure を読んだ後に survivors を読むと同じテキストを再処理
- merged のみにすることでペイロード ~36% 削減、意味的にも明確化

### dead snippet への cleanText 適用 (2026-03-13)
dead briefs の snippet にも cleanText を適用。
`@xmath` 等のノイズが残っていると AI が snippet を解析する際に不要な処理が発生。

### survivalRate 丸め (2026-03-13)
`0.3269230769230769` → `0.288` — 小数3桁で十分。トークン節約 + 可読性向上。

## 既知の制限

### 参考文献チャンクが pure に混入
arxiv データでは参考文献リスト（bibliography）のチャンクがタグなし（`tags: []`）で入力され、
フィルタで「ユニーク」と判定されて pure に入ることがある。
- 原因: process_source.py の TAG_RULES に `references`/`bibliography` 検出ルールがない
- 対策案: TAG_RULES にヘッダ検出を追加（`## references`, `bibliography` 等）

## Manifest 構造

```jsonc
{
  "format": "manifest",
  "timestamp": "...",
  "summary": { "totalSources": 12, "totalChunks": 1840, "survivingChunks": 156, "survivalRate": 0.085 },
  "sources": [
    {
      "sourceId": "source_arxiv:14",
      "collection": "source_arxiv",
      "totalChunks": 156,
      "survivingChunks": 45,
      "survivalRate": 0.288,
      "headline": "We propose a novel approach to...",
      "topSpecies": "summarizer",
      "survivorTags": { "methodology": 3, "results": 2 },
      "pureCount": 30,
      "mergedCount": 15,
      "consensusRate": 0.801
    }
  ]
}
```

AI エージェントは manifest でソース一覧をスキャンし、関心のある sourceId のみ digest で詳細取得する。

## 使用方法

```bash
# manifest（軽量インデックス）
VIEW_FORMAT=manifest npx tsx src/loader/main.ts

# digest 出力（フル 4-tier）
VIEW_FORMAT=digest npx tsx src/loader/main.ts

# compact テキスト（LLM コンテキスト向け軽量版）
VIEW_FORMAT=compact npx tsx src/loader/main.ts

# 従来の生 JSON
npx tsx src/loader/main.ts
```

## 関連ファイル
- `src/output/formatters.ts` — digest/manifest 構築ロジック + cleanText + post-filter re-aggregation
- `src/loader/isolated-runner.ts` — harvest() で ChunkDetail/ClusterDetail/DeadBrief/survivorTags を構築
- `src/loader/feed-instance.ts` — 型定義 (ChunkDetail, ClusterDetail, DeadBrief, SurvivorReport)
