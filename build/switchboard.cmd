@echo off
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\Switchboard.exe" "%~dp0..\resources\app.asar\bin\cli.js" %*
