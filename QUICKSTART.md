# 🚀 Quick Start Guide

Follow these steps to get your temperature visualization system running in minutes.

## Step 1: Install Python Dependencies

```bash
cd d:\ISRO-SWOT\Webapp\backend
pip install -r requirements.txt
```

## Step 2: Convert CSV to Parquet (One-time)

```bash
# Ensure your CSV files are in d:\ISRO-SWOT\Temp_el_data_15_year\
cd d:\ISRO-SWOT\Webapp\backend
python convert_csv_to_parquet.py
```

**Expected output:**
```
Converting 2009.csv...
  CSV: 113.00 MB → Parquet: 35.40 MB
  Compression: 68.7% reduction
✓ Converted successfully
...
```

## Step 3: Install Frontend Dependencies

```bash
cd d:\ISRO-SWOT\Webapp\frontend
npm install
```

## Step 4: Start Backend Server

```bash
cd d:\ISRO-SWOT\Webapp\backend
python main.py
```

**Expected output:**
```
INFO:     Started server process
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO:     Loading parquet file index...
INFO:     Total dates indexed: 5475
```

**Keep this terminal open!**

## Step 5: Start Frontend (New Terminal)

Open a **NEW** terminal:

```bash
cd d:\ISRO-SWOT\Webapp\frontend
npm run dev
```

**Expected output:**
```
VITE v5.0.8  ready in 523 ms

➜  Local:   http://localhost:5173/
➜  press h to show help
```

## Step 6: Open in Browser

Navigate to: **http://localhost:5173**

---

## ✅ Verification Checklist

- [ ] Backend running at http://127.0.0.1:8000
- [ ] Frontend running at http://localhost:5173
- [ ] Parquet files exist in Temp_el_data_15_year/
- [ ] Browser opened to http://localhost:5173
- [ ] Map displays with data points
- [ ] Date slider works
- [ ] Elevation filter updates map
- [ ] Graph shows temperature trend

---

## 🎮 Basic Usage

### Play Animation
1. Click **▶ Play** button
2. Watch temperature change over time
3. Click **⏸ Pause** to stop

### Change Elevation Range
1. Click preset buttons (Low/Mid/High)
2. Or use sliders to set custom range
3. Map and graph update automatically

### Jump to Specific Date
1. Use date slider
2. Or click "Jump to date" and select from calendar

### Explore Map
- **Pan**: Click and drag
- **Zoom**: Scroll wheel or pinch
- **Hover**: See temperature details

---

## 🐛 Common Issues

### Backend won't start
- Check if Python 3.8+ installed: `python --version`
- Verify virtual environment activated
- Install dependencies: `pip install -r requirements.txt`

### Frontend won't start
- Check if Node.js installed: `node --version`
- Delete `node_modules` and run `npm install` again
- Check port 5173 not in use

### No data showing
- Verify Parquet files in `Temp_el_data_15_year/`
- Check backend logs for errors
- Open http://127.0.0.1:8000/dates to verify data loaded

### Map blank or black
- Update graphics drivers
- Try different browser (Chrome recommended)
- Check browser console (F12) for WebGL errors

---

## 📞 Next Steps

Once everything works:
1. Experiment with different elevation ranges
2. Try different animation speeds
3. Explore seasonal temperature patterns
4. View the full README.md for advanced features

---

**Enjoy exploring your temperature data! 🌡️**
