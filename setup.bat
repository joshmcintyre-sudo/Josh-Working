@echo off
echo ============================================================
echo  SW Fast Viewer — one-time setup
echo ============================================================
echo.

:: Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python not found on PATH.
    echo Download from https://www.python.org/downloads/
    echo Make sure "Add Python to PATH" is checked during install.
    pause
    exit /b 1
)

echo Installing / upgrading dependencies…
python -m pip install --upgrade pip pywin32 pyvista numpy
if %errorlevel% neq 0 (
    echo.
    echo ERROR: pip install failed.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  Setup complete!
echo.
echo  HOW TO USE
echo  ----------
echo  1. Drag any .sldprt or .sldasm file onto  sw_viewer.bat
echo.
echo  OPTIONAL: set as default file-open program
echo  (run this window as Administrator first, then uncomment):
echo.
echo  assoc .sldprt=SWFastViewer
echo  assoc .sldasm=SWFastViewer
echo  ftype SWFastViewer=python "%~dp0sw_viewer.py" "%%1"
echo ============================================================
echo.
pause
