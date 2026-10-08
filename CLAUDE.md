# Working notes for Claude

## User environment
- The user always runs tools on **Windows** (Windows 10/11). Write instructions, launchers and paths for Windows first:
  - double-click `.bat` launchers, PowerShell/cmd commands (not bash), `py -3` for Python
  - Windows paths (`C:\...`, `\\server\share\...`), Explorer/Paint for file and pixel lookups
- Only mention Mac/Linux if asked.

## Projects
- `operator_heatmap/` – factory camera footage (fixed, 360 ceiling fisheye, 360 panorama) → operator heat map +
  spaghetti PDF. Start on Windows with `operator_heatmap\run_windows.bat`. Ceiling camera is a round fisheye.
- `3d_viewer.html` – standalone HTML 3D viewer.
