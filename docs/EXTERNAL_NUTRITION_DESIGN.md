# External Nutrition — engram メタデータによる初期条件エンコード

## 問題

現状の mycelium では、ノードの contents（知識テキスト）と代謝（w, h, ttl, personality）が完全に分離している。contents は merge 時に `»` プリフィックスで蓄積されるが、ノードの生存判断に一切寄与しない。コンテンツは遺体に残る副葬品であり、生きている間の代謝に関係がない。

本来、ノードが持つ知識の「外部での使われ方」が栄養として還流し、代謝を変えるべきである。engram 側で recall された知識は「外部から食われた＝価値がある」というシグナルになるべきだし、flag された知識は衰弱した状態で皿に載るべきだ。

### なぜリアルタイム注入ではないか

外部栄養の連続注入（tick 途中で engram の recall ログをチェックし h を回復する「餌撒きフェーズ」）は、ペトリ皿の閉鎖系原則を崩す。また、tick 50回を数秒で回す現行シミュレーションと engram の利用時間軸（時間〜日単位）は根本的に合わない。

## 設計方針

**mycelium = 単発分析サービス**

1. engram が「この知識群を評価してくれ」と皿に載せる
2. mycelium が回して結果（loner, redundant, pure, merger）を返す
3. engram が結果を受け取ってフィードバック反映

mycelium は常駐する必要がない。外部栄養は連続的な点滴ではなく、**生まれた時に持っている母体からの栄養**として抽象化する。

## アーキテクチャ: 疎結合の3層構造

```
engram (知識ストア)
  ↓ メタデータ付きノード群
orchestrator (前処理レイヤー)     ← マッピングロジックはここ
  ↓ 初期条件付きノード群 (w, h, d)
mycelium (分析サービス)           ← engram の構造を知らない
  ↓ 結果 (loner, redundant, pure, merger)
engram (フィードバック反映)
```

**重要**: マッピングロジックは mycelium の外、手前のレイヤー（orchestrator / gateway / engram 側スクリプト）に置く。mycelium は `{ vector, w, h, d, species, contents }` を受け取るだけで、その w/h/d がどう算出されたかを知らない。

これにより:
- **mycelium は engram のデータモデルに依存しない** — 他のデータソースからもノードを注入可能
- **マッピング関数の変更が mycelium のリリースと無関係** — 係数調整は前処理レイヤーだけ
- **テスト時は任意の初期条件を直接注入可能** — 現行の scenario-test-v2 と同じインターフェース

### engram 側の前処理（orchestrator が行う変換）

engram メタデータ → mycelium 初期条件へのマッピング:

| engram メタデータ | mycelium 初期値 | マッピング根拠 |
|-------------------|----------------|---------------|
| weight が高い | w ↑ | engram で既に価値が認められている → 初期体力に余裕 |
| weight が低い / flagged | w ↓ | 衰弱状態で皿に載る → 淘汰されやすい |
| hits が多い | h ↑ | 外部で活発に使われている → 活動レベルが高い |
| status = fixed | w ↑↑, d ↓ | 昇格済み → 高い初期体力 + 安定して劣化しにくい |
| recency が古い | h ↓, d ↑ | 長期間使われていない → 活動低下 + 劣化が速い |
| 頻繁に flag される | d ↑ | 評価が不安定 → 速く衰える |

具体的な変換関数と係数は **orchestrator 側の実装で決定**する。mycelium は関与しない。

### mycelium 側のインターフェース

mycelium が受け取るノードの型は現行のまま:

```typescript
// mycelium は w, h の初期値を受け取るだけ
// その値がどう算出されたかは知らない
interface NodeInput {
  vector: number[];
  contents: string[];
  species: Species;
  w: number;      // orchestrator が設定した初期体力
  h: number;      // orchestrator が設定した初期活動レベル
  d: number;      // orchestrator が設定した初期 decay 率
  engramId?: string;
}
```

feeder.ts の `createNodeFromEngram()` は既に `w` のデフォルト値を設定しているので、外部から渡された値をそのまま使う形に変更するだけで済む。

### バイパスモード

外部初期条件の注入は **トグルで無効化** できるようにする。無効時は従来通り `metabolism.json` の `birth.initialW/H` + `species.json` の `initialDecay` が使われる（ピュアテスト用）。

```typescript
// 環境変数 or metabolism.json で制御
// NUTRITION_BYPASS=1 → 外部 w/h/d を無視、従来の固定初期値を使用
// NUTRITION_BYPASS=0 or 未設定 → 外部値があればそれを使用、なければフォールバック
```

これにより:
- **ピュアテスト**: `NUTRITION_BYPASS=1` で全ノード同一初期条件。現行の scenario-test-v2 と同じ動作
- **本番分析**: バイパスなし。orchestrator が設定した w/h/d で分析
- **比較実験**: 同じデータセットをバイパスあり/なしで回して差分を観察

## 影響範囲

### mycelium 側の変更
- `src/core/feeder.ts` — 外部から渡された `w`, `h`, `d` 初期値をそのまま使用（現行のハードコード値・species.json の initialDecay をフォールバックに）
- `src/types.ts` — `NodeInput` 型に `w?`, `h?`, `d?` を追加（もし未定義なら）

### mycelium 側で変更不要
- `tick.ts`, `receptor.ts`, `digestor.ts` — 代謝エンジンは初期値がどう決まったかを知らない
- `pushback.ts` — フィルタロジックは w/h の値を見るだけ
- `species.json`, `metabolism.json` — 種族パラメータは不変

### mycelium 外（orchestrator / engram 側）で実装
- マッピング関数（weight/hits/status/recency/flag頻度 → w/h/d）
- マッピング係数の設定と管理
- engram API からのメタデータ取得

## 設計原則との整合

- **疎結合**: mycelium は engram の構造を知らない。前処理レイヤーが翻訳する。
- **閉鎖系維持**: tick 中に外部から栄養注入しない。初期条件のみ。
- **観察系**: 初期条件が異なるノードの生死を観察する。最適化ではない。
- **ノード間メトリクス操作禁止**: 従来通り。初期条件は外部が設定するもの。
- **mycelium = 単発分析**: 常駐不要。呼ばれたら回して結果を返す。

## 未決事項

- [ ] orchestrator の実装場所（engram 側スクリプト / 独立サービス / gateway 内）
- [ ] マッピング関数の係数チューニング（シナリオテストで検証）
- [ ] `status=fixed` ノードの扱い — そもそも皿に載せるべきか（既に昇格済み）
- [ ] 初期 w の上限（2.0 は妥当か？既存テストとの整合性）
