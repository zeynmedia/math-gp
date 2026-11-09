@echo off
title Math GP canli yayin
cd /d "%~dp0"
rem Sleep off while plugged in so the stream keeps running; the screen can still turn off or be locked.
powercfg /change standby-timeout-ac 0 >nul 2>&1
:loop
python stream\pc.py
echo Yayin durdu, 10 saniye sonra yeniden basliyor... (kapatmak icin pencereyi kapat)
timeout /t 10 >nul
goto loop
