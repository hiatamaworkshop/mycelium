# Consensus Mode — 設計メモ

> Date: 2026-03-13
> Status: Phase 1b 実装済み

## 概要

同一データを N 回走らせ、チャンクごとに多数決で安定した分類を得る。
旧 `semantic-filter-test.cjs` の N=10, MAJORITY=4 に対応する機能。

## 用語定義

| 用語 | 意味 |
|------|------|
| **classification** | 1チャンクの1回の実行結果: `pure`, `merged`, `loner`, `redundant`, `dead` の5値 |
| **majority vote** | N 回の結果で最も多い分類を採用。同数時は先勝 |
| **threshold** | その多数決結果を「安定」と見なす最低得票率。デフォルト 0.4（= 10 run なら 4/10） |
| **passing** | あるチャンクの最多得票が threshold 以上であること |
| **passing rate** | あるソース内で passing したチャンクの割合。レポートの `consensusRate` フィールド |

## 閾値の意味

```
10 run, threshold=0.4 → minVotes = ceil(10 * 0.4) = 4
```

- チャンク X が 10 run で [dead, dead, dead, pure, dead, merged, dead, dead, dead, dead] の場合:
  - dead=8, pure=1, merged=1 → majority=dead(8票) → **passed**（8 ≥ 4）
- チャンク Y が 10 run で [pure, dead, merged, dead, pure, merged, merged, dead, pure, loner] の場合:
  - dead=3, pure=3, merged=3, loner=1 → majority=dead(3票, 先勝) → **NOT passed**（3 < 4）

passing rate が低いソース = ボーダーライン知識が多く、run ごとに結果が安定しない。

## レポート構造

各ソース（sourceId）のレポートに含まれるフィールド:

```typescript
interface SurvivorReport {
  // ... (sourceId, collection, etc.)
  classificationBreakdown: {   // 多数決後の最終分類カウント
    pure: number;
    merged: number;
    loner: number;
    redundant: number;
    dead: number;
  };
  consensusRate?: number;      // passing rate (0.0–1.0)。consensus mode 時のみ
}
```

**注意**: `classificationBreakdown` は多数決の「勝者」を集計したもの。
threshold を満たさなかったチャンクも勝者の分類としてカウントされる。
passing rate はあくまで「安定度」の指標であり、分類の採否を決めるものではない。

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `CONSENSUS_RUNS` | `1`（off） | N 回実行。2 以上で consensus mode 有効 |
| `CONSENSUS_THRESHOLD` | `0.4` | 安定と見なす最低得票率 |

## 旧テストとの対応

| 旧 semantic-filter-test | 現 loader consensus |
|------------------------|---------------------|
| `RUNS=10` | `CONSENSUS_RUNS=10` |
| `MAJORITY=4` | `CONSENSUS_THRESHOLD=0.4` |
| `TICKS=50` | `TARGET_TICKS=50` |
| 全ノードに N 回結果 | 全チャンクに N 回結果 |
| selectionBias triplicates で redundant 検出 | pushback 3軸で redundant 検出 |

## 設計判断

### なぜ全会一致ではなく threshold か

10 run で全会一致（10/10）を要求すると、大半のチャンクが不合格になる。
生態系シミュレーションの確率的揺らぎにより、完全一致は非現実的。
旧テストでも MAJORITY=4/10（40%）で十分としていた。

### なぜ per-source か

異なるソースのチャンクを跨いだ集計は無意味。
source A の 55 チャンクと source B の 28 チャンクでは母数が異なり、
混合した passing rate は何も表さない。
各ソースの内部安定性こそが意味のある指標。

### classification は呼び出し側の仕事

SurvivorReport に `classification`（ソースレベルの dominant ラベル）は含めない。
理由:
- レポートは下流のデータプロセッサを通してからエージェントに渡される
- プロセッサが breakdown をどう解釈するかは用途依存
- ローダーは分類カウントと安定度だけを提供し、解釈はしない
