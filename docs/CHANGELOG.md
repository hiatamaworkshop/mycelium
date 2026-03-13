# Mycelium — Changelog

loner 判定は　初期メトリクスがない汎用ローダーでは不正確だった、自然と長く生き延びるから
汎用ローダー利用時は60% ticks 時で判定する調整をした

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
