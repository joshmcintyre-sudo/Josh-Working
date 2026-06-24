@echo off
:: SW Fast Viewer — drag .sldprt or .sldasm files onto this .bat
::
:: If Python isn't on PATH, update the line below to the full path, e.g.:
::   set PYTHON=C:\Python312\python.exe

set PYTHON=python

"%PYTHON%" "%~dp0sw_viewer.py" %*
if %errorlevel% neq 0 pause
