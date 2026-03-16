# Mycelium — Changelog

loner 判定は　初期メトリクスがない汎用ローダーでは不正確だった、自然と長く生き延びるから
汎用ローダー利用時は60% ticks 時で判定する調整をした

## 2026-03-15: Delta Chain + clusterSnapshot clamp

### 概要
consensus N-run 間で learnedDelta / learnedResonanceDelta を引き継ぐ delta chain を実装。
合わせて clusterSnapshotTick が harvestTick を超える場合のクランプ修正を実施。

### Delta Chain（run 間学習蓄積）

**問題**: 従来は N-run すべてが同一の initialDelta スナップショットから開始。
各 run の digestor が蓄積した学習結果は run 終了時に破棄されていた。

**実装**: `runOnce()` 終了時に digestor の `getDelta()` / `getResonanceDeltaAll()` を返し、
次の run の初期値として引き継ぐ。

```
Run 1: baseline → tick loop → digest蓄積 → endDelta₁
Run 2: endDelta₁ → tick loop → digest蓄積 → endDelta₂
Run 3: endDelta₂ → tick loop → digest蓄積 → endDelta₃（リセット）
Run 4: baseline → ...
```

**過剰蓄積対策**: 3 run ごとに baseline スナップショットにリセット（`DELTA_CHAIN_LENGTH=3`）。
全 run 蓄積だと merge×kinship の負δが一方向に積み上がり、後半 run で merge がほぼ消滅する。

### テスト結果（arxiv:17, CONSENSUS_RUNS=10, TARGET_TICKS=60, mid）

| 方式 | survived | pure | merged | clusters | consensus% |
|------|----------|------|--------|----------|------------|
| delta固定（従来） | 34 | 9 | 25 | 25 | — |
| 全chain（10run蓄積） | 21.3±3.0 | 9.8±1.3 | 11.5±2.2 | 6.3±1.3 | 92.4±1.4 |
| 3run chain | 19.3±3.3 | 7.7±0.5 | 11.7±2.9 | 7.7±3.8 | 92.9±2.0 |
| 3run chain + clamp | 16.0±0.8 | 8.0±0.8 | 8.0±1.4 | 4.0±1.6 | 93.6±1.9 |

### Delta Chain の効果

- **consensus rate が 90-96% に安定** — run 間の学習収束により投票の再現性が劇的に改善
- **pure はほぼ維持** — 本当にユニークなチャンクは選択圧が上がっても残る
- **merged/clusters 減少** — merge×kinship の負δ蓄積により安易な merge が抑制された
- **clusters の質は向上** — 前回 size=13 の「ゴミ箱クラスタ」（参考文献に雑多に吸収）が消え、
  意味的に coherent なクラスタのみが残った（size=7 の数値分解トピック等）
- **安定性の改善** — clamp 後は survived σ=0.8, loner σ=0.0 と驚異的な再現性

### clusterSnapshot クランプ修正

**問題**: `clusterPct=0.7` + `harvestPct=0.6` + `TARGET_TICKS=60` の組み合わせで、
clusterSnapshotTick(42) > harvestTick(36) となり、クラスタスナップショットが一度も取得されなかった。

```
tick 36: harvest（ループ終了）
tick 42: clusterSnapshot（到達しない）→ 常に fallback（harvest 時点のノード）
```

**修正**: `clusterSnapshotTick = min(計算値, harvestTick - 1)` にクランプ。
IsolatedRunner と FeedInstance の両方に適用。

### 3run chain 長の根拠

全 run 蓄積（10run）vs 3run chain のテストで、全蓄積は merge 行動を過剰に抑制した。
3run は学習の恩恵（consensus 安定化）を得つつ、merge チェーンの形成を維持するバランス点。

### TARGET_TICKS=70 テスト（不採用）

tick 数を伸ばせばクラスタが増えると仮定してテストしたが逆効果:
- clusters 5.7±1.7（t=60 の 7.7 より悪化）
- survived 15.0±4.1（σ 増大）
- クラスタ形成後の崩壊まで観察してしまう

