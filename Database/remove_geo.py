import pandas as pd
import os
import glob
from pathlib import Path

def remove_geo_column_from_folder(folder_path):
    """
    Remove '.geo' column from all CSV files in the specified folder.

    Args:
        folder_path (str): Path to the folder containing CSV files
    """

    # Convert to Path object for better path handling
    folder = Path(folder_path)

    # Check if folder exists
    if not folder.exists():
        print(f"Error: Folder '{folder_path}' does not exist!")
        return

    # Find all CSV files in the folder
    csv_files = list(folder.glob("*.csv"))

    if not csv_files:
        print(f"No CSV files found in '{folder_path}'")
        return

    print(f"Found {len(csv_files)} CSV files in '{folder_path}'")
    print("-" * 50)

    success_count = 0
    error_count = 0

    for csv_file in csv_files:
        try:
            print(f"Processing: {csv_file.name}")

            # Read the CSV file
            df = pd.read_csv(csv_file)

            # Check if .geo column exists
            if '.geo' in df.columns:
                # Remove the .geo column
                df_cleaned = df.drop(columns=['.geo'])

                # Save the cleaned data back to the same file
                df_cleaned.to_csv(csv_file, index=False)

                print(f"  ✓ Removed '.geo' column from {csv_file.name}")
                success_count += 1
            else:
                print(f"  ⚠ '.geo' column not found in {csv_file.name}")
                success_count += 1

        except Exception as e:
            print(f"  ✗ Error processing {csv_file.name}: {str(e)}")
            error_count += 1

    print("-" * 50)
    print(f"Successfully processed: {success_count} files")
    if error_count > 0:
        print(f"Errors encountered: {error_count} files")
    print("Operation completed!")

def main():
    """
    Main function to execute the geo column removal.
    Modify the folder_path variable below to point to your target folder.
    """

    # ========== MODIFY THIS PATH TO YOUR TARGET FOLDER ==========
    folder_path = r"D:\ISRO-SWOT\Webapp\Database\Full_Shape_ERA5"
    # ============================================================

    print(f"Starting to remove '.geo' column from CSV files in:")
    print(f"{folder_path}")
    print("=" * 60)

    # Execute the removal process
    remove_geo_column_from_folder(folder_path)

if __name__ == "__main__":
    main()