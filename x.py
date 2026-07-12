from skyfield.api import load
import matplotlib.pyplot as plt
import numpy as np
from datetime import timedelta, date

# 1. Load astronomical data
planets = load('de421.bsp')
ts = load.timescale()
sun = planets['sun']
earth = planets['earth']

# Define the date (e.g., Feb 10, 2026)
t = ts.utc(2026, 2, 10)

# 2. Calculate Positions (Example: Earth)
astrometric = sun.at(t).observe(earth)
x, y, z = astrometric.position.au

# 3. Setup the Minimalist Plot (9x11 cm is approx 3.5 x 4.3 inches)
fig, ax = plt.subplots(figsize=(3.5, 4.33))
ax.set_aspect('equal')
ax.axis('off') # Turn off all grids and borders

# Draw the Sun
ax.plot(0, 0, 'ko', markersize=8)

# Draw Earth's Orbit (simplified circle)
circle = plt.Circle((0, 0), 1, color='black', fill=False, linewidth=0.5)
ax.add_patch(circle)

# Draw Earth's Position
ax.plot(x, y, 'ko', markersize=4)
ax.text(x+0.1, y+0.1, 'Earth', fontsize=6)

# Add Date Text
plt.title("Tuesday, February 10\n2026", fontsize=10, pad=20)

# Save the page
plt.savefig('page_041.png', dpi=300, bbox_inches='tight')