### 変更ファイル
- `src/loader/isolated-runner.ts` — RunResult に endDelta/endResonanceDelta 追加、
  runConsensus で 3run chain + baseline リセット、clusterSnapshotTick クランプ
- `src/loader/feed-instance.ts` — clusterSnapshotTick クランプ（同様の修正）

### 残る課題
- `DELTA_CHAIN_LENGTH=3` はハードコード。環境変数化を検討
- clusters 数の減少（25→4-8）が許容範囲かはユースケース依存。質は向上しているが量は減った
- resonance 実値の run 間引継ぎは未実装（inject 時 zeroResonance() のまま）

### レガシーコード注記

**server.ts (Phase 0 MCP サーバー)** および **tick.ts** はレガシー。
現行の実稼働パスは `loader → isolated-runner → tickCore()` であり、
`tick.ts` の `runTick()` は経由しない。

- `tick.ts:89-93` の spawn → Qdrant upsert はサーバーモード専用。
  isolated-runner は spawn children をローカル Map にのみ追加し Qdrant に書かない。
  spawn を DB に永続化する意味はない（フィルタリング判定に使わない）。
- `dispatcher.ts` も `runTick()` 経由の旧フロー。isolated-runner に置き換え済み。
- server.ts の `mycelium_tick` / `startTick()` は Phase 0 の手動 tick 操作用。
  将来的に server.ts を isolated-runner ベースに書き換えるか、Phase 0 コードとして凍結するか要判断。

### 外部サービス連携（Qdrant 経由入力）

現行の入力パイプラインは `source-scroll.ts → scrollSourcePoints()` で
Qdrant の任意 collection から `SourcePoint` 形式（`id`, `vector`, `payload.text`, `payload.sourceId`, `payload.tags`）を scroll 取得する汎用設計。

外部サービスが mycelium フィルタリングを利用する場合、**既存コードの変更なし**で対応可能:

- **同一 Qdrant インスタンス**: `SOURCE_COLLECTIONS=external_collection` を指定するだけ
- **別 Qdrant インスタンス**: 外部側が mycelium 側の Qdrant source collection に push、
  または `QDRANT_URL` を外部に向ける

唯一の制約は payload スキーマの一致（最低限 `text` + `vector`）。
スキーマが異なる場合のみアダプタ層が必要。

`prepare_source.py` による静的ファイル → embedding → Qdrant のバッチ処理は
embedding 生成が目的であり、既に embedded なデータには不要。

### mycelium 側 Qdrant の不要化

isolated-runner（現行の実稼働パス）は Qdrant を一切 import しておらず、
フィルタリング処理は完全にインメモリで完結している。

mycelium 側 Qdrant (`localhost:6334`) の現在の用途:
1. `checkQdrantHealth` — 起動時ヘルスチェック（なくても動く）
2. `deleteCollection` — `CLEAN_WORLDS=true` 時のみ（テスト用途）
3. source-scroll のソース読み込み先 — **外部 Qdrant を直接指定すれば不要**

つまり source-scroll が外部 Qdrant URL を受け取れるようにすれば、
mycelium 専用の Qdrant インスタンスは完全に排除可能。

**構成例（Qdrant レス）**:
```
外部 Qdrant (engram等) → source-scroll(外部URL直接指定) → isolated-runner(in-memory) → digest 出力
```

bridge スクリプトで `source_engram` を mycelium Qdrant に中継したのは
既存パイプラインへの適合であり、本質的には不要な中間ステップだった。

実装案: `SOURCE_QDRANT_URL` 環境変数を追加し、ソース取得先を分離する。
`QDRANT_URL`（mycelium 側）は起動チェック・world 管理用に残すか、完全削除。

**Qdrant の残存価値: embedding キャッシュ**

