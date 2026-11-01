@echo off
REM Niles Telegram Bot Poller — Scheduled Task Wrapper
REM Runs every 30 minutes via Windows Task Scheduler

cd /d "%~dp0"

echo [%date% %time%] Starting Telegram Bot Poller...

REM Run the poller
python telegram_bot_poller.py

REM Log output
echo [%date% %time%] Poller completed. >> poller.log 2>&1
