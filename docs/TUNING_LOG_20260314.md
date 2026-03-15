# チューニングログ — 2026-03-14

> 種族ローテーション + クラスタスナップショットタイミング調整

## 背景

consensus 10-run テストで以下の問題が観察された:
- クラスタ検出量が不足（arxiv:14 で 0 クラスタ、arxiv:17 で 2 クラスタ）
- dead ノードがクラスタにカバーされず情報損失が大きい
- 初期メトリクス均一性（GAP-1）により merge タイミングが後方にずれている

## 変更1: BODY_ROTATION（種族ローテーション）

タグなしチャンクへの種族割り当てを変更。

| | 旧 | 新 |
|---|---|---|
| ローテーション | `[summarizer, herald, spore]` | `[summarizer, herald, summarizer, herald, spore]` |
| summarizer | 33% | 40% |
| herald | 33% | 40% |
| spore | 33% | 20% |

### 理由

- herald/summarizer は signal→resonance→merge チェーンの主役。クラスタの核になりやすい
- spore は dread 時に merge されやすい（personality merge=0.5-0.6）が decay=0.07 で最速消滅。吸収される材料として少量で十分
- sentinel はタグベースでのみ割り当て。TTL=200 で長寿だが社交性低くクラスタ形成に寄与しにくい

### 効果（clusterPct=0.6 時点）

| | 旧ローテーション | 新ローテーション |
|---|---|---|
| arxiv:14 clusters | 0 | **3** |
| arxiv:14 merged | 1 | **8** |
| arxiv:17 clusters | 2 | **5** |

## 変更2: clusterPct（クラスタスナップショットタイミング）

| | 旧 | 新 |
|---|---|---|
| clusterPct | 0.6 | **0.7** |

### 理由

初期メトリクスが均一なため、ノード間の競争圧が弱く寿命が延びている。
旧 mycelium（engram データ）では w/h/d にばらつきがあり、弱いノードが早期に merge されたが、
universal loader では全ノードが同等の初期値のため merge チェーンのピークが後方にずれる。
スナップショットを 10% 遅らせることで中盤の merge チェーンを観察窓に収められる。

### 3段階比較（BODY_ROTATION 新設定 + CONSENSUS_RUNS=10, TARGET_TICKS=60）

| clusterPct | arxiv:14 clusters | arxiv:14 coverage | arxiv:17 clusters | arxiv:17 coverage |
|---|---|---|---|---|
| 0.6 | 3 | 4.4% | 5 | 16.2% |
| **0.7** | **5** | **12.0%** | **10** | **37.4%** |
| 0.75 | 6 | 23.9% | 9 | 31.5% |

0.7 が両データで最もバランスが良い。0.75 は arxiv:14 では改善するが arxiv:17 ではピーク過ぎ。

### クラスタ品質（clusterPct=0.7 での代表例）

- arxiv:17 seq=99: size=11, depth1=10 — hypothesis×7 + synthesis×3 を吸収した大型クラスタ
- arxiv:14 seq=6: size=5, depth1=4 — claim×1 + hypothesis×3 を吸収
- 種族構成が多様（claim/hypothesis/synthesis 混合）→ 意味的に関連する異種チャンクの凝縮

## 変更しなかったもの

| パラメータ | テスト値 | 結果 | 判断 |
|---|---|---|---|
| jitter | 5% vs 10% | 分布ほぼ同一 | 10% のまま（jitter は不安定性の原因ではない） |
| earlyPct | 0.25 (from 0.4) | dead↔redundant 境界シフトのみ | 0.4 に復元（構造的改善なし） |
| CONSENSUS_RUNS | 20 (from 10) | 分布変わらず | 10 のまま（コスト見合わず） |

## 残る課題

- **クラスタ coverage はまだ低い**: arxiv:14 で 12%、arxiv:17 で 37%。残りの dead は本当にノイズか要検証
- **GAP-1（初期メトリクス均一性）**: 根本原因は未解決。engram 相当の品質信号がないため merge 選択が確率的
- **consensus per-chunk rate**: 56% のチャンクが 0.4-0.6 の低信頼帯。pure のみ avg 0.73 で安定

## 注意: clusterPct と harvestPct の関係（2026-03-15 追記）

`clusterPct=0.7` と `harvestPct=0.6`（mid）の組み合わせでは:
```
clusterSnapshotTick = floor(TARGET_TICKS × 0.7) = 42  (TARGET_TICKS=60)
harvestTick         = floor(TARGET_TICKS × 0.6) = 36
```
**harvest が先に来るため clusterSnapshot が取得されない**。
2026-03-15 にクランプ修正済み（`min(計算値, harvestTick - 1)`）。

hardness 設定を変える際は `clusterPct > harvestPct` にならないよう注意。
soft(0.3) では clusterSnapshotTick=18, harvestTick=18 で同一 tick になる（クランプで tick 17 に補正）。

## ファイル変更箇所

- `src/loader/feed-instance.ts` L195: BODY_ROTATION 配列
- `src/config/metabolism.json` L183: pushback.clusterPct