汎用データの場合 `prepare_source.py` で embedding を生成するが、
生成後のベクトルを Qdrant に保存する必要はなく、JSON/パイプで直接渡せる。
ただし Qdrant 保存には「embedding キャッシュ」としての価値がある:
- フィルタパラメータ変更時の再実行で embedding をスキップ（コスト削減）
- embedding モデルを変えない限りベクトルは不変 → キャッシュ効果が高い
- デバッグ時のソースデータ確認

結論: Qdrant は **必須ではないがキャッシュとして有用**。
最小構成では JSON ファイル入力 → in-memory filter → 出力で完結可能。

### 外部メトリクス（weight/score）の初期 w 反映（実装済み）

外部ソースの `payload.weight` が存在する場合、初期 `w` にマッピングし jitter をスキップ。

**マッピング**: `[-2, 4] → normalize [0, 1] → scale [0.3, 1.5] × initialW`
```
norm   = clamp(0, 1, (weight + 2) / 6)
mapped = 0.3 + norm × 1.2
initialW = birth.initialW × mapped
```

**レンジ `[0.3, 1.5]` の根拠**（mycelium の w 動態から逆算）:
- `initialW=1.0`, `deathMinW=0.05`, decay `w *= (1-d)` per tick, d≈0.03
- 60 tick 自然減衰: w=1.0 → 0.16（ギリギリ生存）
- **下限 0.3**: 60 tick 後 w≈0.05 → 社会的行動なしだとちょうど死ぬ。低評価ノードは他者の助けが必要
- **上限 1.5**: 60 tick 後 w≈0.24 → 余裕あり。ただし decay は乗算なので差は縮まり圧倒的有利にはならない
- 「有利/不利はあるが社会的行動で逆転可能」な設計意図

**jitter スキップの理由**: 外部スコアが既にノード間を差別化している。
jitter は「初期条件が均一なとき」に多様性を生む目的であり、外部メトリクスがある場合はノイズになる。

**テスト結果（engram 直接読み込み、91 points）**:

| マッピング | survived | consensus% | 備考 |
|-----------|----------|------------|------|
| なし (jitter あり) | 61/92 (66.3%) | — | bridge 経由、baseline |
| [0.1, 2.0] (jitter なし) | 62/91 (68.1%) | 93-100% | レンジ広すぎ |
| **[0.3, 1.5] (jitter なし)** | **62/91 (68.1%)** | **94-100%** | consensus 改善 |

レンジを狭めたことで生存数は同等だが consensus rate が改善 — run 間の再現性が向上。

**payload 正規化**（source-scroll.ts に実装済み）:
- `text` がなければ `summary + content` から生成（engram スキーマ対応）
- `sourceId` がなければ `projectId` を使用
- 外部コレクションを直接読む際のアダプタとして機能

---

## 2026-03-13: Digest 3-tier + Keyword Context Extraction

### 概要
digest 出力を 4-tier → 3-tier（meta / pure / clusters）に統合。
チャンク全文出力をキーワード文脈抽出（±40 chars 窓）に置き換え、トークン大幅削減。

### 3-tier 統合
- merged 配列を削除、clusters に text フィールドを追加して吸収
- clusters = 吸収構造（size/depth1/deep）+ キーワード文脈テキスト
- dead セクションも削除（meta.classification で十分）

### キーワード文脈抽出 (extractContext)
- `TAG_CONTEXT_PATTERNS`: process_source.py TAG_RULES をミラーした正規表現マップ
- `hintTags`: ソース単位の survivorTags キーで検索スコープ絞り込み
- パラメータ: CONTEXT_RADIUS=40, MAX_CONTEXT_WINDOWS=3, FALLBACK_LENGTH=80
- 効果: 1ソース 509行 → 196行（62%削減、arxiv:17 測定）

### 変更ファイル
- `src/output/formatters.ts` — SourceDigest 3-tier化、extractContext()、TAG_CONTEXT_PATTERNS 追加
- `docs/DIGEST_FORMAT.md` — 3-tier 構造、extractContext 仕様、設計判断を記録

