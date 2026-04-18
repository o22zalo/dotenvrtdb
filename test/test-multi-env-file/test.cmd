@echo off
setlocal

cd /d "%~dp0"

dotenvrtdb -e .env.one -e .env.two -- node test-multi-env-file.js

echo.
pause