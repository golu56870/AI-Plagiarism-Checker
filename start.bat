@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js PATH mein nahi mila.
  echo Is project ko run karne ke liye Node.js install karke new terminal kholo.
  echo Ya phir isi folder mein command chalao: node server.js
  exit /b 1
)

node server.js