---

## 2026-03-13: Post-filter re-aggregation + Manifest mode

### 概要
digest 出力に post-filter メタデータ（headline / topSpecies / survivorTags）を追加。
manifest モードを新設し、大量ソースのスキャン→詳細ドリルダウンの 2 段階アクセスを実現。

### Post-filter re-aggregation
フィルタ後の生存者データから再集計した 3 フィールドを digest meta に追加:

| フィールド | 導出元 | 用途 |
|-----------|--------|------|
| `headline` | pure[0].text or sourceMetadata.abstract（~120 chars） | ソースの一行要約 |
| `topSpecies` | survivors の species 頻度 max | 支配的な知識タイプ |
| `survivorTags` | 生存チャンクの payload.tags 集計 | フィルタ後のテーマ分布 |

pre-filter のメタデータ（sourceMetadata）は入力側の包括的な情報。
post-filter のフィールドはフィルタを通過した知識の特性を反映する。

### survivorTags パイプライン
harvest() で生存チャンクの `slot.points[spIdx].payload.tags` を集計し、
`SurvivorReport.survivorTags` として公開。タグなしチャンクのみの場合は undefined。

### Manifest mode (`VIEW_FORMAT=manifest`)
ソースごと ~50 tokens の軽量インデックス。AI エージェントが大量ソースをスキャンし、
関心のある sourceId のみ digest で詳細取得する 2 段階パターン。

含まれるフィールド:
- sourceId, collection, totalChunks, survivingChunks, survivalRate
- headline, topSpecies, survivorTags
- pureCount, mergedCount, consensusRate

### 変更ファイル
- `src/loader/feed-instance.ts` — `survivorTags?: Record<string, number>` を SurvivorReport に追加
- `src/loader/isolated-runner.ts` — harvest() で生存チャンクの tags を集計
- `src/output/formatters.ts` — deriveHeadline(), deriveTopSpecies(), buildManifest(), ManifestReport 型追加
- `src/loader/main.ts` — VIEW_FORMAT コメントに manifest 追加
- `docs/DIGEST_FORMAT.md` — manifest 構造、post-filter フィールド、2段階アクセスパターン追記

---

## 2026-03-12: Colony Store — per-tick Qdrant I/O 全廃

### 概要
per-tick の Qdrant I/O（scrollAll + setPayload×N + deletePoints）を全廃し、
`colony-store.ts`（`Map<string, NodeWithVector>`）をランタイム中の SSOT とした。
Qdrant は永続化層としてのみ使用。

### Before → After (per tick)
| 操作 | Before | After |
|------|--------|-------|
| 全ノード読み出し | `scrollAll()` HTTP GET | `store.getAll()` in-memory |
| 状態更新 | `setPayload()` × N HTTP POST | `store.applyTickResult()` in-memory |
| 死亡ノード削除 | `deletePoints()` HTTP POST | in-memory (Map.delete) |
| **合計 HTTP/tick** | **N+2** | **0** (spawn 時のみ 1) |

### Qdrant を使用する残りの経路
- **初期ブートストラップ**: `store.loadFromQdrant()` — 起動時 1 回のみ
- **Spawn 子ノード永続化**: 新ベクトルの Qdrant 書き込み（発生時のみ）
- **MCP ingest write-through**: `store.ingestAndPersist()` — store + Qdrant 同時書き込み
- **Loader inject/harvest**: Qdrant にも書き込み（永続化）、harvest 後に削除

### 並行性に関する注意事項
- **Loader (dispatcher.ts)**: inject → runTick → harvest が全て `await` で直列実行。競合なし
- **MCP server (server.ts)**: `startTick()` の setInterval と `mycelium_push` が非同期並行だが、
  `tickCore()` は**純粋な同期関数**（内部に `await` なし）のため、JS イベントループが
  事実上の排他制御として機能する。tick 実行中に push が割り込むことはない
