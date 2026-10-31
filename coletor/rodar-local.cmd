@echo off
rem Coleta completa do swipe pelo PC. A internet residencial recebe a paginação inteira
rem da Biblioteca (100 anúncios por busca); o GitHub, com IP de servidor, só recebe ~30.
rem A chave do robô fica em .env.local (fora do git), numa linha COLETOR_KEY=...
cd /d "%~dp0"
for /f "usebackq tokens=1,* delims==" %%a in (".env.local") do set "%%a=%%b"
if not exist logs mkdir logs
echo ==== %date% %time% >> "logs\coleta.log"
node coletar.mjs >> "logs\coleta.log" 2>&1
