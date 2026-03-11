// Temporary: analyze engram node metrics for orchestrator design
const url = "http://localhost:6333";
(async () => {
  const res = await fetch(`${url}/collections/engram/points/scroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 200, with_payload: true, with_vectors: false }),
  });
  const data = await res.json();
  const pts = data.result.points;

  const weights = pts.map(p => p.payload.weight).filter(v => v != null);
  const hits = pts.map(p => p.payload.hitCount).filter(v => v != null);
  const statuses = {};
  pts.forEach(p => { const s = p.payload.status || "none"; statuses[s] = (statuses[s] || 0) + 1; });
  const now = Date.now();
  const ages = pts.map(p => (now - p.payload.ingestedAt) / 3600000);
  const recency = pts.map(p => p.payload.lastAccessedAt ? (now - p.payload.lastAccessedAt) / 3600000 : null).filter(v => v != null);

  console.log("=== WEIGHT ===");
  const sw = [...weights].sort((a, b) => a - b);
  console.log("  min:", Math.min(...weights).toFixed(1), " max:", Math.max(...weights).toFixed(1),
    " avg:", (weights.reduce((a, b) => a + b, 0) / weights.length).toFixed(2));
  console.log("  bottom5:", sw.slice(0, 5).map(v => v.toFixed(1)).join(", "));
  console.log("  top5:", sw.slice(-5).map(v => v.toFixed(1)).join(", "));
  // histogram
  const buckets = { "< -1": 0, "-1..0": 0, "0..1": 0, "1..2": 0, "2..3": 0, "3..4": 0, "4+": 0 };
  for (const w of weights) {
    if (w < -1) buckets["< -1"]++;
    else if (w < 0) buckets["-1..0"]++;
    else if (w < 1) buckets["0..1"]++;
    else if (w < 2) buckets["1..2"]++;
    else if (w < 3) buckets["2..3"]++;
    else if (w < 4) buckets["3..4"]++;
    else buckets["4+"]++;
  }
  console.log("  histogram:", Object.entries(buckets).map(([k, v]) => `${k}:${v}`).join("  "));

  console.log("\n=== HIT COUNT ===");
  console.log("  min:", Math.min(...hits), " max:", Math.max(...hits),
    " avg:", (hits.reduce((a, b) => a + b, 0) / hits.length).toFixed(1));
  const hb = { "0": 0, "1-2": 0, "3-5": 0, "6+": 0 };
  for (const h of hits) {
    if (h === 0) hb["0"]++;
    else if (h <= 2) hb["1-2"]++;
    else if (h <= 5) hb["3-5"]++;
    else hb["6+"]++;
  }
  console.log("  histogram:", Object.entries(hb).map(([k, v]) => `${k}:${v}`).join("  "));

  console.log("\n=== STATUS ===");
  Object.entries(statuses).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("  " + k + ": " + v));

  console.log("\n=== AGE (hours) ===");
  console.log("  newest:", Math.min(...ages).toFixed(0) + "h  oldest:", Math.max(...ages).toFixed(0) + "h");

  console.log("\n=== RECENCY (hours since last access) ===");
  if (recency.length > 0) {
    console.log("  most recent:", Math.min(...recency).toFixed(0) + "h  least recent:", Math.max(...recency).toFixed(0) + "h  has data:", recency.length + "/" + pts.length);
  } else { console.log("  no data"); }

  console.log("\ntotal nodes:", pts.length);
})();