- **store.size() 上限ガードは未実装**: spawn 暴走時の安全弁は現状なし。
  現在の代謝パラメータでは spawn rate が低く実運用で問題になる可能性は低いが、
  将来的に metabolism.json の spawn 閾値を下げる場合は要検討

### インメモリ射影パターンの汎用性
この設計は「ベクトル DB を永続化層に押し下げ、ランタイムはインメモリで回す」汎用パターン:
- **有効条件**: N < ~50K、ミュータブル状態がベクトル以外にある、高頻度読み書きサイクル
- **ベクトル更新は実質不要**: embedding は一度生成したら不変。「更新」= delete + re-embed
- **ANN vs brute-force**: N < ~10K なら brute-force cosine で差は無視できる

### 変更ファイル
- `src/core/colony-store.ts` (NEW): in-memory store — loadFromQdrant, getAll, getByIds, search, applyTickResult, addNode, removeNodes, flushToQdrant, ingestAndPersist
- `src/core/tick.ts`: scrollAll/setPayload/deletePoints → store.getAll()/store.applyTickResult()
- `src/loader/feed-instance.ts`: scrollAll → store.getByIds(), harvest 時 store.removeNodes() 追加
- `src/server.ts`: countPoints/searchPoints → store.size()/store.search(), upsertPoints → store.ingestAndPersist()

### ロールバック
colony-store.ts を削除し、tick.ts/feed-instance.ts/server.ts を revert（commit `46f988b` 以前の状態）。

---

## 2026-03-10: selectionBias + targetAffinity — 種族間選好と行動意図ベース対象選択

### 概念
対象選択（selectTarget）に2層のバイアスを導入:
1. **selectionBias**: 種族ごとの対象種族選好（cosine × selectionBias[target.species]）
2. **targetAffinity**: 行動意図による対象状態バイアス（× (1 + affinity × target.w)）

生物学的比喩: 捕食者は弱い獲物を見つけやすく、協力者は健康な相手を見つけやすい。
行動が先に決まり、その意図が知覚（対象探索）を変える — attention の生物学的起源。

### selectionBias（種族選好）
mergeImmune（anchor のハードコード merge 免疫）を廃止し、ソフトな選好システムに置換。
各種族が対象種族ごとに選好倍率を持つ。anchor 保護は創発的に実現:

| 種族 | → summarizer | → sentinel | → herald | → anchor | → spore |
|------|-------------|-----------|---------|---------|--------|
| summarizer | 1.0 | 1.0 | 1.1 | **0.3** | 1.0 |
| sentinel | 0.9 | 1.0 | 0.8 | **1.2** | 0.7 |
| herald | 1.1 | 0.8 | 1.0 | **0.3** | 1.2 |
| anchor | 0.5 | 1.0 | 0.3 | 0.8 | 0.2 |
| spore | 1.4 | 0.5 | 1.4 | **0.2** | 0.6 |

設計意図:
- anchor への bias が全種族で低い（0.2-0.3）→ merge 対象になりにくい（mergeImmune の創発的代替）
- sentinel だけ anchor bias=1.2 → 規則執行者が基盤を監視
- spore → summarizer/herald=1.4 → 仮説が検証者・伝播者を求める
- spore → spore=0.6 → 脆弱×脆弱の共倒れ回避

### targetAffinity（行動意図バイアス）
```json
"targetAffinity": { "signal": 0.5, "merge": -0.3, "bequeath": -0.2 }
```
- signal(+0.5): 健康な相手を選好 → accept 確率が高い相手にシグナルを送る
- merge(-0.3): 弱い相手を選好 → 吸収対象として弱体を狙う
- bequeath(-0.2): 弱い相手を選好 → 援助が必要な相手に TTL を贈る
- survive: 対象選択なし（非社会的行動）

### signalAcceptWBoost 補償
selectionBias で anchor 回避が増えた結果、accept イベントが減少 → 人口崩壊（19→8）。
signalAcceptWBoost を倍増して補償:

