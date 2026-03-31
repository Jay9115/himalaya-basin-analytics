# Temperature Visualization System Configuration

## Backend Configuration

### Data Directory
By default, the backend looks for Parquet files in:
```
d:\ISRO-SWOT\Temp_el_data_15_year\
```

To change this, edit `backend/main.py` line 23:
```python
DATA_DIR = Path(__file__).parent.parent.parent / "Temp_el_data_15_year"
```

### Server Settings

Edit `backend/main.py` to change server configuration:

```python
# At the bottom of main.py:
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app, 
        host="127.0.0.1",  # Change to "0.0.0.0" for network access
        port=8000,          # Change port if needed
        log_level="info"    # Options: debug, info, warning, error
    )
```

### Cache Settings

Adjust query cache size in `backend/main.py` line 33:
```python
@lru_cache(maxsize=100)  # Change 100 to desired cache size
```

### CORS Settings

To allow access from different origins, edit `backend/main.py` lines 27-33:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],  # Add more origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

## Frontend Configuration

### API Endpoint

To change backend URL, edit `frontend/src/services/api.js` line 3:
```javascript
const API_BASE_URL = 'http://127.0.0.1:8000';
```

### Development Server Port

Edit `frontend/vite.config.js`:
```javascript
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,      // Change port
    host: 'localhost' // Change to '0.0.0.0' for network access
  }
})
```

### Cache Settings

Edit `frontend/src/services/api.js` line 12:
```javascript
this.maxCacheSize = 50;  // Change cache size
```

### Map Configuration

Edit `frontend/src/components/MapView.jsx`:

**Initial View Position:**
```javascript
const INITIAL_VIEW_STATE = {
  longitude: 75.5,   // Basin center
  latitude: 34.0,
  zoom: 6,           // Initial zoom level
  pitch: 0,          // 3D tilt (0-60)
  bearing: 0,        // Rotation (0-360)
};
```

**Point Size:**
```javascript
const scatterLayer = new ScatterplotLayer({
  // ...
  radiusMinPixels: 2,    // Minimum point size
  radiusMaxPixels: 8,    // Maximum point size
  getRadius: 300,        // Radius in meters
});
```

**Color Scale:**
```javascript
const getColorForTemp = (temp) => {
  const normalized = (temp + 40) / 80;  // Adjust range: (temp - min) / (max - min)
  
  // Change these thresholds and colors
  if (normalized < 0.2) return [0, 0, 255, 200];      // Very cold: blue
  else if (normalized < 0.4) return [0, 150, 255, 200];  // Cold: light blue
  else if (normalized < 0.6) return [0, 255, 0, 200];    // Moderate: green
  else if (normalized < 0.8) return [255, 200, 0, 200];  // Warm: yellow
  else return [255, 0, 0, 200];                          // Hot: red
};
```

### Animation Settings

Edit `frontend/src/App.jsx` line 16:
```javascript
const [playSpeed, setPlaySpeed] = useState(500);  // Default speed in ms
```

Available speeds in TimeSlider (line 64-71 in TimeSlider.jsx):
```javascript
// Change these values:
<button onClick={() => handleSpeedSelect(1000)}>0.5×</button>  // 1000ms = 1 sec
<button onClick={() => handleSpeedSelect(500)}>1×</button>     // 500ms
<button onClick={() => handleSpeedSelect(250)}>2×</button>     // 250ms
<button onClick={() => handleSpeedSelect(100)}>5×</button>     // 100ms
```

### Theme Colors

Edit `frontend/src/App.css` to change color scheme:

```css
:root {
  --bg-primary: #0a0e27;      /* Main background */
  --bg-secondary: #1a1f3a;    /* Panel background */
  --bg-tertiary: #2d3748;     /* Component background */
  --accent-primary: #4dabf7;  /* Primary accent (blue) */
  --accent-secondary: #51cf66; /* Secondary accent (green) */
  --text-primary: #ffffff;    /* Primary text */
  --text-secondary: #a0aec0;  /* Secondary text */
}
```

### Basemap Style

Edit `frontend/src/components/MapView.jsx` line 127:
```javascript
<Map
  mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
  // Other options:
  // mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"  // Light theme
  // mapStyle="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"   // Colorful
  attributionControl={false}
/>
```

## Performance Tuning

### For Slower Systems

1. **Reduce data points per query:**
   - Use smaller elevation ranges
   - Implement spatial downsampling in backend

2. **Reduce animation frame rate:**
   - Increase playSpeed values (slower = fewer frames)

3. **Optimize rendering:**
   - Reduce `radiusMinPixels` and `radiusMaxPixels` in MapView
   - Use `getRadius: 200` instead of 300

### For Faster Systems / Better GPU

1. **Increase data point limit:**
   - Backend: No strict limit currently
   - Frontend can handle 100k+ points

2. **Enable advanced features:**
   - Add HeatmapLayer instead of ScatterplotLayer
   - Increase point sizes
   - Add more layers (labels, boundaries, etc.)

## Data Format Customization

### Column Names

If your CSV has different column names, update converterter at `backend/convert_csv_to_parquet.py`:

```python
# After reading CSV, rename columns:
chunk = chunk.rename(columns={
    'Date': 'date',
    'Lat': 'latitude',
    'Lon': 'longitude',
    'Elev': 'elevation_m',
    'Temp': 'temperature_C'
})
```

And update backend queries in `main.py` accordingly.

## Network Access (Optional)

To access from other devices on your network:

1. **Backend** (`main.py`):
   ```python
   uvicorn.run(app, host="0.0.0.0", port=8000)
   ```

2. **Frontend** (`vite.config.js`):
   ```javascript
   server: {
     host: '0.0.0.0',
     port: 5173
   }
   ```

3. **Update API URL** (`frontend/src/services/api.js`):
   ```javascript
   const API_BASE_URL = 'http://YOUR_IP_ADDRESS:8000';
   ```

4. **Firewall**: Allow incoming connections on ports 8000 and 5173

## Environment Variables (Optional)

Create `.env` file in backend/:
```env
DATA_DIR=d:\ISRO-SWOT\Temp_el_data_15_year
SERVER_HOST=127.0.0.1
SERVER_PORT=8000
LOG_LEVEL=info
CACHE_SIZE=100
```

Then modify `main.py` to use:
```python
import os
from dotenv import load_dotenv

load_dotenv()

DATA_DIR = Path(os.getenv('DATA_DIR', './data'))
```

Install python-dotenv:
```bash
pip install python-dotenv
```

## Backup and Restore

### Backup Configuration
```bash
# Backup important files
copy backend\main.py backend\main.py.bak
copy frontend\src\services\api.js frontend\src\services\api.js.bak
copy frontend\src\components\MapView.jsx frontend\src\components\MapView.jsx.bak
```

### Restore Defaults
```bash
# Restore from version control if using Git
git checkout backend/main.py
git checkout frontend/src/services/api.js
```

## Troubleshooting Configuration Issues

1. **Changes not reflected:**
   - Backend: Restart Python server
   - Frontend: Refresh browser (Ctrl+Shift+R) or restart Vite

2. **API endpoint mismatch:**
   - Verify backend URL in browser: http://127.0.0.1:8000
   - Check frontend API_BASE_URL matches
   - Check CORS settings in backend

3. **Port conflicts:**
   - Change ports in both vite.config.js and main.py
   - Update API_BASE_URL to match new backend port

---

For more advanced customization, refer to official documentation:
- [FastAPI](https://fastapi.tiangolo.com/)
- [Deck.gl](https://deck.gl/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
