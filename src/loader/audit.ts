// ============================================================
// Fuel Audit — fueled vs flat A/B comparison (Phase F3)
// ============================================================
//
// Runs the same slots twice (fuel on / fuel off) and quantifies how
// much the fuel channels (payload.weight, payload.myceliumMetrics)
// shift classification. This is the echo-chamber watchdog from the
// design principles: fuel is supposed to be a bias, not a decision —
// if drift grows large or fuel-dependent survivors pile up, F2
// parameters (nutrition.bias etc.) need review.
//
// Pure comparison — no Qdrant writes, no files. The audit JSON goes
// to stdout; judgment (accept / retune) stays with the caller.

import type { SurvivorReport, ChunkClassification } from "./feed-instance.js";

// ---- Report shape ----

export interface AuditChunkFlip {
  sourceId: string;
  chunkSeqNo: number;
  pointId?: string;
  fueled: ChunkClassification;
  flat: ChunkClassification;
  fueledConsensusRate?: number;
  flatConsensusRate?: number;
}

export interface AuditSourceSummary {
  sourceId: string;
  chunks: number;
  agreement: number;
  survivalFueled: number;
  survivalFlat: number;
}

export interface FuelAuditReport {
  fuelAudit: {
    ts: number;
    consensusRuns: number;
    sources: number;
    chunks: number;
    /** Chunks that actually carried fuel (payload.weight or myceliumMetrics).
     *  Drift on the remaining chunks is pure run-to-run jitter noise. */
    fueledChunks?: number;
    /** Exact per-chunk classification match rate (0-1). */
    agreementRate: number;
    /** Binary survivor/dead match rate — ignores pure↔merged, loner↔redundant↔dead flips. */
    survivalAgreementRate: number;
    /** Classification drift = 1 - agreementRate. */
    drift: number;
    /** Mismatch transitions, "fueledClass→flatClass" → count. */
    transitions: Record<string, number>;
    survivalRate: { fueled: number; flat: number };
    /** Mean per-chunk consensus rate — classification stability under jitter. */
    avgConsensusRate: { fueled: number; flat: number };
    /** Survive with fuel, die without — fuel is carrying them (echo-chamber risk). */
    fuelDependents: AuditChunkFlip[];
    /** Survive without fuel, die with — fuel is suppressing them. */
    fuelSuppressed: AuditChunkFlip[];
    perSource: AuditSourceSummary[];
  };
}

// ---- Comparison ----

const SURVIVOR_CLASSES = new Set<ChunkClassification>(["pure", "merged"]);

interface ChunkEntry {
  classification: ChunkClassification;
  pointId?: string;
  consensusRate?: number;
}

/** Flatten a report set into (sourceId, chunkSeqNo) → classification entries. */
function indexChunks(reports: SurvivorReport[]): Map<string, ChunkEntry> {
  const map = new Map<string, ChunkEntry>();
  for (const r of reports) {
    for (const c of r.chunkDetails ?? []) {
      map.set(`${r.sourceId}#${c.chunkSeqNo}`, {
        classification: c.classification,
        pointId: c.pointId,
        consensusRate: c.consensusRate,
      });
    }
    for (const d of r.deadBriefs ?? []) {
      map.set(`${r.sourceId}#${d.chunkSeqNo}`, {
        classification: d.classification,
        pointId: d.pointId,
        consensusRate: d.consensusRate,
      });
    }
  }
  return map;
}

export function buildFuelAudit(
  fueled: SurvivorReport[],
  flat: SurvivorReport[],
  consensusRuns: number,
  fueledChunkCount?: number,
): FuelAuditReport {
  const fueledChunks = indexChunks(fueled);
  const flatChunks = indexChunks(flat);

  const transitions: Record<string, number> = {};
  const fuelDependents: AuditChunkFlip[] = [];
  const fuelSuppressed: AuditChunkFlip[] = [];
  const perSourceAcc = new Map<string, { chunks: number; agree: number }>();

  let compared = 0;
  let agree = 0;
  let survivalAgree = 0;
  let rateSumFueled = 0, rateCountFueled = 0;
  let rateSumFlat = 0, rateCountFlat = 0;

  for (const [key, f] of fueledChunks) {
    const g = flatChunks.get(key);
    if (!g) continue; // chunk missing on one side — skip from comparison
    compared++;

    const [sourceId, seqStr] = splitKey(key);
    const acc = perSourceAcc.get(sourceId) ?? { chunks: 0, agree: 0 };
    acc.chunks++;

    if (f.consensusRate != null) { rateSumFueled += f.consensusRate; rateCountFueled++; }
    if (g.consensusRate != null) { rateSumFlat += g.consensusRate; rateCountFlat++; }

    const fSurv = SURVIVOR_CLASSES.has(f.classification);
    const gSurv = SURVIVOR_CLASSES.has(g.classification);
    if (fSurv === gSurv) survivalAgree++;

    if (f.classification === g.classification) {
      agree++;
      acc.agree++;
    } else {
      const t = `${f.classification}→${g.classification}`;
      transitions[t] = (transitions[t] ?? 0) + 1;

      if (fSurv !== gSurv) {
        const flip: AuditChunkFlip = {
          sourceId,
          chunkSeqNo: parseInt(seqStr, 10),
          pointId: f.pointId ?? g.pointId,
          fueled: f.classification,
          flat: g.classification,
          ...(f.consensusRate != null ? { fueledConsensusRate: f.consensusRate } : {}),
          ...(g.consensusRate != null ? { flatConsensusRate: g.consensusRate } : {}),
        };
        (fSurv ? fuelDependents : fuelSuppressed).push(flip);
      }
    }
    perSourceAcc.set(sourceId, acc);
  }

  const survivalOf = (reports: SurvivorReport[]) => {
    const total = reports.reduce((s, r) => s + r.totalChunks, 0);
    const surv = reports.reduce((s, r) => s + r.survivingChunks, 0);
    return total > 0 ? surv / total : 0;
  };

  const survivalBySource = (reports: SurvivorReport[]) =>
    new Map(reports.map(r => [r.sourceId, r.survivalRate]));
  const fueledSurvival = survivalBySource(fueled);
  const flatSurvival = survivalBySource(flat);

  const perSource: AuditSourceSummary[] = [...perSourceAcc.entries()].map(([sid, acc]) => ({
    sourceId: sid,
    chunks: acc.chunks,
    agreement: round3(acc.chunks > 0 ? acc.agree / acc.chunks : 1),
    survivalFueled: round3(fueledSurvival.get(sid) ?? 0),
    survivalFlat: round3(flatSurvival.get(sid) ?? 0),
  }));

  const agreementRate = compared > 0 ? agree / compared : 1;

  return {
    fuelAudit: {
      ts: Date.now(),
      consensusRuns,
      sources: perSource.length,
      chunks: compared,
      ...(fueledChunkCount != null ? { fueledChunks: fueledChunkCount } : {}),
      agreementRate: round3(agreementRate),
      survivalAgreementRate: round3(compared > 0 ? survivalAgree / compared : 1),
      drift: round3(1 - agreementRate),
      transitions,
      survivalRate: { fueled: round3(survivalOf(fueled)), flat: round3(survivalOf(flat)) },
      avgConsensusRate: {
        fueled: round3(rateCountFueled > 0 ? rateSumFueled / rateCountFueled : 0),
        flat: round3(rateCountFlat > 0 ? rateSumFlat / rateCountFlat : 0),
      },
      fuelDependents,
      fuelSuppressed,
      perSource,
    },
  };
}

// ---- Helpers ----

function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf("#");
  return [key.slice(0, i), key.slice(i + 1)];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