| 種族 | 旧値 | 新値 |
|------|------|------|
| summarizer | 0.03 | **0.06** |
| sentinel | — | **0.03** (新規) |
| herald | 0.02 | **0.05** |
| spore | 0.03 | **0.06** |

### merge contents cosine tracking
merge 時に吸収コンテンツに cosine similarity を付記:
```
»content|0.91        ← 1回吸収、cosine 0.91
»»content|0.91|0.82  ← 2回吸収、各 cosine
```
将来の品質フィルタリング基盤。

### 三世界テスト結果（回復推移）
| 段階 | W1 人口 | Only W3 | 備考 |
|------|--------|---------|------|
| selectionBias 導入直後 | ~8 | ~1.0 | anchor 回避で崩壊 |
| + signalAcceptWBoost×2 | ~10-11 | ~1.6 | 部分回復 |
| + targetAffinity | **~13** | **~2.5** | 安定回復 |

### 知見
- mergeImmune → selectionBias 移行: ハードコード保護を創発的保護に置換。稀に anchor が merge される「例外」は意図的
- 行動意図が知覚を変える（targetAffinity）: 生物と同じ順序 — 感情→行動選択→対象探索→相互作用→結果の内面化
- 人口アトラクターは selectionBias に敏感。anchor が最も信頼できる acceptor であるため、anchor 回避は accept 機会の直接的減少を意味する
- signalAcceptWBoost と targetAffinity の二重補償で回復可能だが、pre-selectionBias レベル（~19）には未到達（~13）

### 変更ファイル
- `src/types.ts`: `mergeImmune` → `selectionBias?: Record<string, number>`, `targetAffinity` 追加
- `src/core/tick.ts`: selectTarget に selectionBias + targetAffinity 適用、mergeImmune 削除
- `src/core/receptor.ts`: merge contents に cosine tracking 追加
- `src/config/species.json`: 全5種族に selectionBias 追加、signalAcceptWBoost 調整
- `src/config/metabolism.json`: social.targetAffinity 追加
- `scripts/three-world-test.cjs`, `train-species-v2.cjs`, `scenario-test-v2.cjs`: selectTarget 同期

### ロールバック
- selectionBias: 全種族の selectionBias を削除し、types.ts の mergeImmune を復元
- targetAffinity: metabolism.json の targetAffinity を削除し、selectTarget の stateBonus 計算を除去

---

## 2026-03-10: Dialectical Residual Injection (DRI) — 三世界弁証法実験

### 概念
二世界の selfReflection 差分（W2−W1）を第三世界の初期状態として注入する手法。
正式名称: **Dialectical Residual Injection (DRI)**。
関連概念: Difference-in-Differences (DiD, 経済学), Residual injection (ResNet), Aufheben (止揚, ヘーゲル弁証法)。

### 実験設計
- W1 (Thesis): frustration=OFF, selfReflection=ON — 純粋マルコフ + 社会的フィードバック
- W2 (Antithesis): frustration=ON, selfReflection=ON — 内的欲求 + 社会的フィードバック
- W3 (Synthesis): frustration=ON, selfReflection=ON, 初期 selfReflection = delta(W2−W1)

### 実験結果 (10 runs × 60 ticks, blend=0.3)
| 指標 | W1 | W2 | W3 |
|------|------|------|------|
| 人口 | 19.6±1.6 | 19.5±2.9 | 19.3±2.4 |
| Loner deaths | 19.1±4.7 | 18.6±3.4 | **16.7±4.1** |
| Only W3 survivors | — | — | **3.0±1.6** |

### 知見
- synthesis-unique survivors が全 run で安定出現（平均 3.0 体）— 弁証法的止揚の兆候
- blend 感度は非線形: 0.1(安定), 0.2(最悪), 0.3(loner 抑制最良)
- 人口レベルのアトラクターは堅牢（~19-20 で収束）。DRI は「誰が」生き残るかを変える

