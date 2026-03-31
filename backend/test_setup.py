"""
Test script to verify backend setup and data availability
Run this after converting CSV to Parquet
"""
import sys
from pathlib import Path
import pandas as pd

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

def test_imports():
    """Test if all required packages are installed"""
    print("Testing imports...")
    try:
        import fastapi
        import uvicorn
        import pandas
        import pyarrow
        print("✓ All required packages installed")
        return True
    except ImportError as e:
        print(f"✗ Missing package: {e}")
        print("  Run: pip install -r requirements.txt")
        return False

def test_data_files():
    """Test if Parquet files exist"""
    print("\nTesting data files...")
    data_dir = Path(__file__).parent.parent.parent / "Temp_el_data_15_year"
    
    if not data_dir.exists():
        print(f"✗ Data directory not found: {data_dir}")
        return False
    
    parquet_files = list(data_dir.glob("*.parquet"))
    
    if not parquet_files:
        print(f"✗ No Parquet files found in {data_dir}")
        print("  Run: python convert_csv_to_parquet.py")
        return False
    
    print(f"✓ Found {len(parquet_files)} Parquet files")
    
    # Test reading first file
    try:
        df = pd.read_parquet(parquet_files[0])
        print(f"✓ Successfully read sample file: {parquet_files[0].name}")
        print(f"  Columns: {list(df.columns)}")
        print(f"  Rows: {len(df):,}")
        print(f"  Date range: {df['date'].min()} to {df['date'].max()}")
        print(f"  Elevation range: {df['elevation_m'].min():.0f}m to {df['elevation_m'].max():.0f}m")
        print(f"  Temperature range: {df['temperature_C'].min():.2f}°C to {df['temperature_C'].max():.2f}°C")
        return True
    except Exception as e:
        print(f"✗ Error reading Parquet file: {e}")
        return False

def test_api_startup():
    """Test if API can start (basic import test)"""
    print("\nTesting API module...")
    try:
        import main
        print("✓ API module loads successfully")
        return True
    except Exception as e:
        print(f"✗ Error loading API: {e}")
        return False

def main():
    print("="*60)
    print("Temperature Visualization System - Backend Test")
    print("="*60)
    print()
    
    results = []
    results.append(("Imports", test_imports()))
    results.append(("Data Files", test_data_files()))
    results.append(("API Module", test_api_startup()))
    
    print("\n" + "="*60)
    print("Test Summary:")
    print("="*60)
    
    all_passed = True
    for test_name, passed in results:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{test_name:20s} {status}")
        if not passed:
            all_passed = False
    
    print("="*60)
    
    if all_passed:
        print("\n🎉 All tests passed! You can now start the server:")
        print("   python main.py")
    else:
        print("\n⚠️  Some tests failed. Please fix the issues above.")
    
    print()

if __name__ == "__main__":
    main()
