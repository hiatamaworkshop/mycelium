import json

with open("data/reports/shared_2026-03-13T08-26-16.json") as f:
    reports = json.load(f)

print("=== Text quality analysis ===")
latex_count = 0
ref_count = 0
table_count = 0
clean_count = 0
total = 0

for r in reports:
    for t in r.get("survivingTexts", []):
        total += 1
        if "@xmath" in t or "xmath" in t:
            latex_count += 1
        elif t.count("et al") >= 2 or t.count("&") >= 5:
            ref_count += 1
        elif t.count("+") >= 5 or t.count("|") >= 3:
            table_count += 1
        else:
            clean_count += 1

print(f"Total surviving texts: {total}")
print(f"LaTeX-heavy: {latex_count} ({latex_count*100//total}%)")
print(f"Reference lists: {ref_count} ({ref_count*100//total}%)")
print(f"Table-like: {table_count} ({table_count*100//total}%)")
print(f"Clean prose: {clean_count} ({clean_count*100//total}%)")

print("\n=== Clean prose samples ===")
shown = 0
for r in reports:
    sid = r["sourceId"]
    for t in r.get("survivingTexts", []):
        has_noise = ("@xmath" in t or t.count("et al") >= 2 or 
                     t.count("&") >= 5 or t.count("+") >= 5)
        if not has_noise and len(t) > 100:
            print(f"\n  [{sid}] {t[:400]}")
            shown += 1
            if shown >= 8: break
    if shown >= 8: break

print("\n=== LaTeX-heavy samples ===")
shown = 0
for r in reports:
    for t in r.get("survivingTexts", []):
        if "@xmath" in t:
            print(f"\n  {t[:300]}")
            shown += 1
            if shown >= 3: break
    if shown >= 3: break
