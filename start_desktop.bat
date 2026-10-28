@echo off
setlocal
pushd "%~dp0" || goto :nodir

where bun >nul 2>nul || goto :nobun

if not exist "node_modules\" (
	echo Installing dependencies with "bun install"...
	call bun install || goto :fail
)

call bun run desktop:dev %*
if %errorlevel% neq 0 goto :fail
popd
exit /b 0

:nobun
echo.
echo Bun was not found on PATH. ThinkRail needs Bun 1.4.4 or newer.
echo Install it from https://bun.sh, for example:
echo     powershell -c "irm bun.sh/install.ps1 | iex"
echo Then open a new terminal and run start_desktop.bat again.
echo.
pause
popd
exit /b 9009

:nodir
echo Could not change to the repository directory "%~dp0".
pause
exit /b 1

:fail
set "code=%errorlevel%"
echo.
echo start_desktop.bat failed with exit code %code%.
pause
popd
exit /b %code%
