# Custom Operations Backend

This package adds a Google Earth Engine style backend surface for running Python against a selected app dataset.

## API

- `GET /operations/capabilities`
- `POST /operations/plan`
- `POST /operations/validate`
- `POST /operations/run`
- `POST /operations/jobs`
- `GET /operations/jobs/{job_id}`
- `GET /operations/jobs/{job_id}/logs`
- `POST /operations/jobs/{job_id}/cancel`

The frontend should send selected dataset/date/elevation/subregion/variable context plus Monaco code to `/operations/run`.
The backend loads the selected data through existing app query functions and passes only a normalized dataframe to the runner.
For large selections, the frontend should call `/operations/plan` first and submit to `/operations/jobs` when the plan returns `execution_mode="large"`.

## User Code Contract

User code receives:

- `df`: pandas dataframe with `dataset`, `date`, `lat`, `lon`, `elev`, `variable`, and `value`
- `meta`: selection metadata
- `hb`: output helper
- `pd`, `np`, `math`, `statistics`

Recommended shape:

```python
def run(hb, df, meta):
    daily = df.groupby("date", as_index=False)["value"].mean()
    hb.table(daily, name="daily_mean")
    hb.number("overall_mean", df["value"].mean())
    hb.chart(daily, chart_type="line", x="date", y="value", name="daily_line")
    hb.chart_scatter(df, x="elev", y="value", name="elev_vs_value")
    hb.chart_histogram(df, value="value", bins=20, name="distribution")
    hb.map_points(df, style={"palette": "viridis", "radius": 4})
    hb.export_csv(daily, filename="daily_mean.csv")
```

Supported chart outputs today:

- `line`
- `bar`
- `area`
- `scatter`
- `pie`
- `histogram`

## Large Analysis Contract

Large jobs are designed for long date ranges and large row counts. They run separately from inline operations:

```python
def run(hb, meta):
    annual = hb.aggregate(by=["year"], metrics={"value": "mean"})
    hb.table(annual, name="annual_mean")
    hb.chart(annual, chart_type="line", x="year", y="value_mean")
    hb.export_csv(annual, filename="annual_mean.csv")
```

Large mode intentionally does not provide a full `df` dataframe. Use:

- `hb.iter_data()` for chunk-by-chunk scans
- `hb.aggregate(by=[...], metrics={...})` for common long-range summaries
- `hb.sample(max_rows=10000)` for preview rows
- `hb.to_frame(max_rows=...)` only when a bounded dataframe is explicitly needed

The selection can cover many years, but returned UI outputs remain capped. Full results should be exported from the job workspace.

## Security Boundary

The current runner uses:

- static AST validation
- restricted imports and builtins
- isolated subprocess execution
- timeout and output caps
- Linux resource limits when available
- no raw dataset file paths in user code

This is suitable for local-first development and controlled deployments. For public multi-user PaaS use, keep the same API but replace `LocalSubprocessSandbox` with a container or microVM runner that disables network and mounts a disposable filesystem.
