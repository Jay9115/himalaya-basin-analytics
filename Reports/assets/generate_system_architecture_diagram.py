from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


OUT_DIR = Path(r"D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\Reports\assets")
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_FILE = OUT_DIR / "himalaya_webapp_system_architecture.png"


def load_font(size: int, bold: bool = False):
    candidates = []
    if bold:
        candidates.extend(
            [
                r"C:\Windows\Fonts\arialbd.ttf",
                r"C:\Windows\Fonts\seguisb.ttf",
                r"C:\Windows\Fonts\segoeuib.ttf",
            ]
        )
    else:
        candidates.extend(
            [
                r"C:\Windows\Fonts\arial.ttf",
                r"C:\Windows\Fonts\segoeui.ttf",
                r"C:\Windows\Fonts\calibri.ttf",
            ]
        )
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


TITLE_FONT = load_font(42, bold=True)
SUBTITLE_FONT = load_font(20)
SECTION_FONT = load_font(24, bold=True)
BODY_FONT = load_font(18)
SMALL_FONT = load_font(16)
MONO_FONT = load_font(16)


W, H = 2200, 1400
img = Image.new("RGB", (W, H), "#f7f9fc")
draw = ImageDraw.Draw(img)


COLORS = {
    "ink": "#1f2937",
    "muted": "#5b6574",
    "line": "#cfd6df",
    "accent": "#2f5d8a",
    "accent_fill": "#edf4fb",
    "soft_fill": "#ffffff",
    "soft_fill_alt": "#f6f8fc",
    "green_fill": "#eef7ef",
    "orange_fill": "#fff5e8",
    "note_fill": "#f5f7fa",
}


def rounded_box(x1, y1, x2, y2, fill, outline=COLORS["line"], radius=22, width=2):
    draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, fill=fill, outline=outline, width=width)


def text_block(text, box, font, fill=COLORS["ink"], line_gap=6, align="left"):
    x1, y1, x2, y2 = box
    max_width = x2 - x1
    words = text.split()
    lines = []
    current = ""
    for word in words:
        trial = word if not current else f"{current} {word}"
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)

    y = y1
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        line_w = bbox[2] - bbox[0]
        line_h = bbox[3] - bbox[1]
        if align == "center":
            tx = x1 + (max_width - line_w) / 2
        else:
            tx = x1
        draw.text((tx, y), line, font=font, fill=fill)
        y += line_h + line_gap
    return y


def section_box(x1, y1, x2, y2, title, subtitle, items, fill=COLORS["soft_fill"]):
    rounded_box(x1, y1, x2, y2, fill=fill)
    draw.text((x1 + 22, y1 + 18), title, font=SECTION_FONT, fill=COLORS["accent"])
    if subtitle:
        draw.text((x1 + 22, y1 + 52), subtitle, font=SMALL_FONT, fill=COLORS["muted"])
    y = y1 + 88
    for item in items:
        bullet_x = x1 + 26
        draw.ellipse((bullet_x, y + 8, bullet_x + 10, y + 18), fill=COLORS["accent"])
        y = text_block(item, (bullet_x + 24, y, x2 - 22, y2 - 20), BODY_FONT, fill=COLORS["ink"], line_gap=6)
        y += 14


def arrow(x1, y1, x2, y2, label=None):
    draw.line((x1, y1, x2, y2), fill=COLORS["accent"], width=5)
    head = 16
    draw.polygon(
        [
            (x2, y2),
            (x2 - head, y2 - head / 2),
            (x2 - head, y2 + head / 2),
        ],
        fill=COLORS["accent"],
    )
    if label:
        label_w = draw.textlength(label, font=SMALL_FONT)
        lx = (x1 + x2) / 2 - label_w / 2
        ly = y1 - 32
        rounded_box(lx - 12, ly - 6, lx + label_w + 12, ly + 28, fill="white", outline=COLORS["line"], radius=12, width=1)
        draw.text((lx, ly), label, font=SMALL_FONT, fill=COLORS["muted"])


def chip(x, y, label, fill, text_fill=COLORS["ink"]):
    label_w = draw.textlength(label, font=SMALL_FONT)
    rounded_box(x, y, x + label_w + 28, y + 30, fill=fill, outline=fill, radius=15, width=1)
    draw.text((x + 14, y + 6), label, font=SMALL_FONT, fill=text_fill)


draw.text((80, 54), "Himalaya Basin Analytics WebApp - System Architecture", font=TITLE_FONT, fill=COLORS["ink"])
draw.text(
    (80, 108),
    "Report-friendly technical view of the local-first pipeline from scientific inputs to interactive outputs and offline packaging.",
    font=SUBTITLE_FONT,
    fill=COLORS["muted"],
)

chip(80, 152, "local-first", COLORS["accent_fill"], COLORS["accent"])
chip(194, 152, "technical report figure", COLORS["green_fill"], "#2f6b3c")
chip(420, 152, "offline deployable", COLORS["orange_fill"], "#8a5a12")

box_y1 = 210
box_y2 = 885
box_w = 318
gap = 42
x_positions = [80, 80 + box_w + gap, 80 + 2 * (box_w + gap), 80 + 3 * (box_w + gap), 80 + 4 * (box_w + gap), 80 + 5 * (box_w + gap)]

