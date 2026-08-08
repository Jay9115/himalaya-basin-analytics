from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "system_architecture_journal.png"


def add_round_box(ax, x, y, w, h, title, body, face, edge="#1f2937", title_size=12, body_size=9):
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle="round,pad=0.012,rounding_size=0.02",
        linewidth=1.6,
        edgecolor=edge,
        facecolor=face,
    )
    ax.add_patch(patch)
    ax.text(
        x + 0.02 * w,
        y + h - 0.14 * h,
        title,
        ha="left",
        va="top",
        fontsize=title_size,
        fontweight="bold",
        color="#111827",
    )
    ax.text(
        x + 0.02 * w,
        y + h - 0.29 * h,
        body,
        ha="left",
        va="top",
        fontsize=body_size,
        color="#1f2937",
        linespacing=1.35,
    )


def add_arrow(ax, start, end, color="#475569", lw=1.8, style="-|>", mutation=15, connectionstyle="arc3,rad=0.0"):
    arrow = FancyArrowPatch(
        start,
        end,
        arrowstyle=style,
        mutation_scale=mutation,
        linewidth=lw,
        color=color,
        connectionstyle=connectionstyle,
    )
    ax.add_patch(arrow)


def main():
    fig = plt.figure(figsize=(16, 10), dpi=300, facecolor="white")
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    fig.text(
        0.5,
        0.965,
        "Himalaya Basin Analytics: System Architecture",
        ha="center",
        va="top",
        fontsize=21,
        fontweight="bold",
        color="#0f172a",
    )
    fig.text(
        0.5,
        0.935,
        "Local-first geospatial visualization, scientific analytics, programmable research workspace, and optional AI assistance",
        ha="center",
        va="top",
        fontsize=11,
        color="#475569",
    )

    # Left actor
    add_round_box(
        ax,
        0.04,
        0.67,
        0.15,
        0.17,
        "Research User",
        "Scientist, analyst,\nintern, or domain\nresearcher using the\ndashboard and code tools.",
        face="#f8fafc",
    )

    # Presentation layer
    add_round_box(
        ax,
        0.24,
        0.66,
        0.36,
        0.22,
        "Presentation Layer",
        "React + Vite frontend\n"
        "• App state orchestration and dataset selection\n"
        "• Deck.GL + MapLibre geospatial rendering\n"
        "• Time slider, elevation filter, and temporal graphs\n"
        "• Documentation and outcome views\n"
        "• Monaco-based code panel and chatbot UI",
        face="#dbeafe",
    )

    # Main backend
    add_round_box(
        ax,
        0.24,
        0.36,
        0.36,
        0.24,
        "Application Layer",
        "FastAPI backend\n"
        "• Dataset registry and runtime path resolution\n"
        "• Year/date/variable/elevation indexing\n"
        "• Spatial filtering by basin, glacier, and bounding box\n"
        "• Map-point extraction and scientific aggregation\n"
        "• Static asset serving, SPA fallback, and outcome loading",
        face="#e0f2fe",
    )

    # Custom operations
    add_round_box(
        ax,
        0.64,
        0.55,
        0.16,
        0.21,
        "Research Sandbox",
        "Custom operations engine\n"
        "• AST validation\n"
        "• Execution planning\n"
        "• Subprocess isolation\n"
        "• Tables, charts,\n  map layers, exports\n"
        "• Large-job support",
        face="#ecfccb",
    )

    # LLM service
    add_round_box(
        ax,
        0.82,
        0.55,
        0.14,
        0.21,
        "Optional AI Layer",
        "Local LLM service\n"
        "• Health and model status\n"
        "• Chat assistance\n"
        "• Code generation\n"
        "• Explanation support\n"
        "Runs separately on port 8010.",
        face="#fae8ff",
    )

    # Outcomes
    add_round_box(
        ax,
        0.64,
        0.31,
        0.32,
        0.17,
        "Outcome Module Layer",
        "Precomputed scientific products\n"
        "• Long-term hotspot metadata\n"
        "• Band-mean and band-difference outputs\n"
        "• Dedicated frontend outcome page\n"
        "Supports reproducible publication-ready derived results.",
        face="#fef3c7",
    )

    # Data layer
    add_round_box(
        ax,
        0.13,
        0.05,
        0.74,
        0.20,
        "Data and Asset Layer",
        "Scientific data store and runtime resources\n"
        "• Climate and hydro-meteorological datasets: Parquet\n"
        "• Snow/albedo rasters: GeoTIFF\n"
        "• Vector and network layers: GeoParquet, Shapefile, GeoJSON, PMTiles\n"
        "• User-uploaded NetCDF converted into app-compatible Parquet datasets\n"
        "• Glacier, basin, and administrative map assets\n"
        "• Outcome bundles and offline packaging resources",
        face="#f8fafc",
    )

    # Packaging layer
    add_round_box(
        ax,
        0.04,
        0.31,
        0.15,
        0.21,
        "Deployment Layer",
        "Developer mode\nOffline packaged mode\nHosted backend mode\nOptional local LLM mode\n\nScripts:\nstart.bat\nstop.bat\npack_offline.ps1",
        face="#f1f5f9",
    )

    # Flow arrows
    add_arrow(ax, (0.19, 0.755), (0.24, 0.755), color="#334155", lw=2.1)
    add_arrow(ax, (0.42, 0.66), (0.42, 0.60), color="#2563eb", lw=2.2)
    add_arrow(ax, (0.60, 0.73), (0.64, 0.65), color="#65a30d", lw=2.0)
    add_arrow(ax, (0.60, 0.73), (0.82, 0.67), color="#a855f7", lw=1.8, connectionstyle="arc3,rad=-0.08")
    add_arrow(ax, (0.42, 0.36), (0.42, 0.25), color="#0f766e", lw=2.2)
    add_arrow(ax, (0.72, 0.55), (0.50, 0.48), color="#4d7c0f", lw=1.7, connectionstyle="arc3,rad=0.08")
    add_arrow(ax, (0.64, 0.395), (0.59, 0.395), color="#b45309", lw=1.8)
    add_arrow(ax, (0.12, 0.52), (0.24, 0.46), color="#64748b", lw=1.7, connectionstyle="arc3,rad=-0.03")

    # Labels for flows
    ax.text(0.435, 0.625, "API calls", fontsize=9, color="#2563eb", rotation=90, va="center")
    ax.text(0.435, 0.29, "filtered access", fontsize=9, color="#0f766e", rotation=90, va="center")

    # Footer note
    fig.text(
        0.5,
        0.02,
        "Figure: Layered architecture showing user interaction, frontend presentation, FastAPI orchestration, research extensions, optional LLM assistance, and scientific storage assets.",
        ha="center",
        va="bottom",
        fontsize=9,
        color="#475569",
    )

    fig.savefig(OUTPUT, dpi=300, bbox_inches="tight", facecolor="white")
    print(f"Saved: {OUTPUT}")


if __name__ == "__main__":
    main()
