@echo off
REM One-time setup on the station PC (no admin needed):
REM  1. Python environment + packages
REM  2. Start the station app hidden at Windows login
REM  3. Register pokayoke:// links so Ops Hub can launch it even if it isn't running
cd /d %~dp0
if not exist .venv (
  py -3 -m venv .venv || (echo Install Python 3.11+ from python.org first & pause & exit /b 1)
)
.venv\Scripts\pip install -r requirements.txt

set APPDIR=%~dp0
set PYW=%APPDIR%.venv\Scripts\pythonw.exe

powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Poka-Yoke Station.lnk');" ^
  "$s.TargetPath='%PYW%'; $s.Arguments='-m pokayoke.app'; $s.WorkingDirectory='%APPDIR%'; $s.Save()"

reg add "HKCU\Software\Classes\pokayoke" /ve /d "URL:Poka-Yoke Station" /f >nul
reg add "HKCU\Software\Classes\pokayoke" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\pokayoke\shell\open\command" /ve /d "\"%PYW%\" -m pokayoke.launcher \"%%1\"" /f >nul

start "" "%PYW%" -m pokayoke.app
echo.
echo Installed. Station starts at login; Ops Hub can launch it with pokayoke:// links.
echo Operator screen: http://127.0.0.1:8080/
pause