### コンフィグ変更
`selfReflection.blend`: 0.1 → **0.3** — DRI の経験的最適値

---

## 2026-03-10: Training v2 — frustration + selfReflection 対応トレーナー

### 概要
`train-species.cjs` (v1) は frustration / selfReflection / social tone / merge immunity / proximity fitness gate が
全て欠落しており、Phase 2.2 の tick ロジックと乖離していた。
`train-species-v2.cjs` を新規作成し、scenario-test-v2.cjs と同一の tick エンジンで学習を行うようにした。

### v1 → v2 差分
| 機能 | v1 | v2 |
|------|----|----|
| frustration blend + update | なし | あり |
| selfReflection blend + compute + decay | なし | あり |
| social tone (sender.w) | なし | あり |
| merge immunity (anchor) | なし | あり |
| proximity fitness gate | なし | あり |
| target selection | greedy nearest | softmax (tick.ts 準拠) |
| snapshot 読み込み | なし | `--snapshot [path|latest]` |

### トレーニング結果 (3 runs × 100 batches × 80 ticks)

δ収束状況:
| 種族 | Run 1 maxδ | Run 2 maxδ | Run 3 maxδ | 状態 |
|------|-----------|-----------|-----------|------|
| anchor | 0.1031 | 0.2693 | 0.2754 | 収束減速中 |
| spore | 0.1239 | 0.0668 | 0.0778 | 振動（小） |
| herald | 0.0877 | 0.0579 | 0.0644 | 安定域 |
| sentinel | 0.0523 | 0.0528 | 0.0519 | 収束 |
| summarizer | 0.0524 | 0.0518 | 0.0574 | 安定域 |

全種族共通パターン: **retaliate/flee × vigor/kinship の negative が支配的** — 「攻撃的反応は不利」を一貫して学習。

### v2 δ による三世界テスト (10 runs × 60 ticks, vs baseline δ)

| 指標 | baseline δ | v2 δ | 変化 |
|------|-----------|------|------|
| W3 人口 | 19.3±2.4 | 16.0±2.8 | 減（選択圧増加） |
| Only W3 | 3.0±1.6 | **3.4±1.5** | 微増 — synthesis-unique 改善 |
| anchor 人口 | 10.5±2.3 | **7.1±2.2** | anchor 支配の緩和 |
| herald 人口 | 2.8±1.7 | **3.6±1.0** | herald 安定化（σ縮小） |
| σ (全指標) | 大 | **小** | run 間ばらつき縮小 |

### 知見
- v2 トレーニングは生態系をより均衡的にする（anchor 一極支配 → 多種族共存）
- DRI の synthesis-unique 生成効果は v2 δ でも安定維持（3.4/run）
- reflection delta の kinship 成分が正→負に反転 — δが「社交コスト」を反映した結果

---

## 2026-03-10: Self-Reflection (社会的フィードバック内面化)

### 概念
行動の結果を自分の passive receptor で解釈し、次 tick の feelings に反映する。
「やった結果、相手がどう返してきて、それが自分にどう感じられたか」。

### Frustration との対比
| | Frustration | Self-Reflection |
|---|---|---|
| 入力 | 自分の action 確率分布 | 相手の reaction + 相手の feelings |
| 計算 | personality 転置 × 未達成度 | receptivity × (相手 feelings - 自分 feelings) の差分 |
| 意味 | やりたかったのにできなかった（内的欲求不満） | やった結果どうだったか（社会的結果の内面化） |
| 種族差 | personality 行列経由で間接的 | receptivity で直接的 |
| 外部依存 | なし（自己完結） | あり（相手の状態に依存） |

### Tick 内フロー
```
① computeFeelings(node, env)     → baseFeelings
② + frustration.blend             → frustration 反映
③ + selfReflection.blend          → 前 tick の社会的結果を反映  ← NEW
④ assessAction(feelings, ...)     → action 選択
⑤ emitSignal → react → resolveInteraction
⑥ computeReflection(自feelings, 相手feelings, receptivity)  ← NEW
   → selfReflection に蓄積（次 tick の③で使用）
⑦ survive 時: selfReflection は decay のみ（社会的インタラクションなし）
```