section_box(
    x_positions[0],
    box_y1,
    x_positions[0] + box_w,
    box_y2,
    "1. Data Sources",
    "External and project-owned inputs",
    [
        "ERA5-Land historical hydro-climatic point datasets",
        "CMIP6 future climate projection datasets",
        "SPHY model GeoTIFF and melt-related outputs",
        "MOD10A1 snow cover and albedo raster products",
        "Glacier, basin, and subregion vector assets",
        "Optional uploaded NetCDF scientific datasets",
    ],
)

section_box(
    x_positions[1],
    box_y1,
    x_positions[1] + box_w,
    box_y2,
    "2. Preprocessing",
    "Conversion and harmonization stage",
    [
        "Google Earth Engine export scripts align climate grids and DEM",
        "CSV, GeoTIFF, and NetCDF conversion utilities",
        "Unit normalization and date parsing for analysis consistency",
        "Parquet outputs with H1/H2 partitioning for large years",
        "Prepared map assets and basin geometries written locally",
    ],
    fill=COLORS["accent_fill"],
)

section_box(
    x_positions[2],
    box_y1,
    x_positions[2] + box_w,
    box_y2,
    "3. Local Storage",
    "Runtime data and static asset layer",
    [
        "Database/Full_Shape_ERA5 and Database/Full_shape_CMIP6 parquet stores",
        "Map_handle pmtiles, GeoJSON, and glyph assets",
        "Glacier and basin geometry files for spatial filtering",
        "Precomputed outcomes cached once for repeated fast loading",
        "Uploaded NetCDF metadata tracked separately from core data",
    ],
)

section_box(
    x_positions[3],
    box_y1,
    x_positions[3] + box_w,
    box_y2,
    "4. FastAPI Backend",
    "Filtering, aggregation, and response layer",
    [
        "Dataset discovery and year-window indexing",
        "Selective parquet reads with cached metadata",
        "Spatial filters: elevation, rectangle, subregion, glacier",
        "APIs for data, basin mean, region mean, hotspot, and outcomes",
        "NetCDF upload pipeline for app-compatible datasets",
    ],
)

section_box(
    x_positions[4],
    box_y1,
    x_positions[4] + box_w,
    box_y2,
    "5. React Frontend",
    "Interaction and visualization layer",
    [
        "React UI with startup dataset and year-range selection",
        "MapLibre plus PMTiles for basemap and boundary rendering",
        "Deck.GL point rendering for map-based variable display",
        "Time slider, graph zoom, docs, and outcome panels",
        "Theme toggle and local scientific interaction workflow",
    ],
    fill=COLORS["accent_fill"],
)

section_box(
    x_positions[5],
    box_y1,
    x_positions[5] + box_w,
    box_y2,
    "6. User Outputs",
    "Report and analysis deliverables",
    [
        "Daily spatial maps for selected variable and date",
        "Basin mean and region mean time-series plots",
        "Long-term hotspot trend maps and summary metrics",
        "Precomputed long-window outcome maps",
        "Offline Windows bundle for non-developer use",
    ],
)

mid_y = box_y2 + 34
flow_labels = [
    "raw inputs",
    "prepared files",
    "selective reads",
    "filtered API responses",
    "maps + graphs",
]
for idx in range(5):
    x1 = x_positions[idx] + box_w + 8
    x2 = x_positions[idx + 1] - 10
    arrow(x1, mid_y, x2, mid_y, label=flow_labels[idx])

rounded_box(80, 970, 2120, 1180, fill=COLORS["note_fill"], outline=COLORS["line"], radius=18, width=2)
draw.text((108, 990), "Runtime boundary", font=SECTION_FONT, fill=COLORS["accent"])
text_block(
    "The backend only loads the active dataset, selected year window, selected variable, and selected spatial filter. "
    "That keeps the WebApp responsive while preserving traceable scientific logic and reproducible queries.",
    (108, 1030, 1400, 1140),
    BODY_FONT,
    fill=COLORS["ink"],
    line_gap=8,
)

rounded_box(1450, 980, 2100, 1160, fill="white", outline=COLORS["line"], radius=18, width=2)
draw.text((1478, 1000), "Deployment notes", font=SECTION_FONT, fill=COLORS["accent"])
deploy_items = [
    "pack_offline.ps1 builds the Windows bundle",
    "backend and frontend can run locally without cloud services",
    "report figure is safe to embed in documentation or slides",
]
y = 1040
for item in deploy_items:
    draw.ellipse((1478, y + 8, 1488, y + 18), fill=COLORS["accent"])
    y = text_block(item, (1502, y, 2074, y + 34), SMALL_FONT, fill=COLORS["ink"], line_gap=4)
    y += 10

draw.line((80, 1260, 2120, 1260), fill=COLORS["line"], width=2)
draw.text((80, 1284), "Figure note: architecture summary for report use. Data preparation occurs before runtime; analysis requests remain local during execution.", font=SMALL_FONT, fill=COLORS["muted"])
draw.text((80, 1320), "Himalaya Basin Analytics WebApp", font=MONO_FONT, fill=COLORS["muted"])
draw.text((1440, 1320), "Script: Reports/assets/generate_system_architecture_diagram.py", font=MONO_FONT, fill=COLORS["muted"])

img.save(OUT_FILE)
print(f"Saved: {OUT_FILE}")
