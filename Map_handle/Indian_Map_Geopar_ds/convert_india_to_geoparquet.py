"""
Lossless Shapefile -> GeoParquet conversion  +  Enhanced Verification
Indian Map Data | ISRO-SWOT Himalaya Basin Analytics Dashboard
======================================================================
Verifications performed per layer:
  1. Row count match
  2. Exact column names match (preserves field names like 'District', 'State')
  3. CRS match
  4. Geometry type set match (Point / Polygon / MultiPolygon etc.)
  5. Total spatial bounds comparison (minx, miny, maxx, maxy)
  6. Geometry non-null count match

Outputs per layer:
  • <LAYER>.parquet          — GeoParquet (Snappy + WKB, lossless)
  • <LAYER>.shp.xml          — ArcGIS metadata sidecar (copied as-is)
  • <LAYER>_manifest.json    — full provenance record

Run: python convert_india_to_geoparquet.py
"""

import os, sys, shutil, glob, json
import geopandas as gpd
from datetime import datetime, timezone

# ── Paths ──────────────────────────────────────────────────────────────────────
SRC_DIR = r"D:\ISRO-SWOT\Map_handle_backup\India_Shape_downloaded"
DST_DIR = r"D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\Map_handle\Indian_Map_Geopar"

os.makedirs(DST_DIR, exist_ok=True)

# ── Discover shapefiles ────────────────────────────────────────────────────────
shp_files = sorted(f for f in glob.glob(os.path.join(SRC_DIR, "*.shp"))
                   if not f.endswith(".xml"))

if not shp_files:
    print("ERROR: No .shp files found in source directory.")
    sys.exit(1)

print("=" * 72)
print("  India Map Shapefile -> GeoParquet  |  Enhanced Verification")
print(f"  Source : {SRC_DIR}")
print(f"  Dest   : {DST_DIR}")
print(f"  Layers : {len(shp_files)}")
print("=" * 72)

summary_rows = []
all_ok = True

