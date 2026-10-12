@echo off
REM Poka-yoke vision station - double-click to start, then open the browser full screen (F11).
cd /d %~dp0
if not exist .venv (
  py -3 -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
start "" http://127.0.0.1:8080/
.venv\Scripts\python -m pokayoke.app
