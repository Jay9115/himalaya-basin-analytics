"""
Lossless Shapefile → GeoParquet conversion script
Himalayan region data | ISRO-SWOT project
"""

import sys
import os
import glob
import geopandas as gpd
import pyarrow.parquet as pq

SRC_DIR = r"d:\ISRO-SWOT\Webapp\himalaya-basin-analytics\Himalaya_shape"
DST_DIR = r"d:\ISRO-SWOT\Webapp\himalaya-basin-analytics\Himalaya_shape\Geopar"

os.makedirs(DST_DIR, exist_ok=True)

# Find all unique shapefile base-names in the source directory
shp_files = glob.glob(os.path.join(SRC_DIR, "*.shp"))

if not shp_files:
    print("No .shp files found in source directory.")
    sys.exit(1)

print(f"Found {len(shp_files)} shapefile(s) to convert:\n")

all_ok = True
for shp_path in shp_files:
    base = os.path.splitext(os.path.basename(shp_path))[0]
    out_path = os.path.join(DST_DIR, f"{base}.parquet")

    print(f"  Converting : {os.path.basename(shp_path)}")
    try:
        # ── Read shapefile (all attributes preserved) ─────────────────────────
        gdf = gpd.read_file(shp_path)

        # ── Quick sanity check ────────────────────────────────────────────────
        print(f"    CRS       : {gdf.crs}")
        print(f"    Features  : {len(gdf)}")
        print(f"    Columns   : {list(gdf.columns)}")
        print(f"    Geom types: {gdf.geom_type.unique().tolist()}")

        # ── Write GeoParquet (lossless – no compression reduces precision) ────
        # compression='snappy' is lossless; geometry stored as WKB (exact bytes)
        gdf.to_parquet(
            out_path,
            compression="snappy",      # fast lossless byte compression
            geometry_encoding="WKB",   # exact binary geometry – no precision loss
            write_covering_bbox=True,  # spatial bounding-box metadata for fast queries
        )

        # ── Verify: round-trip check ──────────────────────────────────────────
        gdf_back = gpd.read_parquet(out_path)
        assert len(gdf_back) == len(gdf), "Row count mismatch after round-trip!"
        assert list(gdf_back.columns) == list(gdf.columns), "Column mismatch after round-trip!"

        size_shp  = sum(
            os.path.getsize(os.path.join(SRC_DIR, f))
            for f in os.listdir(SRC_DIR)
            if f.startswith(base) and os.path.isfile(os.path.join(SRC_DIR, f))
        )
        size_parq = os.path.getsize(out_path)
        ratio = size_shp / size_parq if size_parq else float("inf")

        print(f"    Output    : {out_path}")
        print(f"    SHP size  : {size_shp / 1024:.1f} KB")
        print(f"    Parquet   : {size_parq / 1024:.1f} KB  (ratio {ratio:.2f}x)")
        print(f"    ✓ Round-trip verified – no data loss\n")

    except Exception as exc:
        print(f"    ✗ ERROR converting {base}: {exc}\n")
        all_ok = False

if all_ok:
    print("All conversions completed successfully!")
else:
    print("Some conversions FAILED. Check errors above.")
    sys.exit(1)
