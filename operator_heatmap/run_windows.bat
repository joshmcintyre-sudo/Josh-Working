@echo off
rem Double-click to start the Operator Heat Map app (first run installs everything, ~5-10 min)
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install Python 3.11 or newer from https://www.python.org/downloads/
  echo Tick "Add python.exe to PATH" during install, then double-click this file again.
  pause
  exit /b 1
)
if not exist .venv\Scripts\python.exe (
  echo Creating Python environment...
  py -3 -m venv .venv
)
call .venv\Scripts\activate.bat
if not exist .venv\installed.ok (
  echo Installing packages - first run only...
  python -m pip install --upgrade pip
  pip install -r requirements.txt || (echo Install failed - see messages above & pause & exit /b 1)
  echo ok> .venv\installed.ok
)
echo Starting app - your browser will open at http://localhost:8501  (close this window to stop)
streamlit run app.py
pause