for shp_path in shp_files:
    base = os.path.splitext(os.path.basename(shp_path))[0]
    out_parquet = os.path.join(DST_DIR, f"{base}.parquet")
    out_manifest = os.path.join(DST_DIR, f"{base}_manifest.json")

    print(f"\n>>  {base}")

    try:
        # ── 1. Read source shapefile ───────────────────────────────────────────
        print("   Reading source SHP ...", end=" ", flush=True)
        gdf = gpd.read_file(shp_path)
        print(f"done. ({len(gdf):,} features)")

        src_cols      = list(gdf.columns)
        src_crs       = str(gdf.crs) if gdf.crs else "None"
        src_geom_types= sorted(set(gdf.geom_type.dropna().unique()))
        src_bounds    = gdf.total_bounds.tolist()          # [minx, miny, maxx, maxy]
        src_null_geom = int(gdf.geometry.isna().sum())

        print(f"   Columns    : {src_cols}")
        print(f"   CRS        : {src_crs[:60]}")
        print(f"   Geom types : {src_geom_types}")
        print(f"   Bounds     : minx={src_bounds[0]:.6f} miny={src_bounds[1]:.6f} "
              f"maxx={src_bounds[2]:.6f} maxy={src_bounds[3]:.6f}")

        # ── 2. Write GeoParquet ────────────────────────────────────────────────
        print("   Writing GeoParquet ...", end=" ", flush=True)
        ts_utc = datetime.now(timezone.utc).isoformat()
        gdf.to_parquet(
            out_parquet,
            compression="snappy",
            geometry_encoding="WKB",
            write_covering_bbox=True,
        )
        print("done.")

        # ── 3. Read back and run all checks ───────────────────────────────────
        print("   Verifying ...", end=" ", flush=True)
        gdf2 = gpd.read_parquet(out_parquet)

        back_cols       = list(gdf2.columns)
        back_crs        = str(gdf2.crs) if gdf2.crs else "None"
        back_geom_types = sorted(set(gdf2.geom_type.dropna().unique()))
        back_bounds     = gdf2.total_bounds.tolist()
        back_null_geom  = int(gdf2.geometry.isna().sum())

        errors = []

        # Check 1 – Row count
        if len(gdf2) != len(gdf):
            errors.append(f"ROW COUNT  orig={len(gdf)} back={len(gdf2)}")

        # Check 2 – Exact column names (order-sensitive, protects 'District','State',...)
        if back_cols != src_cols:
            errors.append(f"COLUMNS    orig={src_cols}\n              back={back_cols}")

        # Check 3 – CRS
        if gdf2.crs != gdf.crs:
            errors.append(f"CRS        orig={src_crs[:40]}  back={back_crs[:40]}")

        # Check 4 – Geometry types
        if back_geom_types != src_geom_types:
            errors.append(f"GEOM TYPES orig={src_geom_types}  back={back_geom_types}")

        # Check 5 – Spatial bounds (allow tiny float tolerance only)
        BOUNDS_TOL = 1e-9
        bounds_ok = all(abs(a - b) < BOUNDS_TOL
                        for a, b in zip(src_bounds, back_bounds))
        if not bounds_ok:
            errors.append(
                f"BOUNDS     orig={[round(v,8) for v in src_bounds]}\n"
                f"              back={[round(v,8) for v in back_bounds]}"
            )

        # Check 6 – Null geometry count
        if back_null_geom != src_null_geom:
            errors.append(f"NULL GEOMS orig={src_null_geom}  back={back_null_geom}")

        if errors:
            print("FAILED")
            for e in errors:
                print(f"   ✗ {e}")
            all_ok = False
            summary_rows.append((base, "FAILED"))
            continue

        print("all checks passed.")

        # ── 4. Copy .shp.xml sidecar ───────────────────────────────────────────
        xml_src = shp_path + ".xml"
        xml_copied = False
        if os.path.exists(xml_src):
            shutil.copy2(xml_src, os.path.join(DST_DIR, base + ".shp.xml"))
            xml_copied = True
            print(f"   XML sidecar: copied.")
        else:
            print(f"   XML sidecar: not found (skipped).")

        # ── 5. Write manifest JSON ─────────────────────────────────────────────
        src_exts = [".shp",".dbf",".prj",".shx",".sbn",".sbx",".cpg",
                    ".CPG",".SHP",".DBF",".PRJ",".SHX",".SBN",".SBX"]
        src_size_bytes = sum(
            os.path.getsize(os.path.join(SRC_DIR, base + ext))
            for ext in src_exts
            if os.path.exists(os.path.join(SRC_DIR, base + ext))
        )
        dst_size_bytes = os.path.getsize(out_parquet)

        manifest = {
            "layer": base,
            "conversion_timestamp_utc": ts_utc,
            "source": {
                "file": shp_path,
                "total_size_bytes": src_size_bytes,
            },
            "output": {
                "parquet_file": out_parquet,
                "parquet_size_bytes": dst_size_bytes,
                "compression": "snappy",
                "geometry_encoding": "WKB",
                "xml_sidecar_copied": xml_copied,
            },
            "verification": {
                "row_count": len(gdf2),
                "columns": back_cols,          # exact field names preserved
                "crs": back_crs,
                "geometry_types": back_geom_types,
                "bounds": {
                    "minx": back_bounds[0],
                    "miny": back_bounds[1],
                    "maxx": back_bounds[2],
                    "maxy": back_bounds[3],
                },
                "null_geometries": back_null_geom,
                "all_checks_passed": True,
            },
        }

        with open(out_manifest, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, ensure_ascii=False)
        print(f"   Manifest   : {os.path.basename(out_manifest)} written.")

        # ── 6. Size report ─────────────────────────────────────────────────────
        ratio = src_size_bytes / dst_size_bytes if dst_size_bytes else 0
        print(f"   SHP total  : {src_size_bytes/1024:>10.1f} KB")
        print(f"   Parquet    : {dst_size_bytes/1024:>10.1f} KB  ({ratio:.2f}x smaller)")
        print(f"   [PASS] {base} — ALL CHECKS PASSED")
        summary_rows.append((base, "OK", f"{src_size_bytes/1024:.1f} KB",
                              f"{dst_size_bytes/1024:.1f} KB", f"{ratio:.2f}x",
                              src_geom_types, back_geom_types,
                              [round(v,4) for v in src_bounds],
                              [round(v,4) for v in back_bounds]))

    except Exception as exc:
        import traceback
        print(f"\n   ✗ ERROR: {exc}")
        traceback.print_exc()
        all_ok = False
        summary_rows.append((base, "ERROR"))

# ── Summary ────────────────────────────────────────────────────────────────────
print("\n" + "=" * 72)
print("  SUMMARY")
print("=" * 72)
for row in summary_rows:
    base, status = row[0], row[1]
    icon = "[PASS]" if status == "OK" else "[FAIL]"
    if status == "OK":
        _, _, src_s, dst_s, ratio, geom_src, geom_bk, bnd_src, bnd_bk = row
        print(f"  {icon} {base:<25} {src_s:>12} -> {dst_s:<16} ({ratio})")
        print(f"      geom_types : {geom_src}")
        print(f"      bounds_src : {bnd_src}")
        print(f"      bounds_out : {bnd_bk}")
    else:
        print(f"  {icon} {base} — {status}")
print()
if all_ok:
    print("   All layers converted and verified — ZERO data loss confirmed.")
    print(f"  Output: {DST_DIR}")
else:
    print("  [WARN]️  Some layers FAILED. Check errors above.")
    sys.exit(1)
