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
rem Prefer 3.12 / 3.13 (widest package support for YOLO, PyTorch, OpenCV), else newest installed
set PYVER=-3
py -3.12 --version >nul 2>nul && set PYVER=-3.12
if "%PYVER%"=="-3" py -3.13 --version >nul 2>nul && set PYVER=-3.13
if not exist .venv\Scripts\python.exe (
  echo Creating Python environment with py %PYVER% ...
  py %PYVER% -m venv .venv
)
call .venv\Scripts\activate.bat
if not exist .venv\installed.ok (
  echo Installing packages - first run only...
  python -m pip install --upgrade pip
  pip install -r requirements.txt || (echo Install failed - see messages above & pause & exit /b 1)
  echo ok> .venv\installed.ok
)
rem Skip Streamlit's one-off "enter your email" prompt
if not exist "%USERPROFILE%\.streamlit\credentials.toml" (
  mkdir "%USERPROFILE%\.streamlit" 2>nul
  (echo [general]& echo email = "") > "%USERPROFILE%\.streamlit\credentials.toml"
)
echo Starting app - your browser will open at http://localhost:8501  (close this window to stop)
streamlit run app.py
pause
