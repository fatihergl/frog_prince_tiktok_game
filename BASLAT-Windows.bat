@echo off
chcp 65001 >nul
title Kurbaga Prens
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js kurulu degil. https://nodejs.org adresinden LTS surumunu kur. & pause & exit /b)
if not exist node_modules (echo Ilk kurulum yapiliyor... & call npm install)
start "" http://localhost:3000/panel
node server.js
pause
