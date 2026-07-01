@echo off
title 01VMIX - Inicializador
echo ======================================================
echo    INICIANDO O CONTROLADOR WEB YAMAHA 01V96 (01VMIX)
echo ======================================================
echo.

:: Navega para a pasta do script
cd /d "%~dp0"

:: Inicia o servidor Node.js em segundo plano
echo [1/3] Iniciando servidor do Node.js...
start "01VMIX Server" /min node server.js

:: Aguarda 2 segundos para o servidor e as portas MIDI iniciarem
echo [2/3] Aguardando inicializacao do sistema...
timeout /t 2 /nobreak >nul

:: Abre o navegador padrão no endereço local
echo [3/3] Abrindo o painel de controle no navegador...
start http://localhost:3000

echo.
echo ======================================================
echo    SISTEMA ATIVO! (01VMIX)
echo    Mantenha a janela do servidor aberta em segundo plano.
echo ======================================================
echo.
pause