### computeReflection の数学
```
blended[k] = clamp01(currentFeelings[k] + receptivity × reactionFeelings[k])
delta[k]   = blended[k] - currentFeelings[k]
reflection_new[k] = decay × reflection_old[k] + delta[k]
```
- delta は正負両方: accept → kinship 方向の正、reject → dread 方向の正
- receptivity がゲート: anchor(0.1) はほぼ無感覚、spore(0.6) は強く影響
- decay=0.8 で frustration(0.7) より緩やかに残る — 社会的経験は欲求不満より長く記憶される

### 変更ファイル
- `src/types.ts`: `selfReflection?: Feelings` を MyceliumNode + Payload + MetabolismSchema に追加
- `src/core/node.ts`: `computeReflection()` 関数追加、payload 永続化
- `src/core/tick.ts`: feelings blend (③)、計算 (⑥)、survive 時減衰 (⑦)
- `src/config/metabolism.json`: `selfReflection: { enabled: true, blend: 0.1, decay: 0.8 }`

### コンフィグ
```json
"selfReflection": {
  "enabled": true,
  "blend": 0.1,
  "decay": 0.8
}
```
- `blend=0.1`: frustration(0.15) より控えめ。繊細な影響
- `decay=0.8`: frustration(0.7) より遅い減衰。経験の痕跡が長く残る

### ロールバック
`metabolism.json` の `selfReflection.enabled` を `false` に設定。

### 三世界シミュレーションとの関係
Self-Reflection は三世界弁証法シミュレーション (Phase E) の基盤:
- W1 の selfReflection 記録を W2 に持ち込むことで、「過去の社会的経験」を反事実世界に転送
- Approach β (receptor reuse): W1 の (action, feelings) を W2 で自身の receptor に流す
- 詳細: `docs/PHASE2_DESIGN.md` — "Dialectical Simulation" セクション

---

## 2026-03-09: Social Tone (sender w modulation)

### 変更内容
- `tick.ts`: 全社会的行動（signal/merge/bequeath）の signalFeelings を sender の `w` でスケール
- sender の w が低い → feelings が小さく target に届く →「弱者の声は小さい」

### 変更箇所
```typescript
// tick.ts L252-259
const tone = nv.node.w;
const tonedFeelings: typeof feelings = {
  vigor:   signal.feelings.vigor * tone,
  hunger:  signal.feelings.hunger * tone,
  dread:   signal.feelings.dread * tone,
  kinship: signal.feelings.kinship * tone,
};
const reaction = react(match.target.node, targetEnv, tonedFeelings, mergeCtx);
```

### ロールバック手順
`tonedFeelings` ブロックを削除し、`react()` の第3引数を `signal.feelings` に戻す:
```typescript
const reaction = react(match.target.node, targetEnv, signal.feelings, mergeCtx);
```

### テスト結果比較 (snapshot T0755, 60 tick)
| 指標 | tone なし | tone あり | 変化 |
|------|----------|----------|------|
| pure confirmed | 10 | 8 | 微減 |
| loner confirmed | 16 | 22 | 増加（弱者が孤立しやすくなった） |
| redundant confirmed | 1 | 1 | 変化なし |
| merger confirmed | 0 | 0 | 変化なし |
| 種多様性 | 3-5種共存 | 3-5種共存 | 維持 |

### 設計根拠
- 既存の `emitSignal.strength` は fitness ベースだが resonance 更新にのみ影響
- feelings 側には sender の状態が反映されておらず、w=0.1 の瀕死ノードと w=0.9 の健全ノードが同じ感情強度で target に影響していた
- signal だけでなく merge/bequeath にも均一に適用（いびつさ回避）
- 効果: loner 検出精度向上（社会的弱者の早期識別）、種多様性は維持
