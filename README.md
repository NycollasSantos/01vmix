# 01VMIX

Interface de controle web para mesa digital **Yamaha 01V96**.

![License](https://img.shields.io/badge/license-ISC-blue)

## Requisitos

- **Node.js** 18 ou superior ([baixar](https://nodejs.org/))
- Uma mesa **Yamaha 01V96** conectada via USB MIDI (opcional — o sistema funciona em **modo demo** sem a mesa)

## Instalação

```bash
# 1. Instalar as dependências
npm install

# 2. Iniciar o servidor
npm start
```

O servidor será iniciado na porta **3000**. Abra o navegador em:

```
http://localhost:3000
```

## Início Rápido (Windows)

Dê um duplo clique no arquivo **`Iniciar_01VMIX.bat`** — ele inicia o servidor e abre o navegador automaticamente.

## Como Usar

### Modo Demo (sem a mesa)

Por padrão, o sistema inicia em **Modo Demo** — todos os faders, mute e EQ funcionam virtualmente, sem necessidade da mesa física.

### Conectando à Mesa Yamaha 01V96

1. Conecte a 01V96 ao computador via USB.
2. Na 01V96, vá em `MIDI SETUP` e certifique-se de que:
   - `MIDI IN/OUT` está configurado como **USB**
   - `SYSEX` está habilitado
3. No painel do 01VMIX, clique em **MIDI Settings** e selecione as portas de entrada e saída da 01V96.

### Funcionalidades

- **Faders** — controle de nível para 32 canais de entrada, 8 aux, 8 bus, FX returns e master
- **Mute** — mute individual por canal
- **EQ Paramétrico** — 4 bandas com ganho, frequência e Q
- **Pan** — ajuste estéreo por canal
- **Roteamento** — envio para LR e BUS 1–8 por canal
- **AUX Sends** — nível de envio dos canais para os barramentos AUX
- **FX Internos** — 2 processadores FX com 8 tipos de efeito (reverb, delay, chorus, flanger, phaser, tremolo, autopan, distortion)
- **Cenas (Scenes)** — salve e carregue snapshots completas do mixer
- **Bus Solo** — solo por bus (dimming dos demais canais)

## Estrutura do Projeto

```
01vmix/
├── server.js          # Servidor Node.js (Express + WebSocket + MIDI)
├── midi-protocol.js   # Protocolo MIDI SysEx da Yamaha 01V96
├── package.json       # Dependências e scripts
├── scenes.json        # Cenas salvas
├── Iniciar_01VMIX.bat # Atalho para Windows
├── public/            # Frontend (HTML, CSS, JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── README.md
```

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm start` | Inicia o servidor na porta 3000 |
| `Iniciar_01VMIX.bat` | Inicia servidor + abre navegador (Windows) |

## Licença

ISC
