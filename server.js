const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const easymidi = require('easymidi');
const midiProtocol = require('./midi-protocol');

const PORT = process.env.PORT || 3000;
const SCENES_FILE = path.join(__dirname, 'scenes.json');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Armazena IPs locais e expõe via REST API
let localIPs = [];
app.get('/api/network', (req, res) => {
  res.json({ ips: localIPs, port: PORT });
});

// Servir arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Estado da conexão MIDI e faders
let midiInput = null;
let midiOutput = null;
let activeInputPort = null;
let activeOutputPort = null;
let midiStatus = 'Disconnected (Demo Mode)';

function createFXParams(type) {
  const base = { on: 1, mix: 64 };
  switch (type) {
    case 'reverb':   return { ...base, type, algorithm: 'hall', decay: 80, preDelay: 32, damping: 48, diffusion: 64 };
    case 'delay':    return { ...base, type, time: 64, feedback: 48, hpf: 0, lpf: 127 };
    case 'chorus':   return { ...base, type, rate: 48, depth: 64, delay: 32, feedback: 24 };
    case 'flanger':  return { ...base, type, rate: 32, depth: 72, delay: 16, feedback: 40 };
    case 'phaser':   return { ...base, type, rate: 40, depth: 56, feedback: 32, stages: 64 };
    case 'tremolo':  return { ...base, type, rate: 48, depth: 64, shape: 0 };
    case 'rotary':   return { ...base, type, speed: 0, drive: 32 };
    case 'distortion': return { ...base, type, drive: 48, tone: 64, master: 64 };
    default:         return { ...base, type: 'reverb', algorithm: 'hall', decay: 80, preDelay: 32, damping: 48, diffusion: 64 };
  }
}

// Armazena o estado atual dos faders e mutes de todas as camadas (Layers)
function createFactoryMixerState() {
  const state = {
    input: {},  // 1 a 32 (Canais de entrada)
    aux: {},    // 1 a 8 (Auxiliares de saída)
    bus: {},    // 1 a 8 (Buses de saída)
    master: {
      1: {
        fader: 0,
        mute: 0,
        name: 'STEREO',
        color: '#000000',
        eq: {
          on: 0, // 0 = OFF, 1 = ON
          bands: {
            1: { q: 64, freq: 20, gain: 64, type: 'peaking' }, // Low
            2: { q: 64, freq: 45, gain: 64, type: 'peaking' }, // Low-Mid
            3: { q: 64, freq: 80, gain: 64, type: 'peaking' }, // High-Mid
            4: { q: 64, freq: 105, gain: 64, type: 'peaking' } // High
          }
        },
        gate: {
          on: 0, // 0 = OFF, 1 = ON
          threshold: 32, // padrão de fábrica
          range: 64,
          attack: 16,
          hold: 0,
          decay: 64
        },
        comp: {
          on: 0, // 0 = OFF, 1 = ON
          threshold: 64, // padrão de fábrica
          ratio: 48,
          attack: 16,
          outgain: 64,
          release: 64,
          knee: 1 // 1 = SOFT, 0 = HARD
        }
      }
    },
    auxsend: {} // { canal: { auxIndex: { fader, mute } } }
  };

  // Inicializa canais de entrada (1 a 32) com suporte a EQ paramétrico de 4 bandas e Dinâmica (Gate e Compressor)
  for (let c = 1; c <= 32; c++) {
    state.input[c] = {
      fader: 0,
      mute: 0,
      name: `CH ${c}`,
      color: '#000000',
      eq: {
        on: 0, // 0 = OFF, 1 = ON
        bands: {
          1: { q: 64, freq: 20, gain: 64, type: 'peaking' }, // Low
          2: { q: 64, freq: 45, gain: 64, type: 'peaking' }, // Low-Mid
          3: { q: 64, freq: 80, gain: 64, type: 'peaking' }, // High-Mid
          4: { q: 64, freq: 105, gain: 64, type: 'peaking' } // High
        }
      },
      gate: {
        on: 0, // 0 = OFF, 1 = ON
        threshold: 32, // padrão de fábrica
        range: 64,
        attack: 16,
        hold: 0,
        decay: 64
      },
      comp: {
        on: 0, // 0 = OFF, 1 = ON
        threshold: 64, // padrão de fábrica
        ratio: 48,
        attack: 16,
        outgain: 64,
        release: 64,
        knee: 1 // 1 = SOFT, 0 = HARD
      },
      busRouting: {
        lr: true,
        1: true,
        2: true,
        3: true,
        4: true,
        5: true,
        6: true,
        7: true,
        8: true
      }
    };
  }

  // Inicializa auxiliares (1 a 8) com suporte a EQ, Gate e Compressor
  for (let c = 1; c <= 8; c++) {
    state.aux[c] = {
      fader: 0,
      mute: 0,
      name: `AUX ${c}`,
      color: '#000000',
      eq: {
        on: 0,
        bands: {
          1: { q: 64, freq: 20, gain: 64, type: 'peaking' },
          2: { q: 64, freq: 45, gain: 64, type: 'peaking' },
          3: { q: 64, freq: 80, gain: 64, type: 'peaking' },
          4: { q: 64, freq: 105, gain: 64, type: 'peaking' }
        }
      },
      gate: {
        on: 0,
        threshold: 32,
        range: 64,
        attack: 16,
        hold: 0,
        decay: 64
      },
      comp: {
        on: 0,
        threshold: 64,
        ratio: 48,
        attack: 16,
        outgain: 64,
        release: 64,
        knee: 1
      }
    };
  }

  // Inicializa buses (1 a 8)
  for (let c = 1; c <= 8; c++) {
    state.bus[c] = { fader: 0, mute: 0, name: `BUS ${c}`, color: '#000000', routeToStereo: true };
  }

  // Inicializa envios de auxiliar (auxsend) para todos os 32 canais e 8 auxiliares
  for (let c = 1; c <= 32; c++) {
    state.auxsend[c] = {};
    for (let a = 1; a <= 8; a++) {
      state.auxsend[c][a] = { fader: 0, mute: 1, routing: 'post' }; // Mute inicia ativo (1) para envios na mesa real
    }
  }

  state.fx = {
    1: createFXParams('reverb'),
    2: createFXParams('delay')
  };

  // Inicializa canais de retorno FX (FX Return 1, FX Return 2)
  state.fxreturn = {};
  for (let c = 1; c <= 2; c++) {
    state.fxreturn[c] = {
      fader: 0,
      mute: 0,
      name: `FX RTN ${c}`,
      color: '#000000',
      eq: {
        on: 0,
        bands: {
          1: { q: 64, freq: 20, gain: 64, type: 'peaking' },
          2: { q: 64, freq: 45, gain: 64, type: 'peaking' },
          3: { q: 64, freq: 80, gain: 64, type: 'peaking' },
          4: { q: 64, freq: 105, gain: 64, type: 'peaking' }
        }
      },
      busRouting: {
        lr: true,
        1: true, 2: true, 3: true, 4: true,
        5: true, 6: true, 7: true, 8: true
      }
    };
  }

  return state;
}

const mixerState = createFactoryMixerState();

// =============================================================
// GERENCIADOR DE CENAS
// =============================================================

let scenes = {};
// Inicializa o slot 0 especial "inicial data" e os 99 slots de cena vazios por padrão
scenes[0] = {
  slot: 0,
  name: 'inicial data',
  state: createFactoryMixerState(),
  empty: false,
  protected: true
};
for (let i = 1; i <= 99; i++) {
  scenes[i] = { slot: i, name: '', state: null, empty: true };
}

function loadScenesFromFile() {
  try {
    // Garante que o slot 0 sempre seja a cena padrão inicial data
    scenes[0] = {
      slot: 0,
      name: 'inicial data',
      state: createFactoryMixerState(),
      empty: false,
      protected: true
    };
    if (fs.existsSync(SCENES_FILE)) {
      const data = fs.readFileSync(SCENES_FILE, 'utf8');
      const loaded = JSON.parse(data);
      for (let i = 1; i <= 99; i++) {
        if (loaded[i]) {
          scenes[i] = loaded[i];
        }
      }
      console.log('[SCENES] Cenas locais carregadas com sucesso de scenes.json.');
    } else {
      saveScenesToFile();
    }
  } catch (err) {
    console.error('[SCENES] Erro ao ler arquivo de cenas:', err.message);
  }
}

function saveScenesToFile() {
  try {
    fs.writeFileSync(SCENES_FILE, JSON.stringify(scenes, null, 2), 'utf8');
  } catch (err) {
    console.error('[SCENES] Erro ao gravar arquivo de cenas:', err.message);
  }
}

// Inicializa carregando as cenas salvas
loadScenesFromFile();

/**
 * Transmite as mudanças de cena via MIDI com Throttling para não estourar o buffer físico da Yamaha 01v96
 */
function sendSceneMIDISync(slot, sceneState) {
  if (!midiOutput) return;

  try {
    // 1. Envia comando Program Change para carregar a cena correspondente na mesa (0 a 99)
    midiOutput.send('program', { channel: 0, number: slot });
    console.log(`[MIDI-SCENE] Program Change enviado: Programa ${slot} (Cena ${slot})`);

    // 2. Transmite sequencialmente os parâmetros (faders e mutes)
    const messagesToSend = [];

    // Faders e Mutes de canais Mono (1-32)
    for (let c = 1; c <= 32; c++) {
      const chState = sceneState.input[c];
      if (chState) {
        messagesToSend.push({ type: 'fader', target: 'input', channel: c, value: chState.fader });
        messagesToSend.push({ type: 'mute', target: 'input', channel: c, value: chState.mute });
        if (chState.eq) {
          messagesToSend.push({ type: 'eq', target: 'input', channel: c, value: chState.eq.on, param: 'on' });
        }
      }
    }

    // Faders e Mutes de AUX (1-8) e BUS (1-8)
    for (let c = 1; c <= 8; c++) {
      const auxState = sceneState.aux[c];
      if (auxState) {
        messagesToSend.push({ type: 'fader', target: 'aux', channel: c, value: auxState.fader });
        messagesToSend.push({ type: 'mute', target: 'aux', channel: c, value: auxState.mute });
      }
      const busState = sceneState.bus[c];
      if (busState) {
        messagesToSend.push({ type: 'fader', target: 'bus', channel: c, value: busState.fader });
        messagesToSend.push({ type: 'mute', target: 'bus', channel: c, value: busState.mute });
      }
    }

    // Fader e Mute do Master Stereo
    const masterState = sceneState.master[1];
    if (masterState) {
      messagesToSend.push({ type: 'fader', target: 'master', channel: 1, value: masterState.fader });
      messagesToSend.push({ type: 'mute', target: 'master', channel: 1, value: masterState.mute });
      if (masterState.eq) {
        messagesToSend.push({ type: 'eq', target: 'master', channel: 1, value: masterState.eq.on, param: 'on' });
      }
    }

    console.log(`[MIDI-SCENE] Sincronização fina de ${messagesToSend.length} comandos MIDI iniciada (Throttling 3ms)...`);

    let i = 0;
    const interval = setInterval(() => {
      if (i >= messagesToSend.length || !midiOutput) {
        clearInterval(interval);
        console.log('[MIDI-SCENE] Sincronização fina concluída.');
        return;
      }

      const msg = messagesToSend[i];
      try {
        const sysexBytes = midiProtocol.encodeSysExMessage(
          msg.type, 
          msg.target, 
          msg.channel, 
          msg.value, 
          undefined, 
          undefined, 
          msg.param
        );
        if (sysexBytes && sysexBytes.length > 0) {
          midiOutput.send('sysex', sysexBytes);
        }
      } catch (err) {
        // Silencia erro
      }
      i++;
    }, 3);

  } catch (err) {
    console.error('[MIDI-SCENE] Falha ao enviar sincronização de cena:', err.message);
  }
}

/**
 * Envia mensagens "Parameter Request" para a mesa física 01V96 puxar o estado de todos os faders/mutes
 */
function requestMixerStateFromDesk() {
  if (!midiOutput) return;

  console.log('[MIDI-SYNC] Iniciando solicitacao de estado atual da mesa fisica (Parameter Request)...');

  const requests = [];

  // 1. Solicita Faders e Mutes dos canais Mono (1-32)
  for (let c = 1; c <= 32; c++) {
    const addrMid = c - 1;
    // Fader: High 0x1A, Mid channel-1, Low 0x1C
    requests.push([0xF0, 0x43, 0x30, 0x3E, 0x0E, 0x1A, addrMid, 0x1C, 0xF7]);
    // Mute: High 0x1A, Mid channel-1, Low 0x1B
    requests.push([0xF0, 0x43, 0x30, 0x3E, 0x0E, 0x1A, addrMid, 0x1B, 0xF7]);
  }

  // 2. Solicita Faders e Mutes de AUX (1-8) e BUS (1-8)
  for (let c = 1; c <= 8; c++) {
    // Aux fader e mute
    requests.push([0xF0, 0x43, 0x30, 0x3E, 0x0E, 0x1C, c + 9, 0x1C, 0xF7]);
    requests.push([0xF0, 0x43, 0x30, 0x3E, 0x0E, 0x1C, c + 9, 0x1B, 0xF7]);
    // Bus fader e mute
    requests.push([0xF0, 0x43, 0x30, 0x3E, 0x0E, 0x1C, c + 1, 0x1C, 0xF7]);
    requests.push([0xF0, 0x43, 0x30, 0x3E, 0x0E, 0x1C, c + 1, 0x1B, 0xF7]);
  }

  // 3. Solicita Fader e Mute do Master Stereo (High 0x1C, Mid 0x00, Low 0x1C/0x1B)
  requests.push([0xF0, 0x43, 0x30, 0x3E, 0x0E, 0x1C, 0x00, 0x1C, 0xF7]);
  requests.push([0xF0, 0x43, 0x30, 0x3E, 0x0E, 0x1C, 0x00, 0x1B, 0xF7]);

  console.log(`[MIDI-SYNC] Enviando ${requests.length} solicitacoes de parametros para a mesa (Throttling 2ms)...`);

  let i = 0;
  const interval = setInterval(() => {
    if (i >= requests.length || !midiOutput) {
      clearInterval(interval);
      console.log('[MIDI-SYNC] Solicitacoes de sincronismo concluidas.');
      return;
    }

    try {
      midiOutput.send('sysex', requests[i]);
    } catch (err) {
      // Ignora erro
    }
    i++;
  }, 2);
}

/**
 * Procura e conecta-se às portas MIDI da Yamaha 01V96
 */
function listMIDIPorts() {
  try {
    const inputs = easymidi.getInputs();
    const outputs = easymidi.getOutputs();
    return { inputs, outputs };
  } catch (err) {
    console.error('[MIDI] Erro ao listar portas:', err.message);
    return { inputs: [], outputs: [] };
  }
}

function disconnectMIDI() {
  try {
    if (midiInput) {
      midiInput.close();
      midiInput = null;
    }
    if (midiOutput) {
      midiOutput.close();
      midiOutput = null;
    }
  } catch (err) {
    console.error('[MIDI] Erro ao desconectar:', err.message);
  }
  activeInputPort = null;
  activeOutputPort = null;
  midiStatus = 'Disconnected (Demo Mode)';
  console.log('[MIDI] Desconectado manualmente.');
  broadcast({ type: 'status', status: midiStatus });
}

function connectMIDI(inputPortName, outputPortName) {
  try {
    const inputs = easymidi.getInputs();
    const outputs = easymidi.getOutputs();

    console.log('\n--- Buscando Dispositivos MIDI ---');
    console.log('Portas de Entrada disponíveis:', inputs);
    console.log('Portas de Saída disponíveis:', outputs);

    // Encontrar portas que tenham "yamaha", "01v96" ou "usb-midi" no nome
    const yamahaInput = inputs.find(name => 
      name.toLowerCase().includes('yamaha') || 
      name.toLowerCase().includes('01v96') ||
      name.toLowerCase().includes('usb-midi')
    );
    
    const yamahaOutput = outputs.find(name => 
      name.toLowerCase().includes('yamaha') || 
      name.toLowerCase().includes('01v96') ||
      name.toLowerCase().includes('usb-midi')
    );

    // Fechar conexões anteriores se houver
    disconnectMIDI();

    let selectedInput = null;
    let selectedOutput = null;

    if (inputPortName && outputPortName) {
      // Usa portas especificadas
      if (inputs.includes(inputPortName)) selectedInput = inputPortName;
      if (outputs.includes(outputPortName)) selectedOutput = outputPortName;
      if (!selectedInput || !selectedOutput) {
        console.warn(`[MIDI] Portas especificadas não encontradas: in="${inputPortName}" out="${outputPortName}". Tentando auto-detecção...`);
      }
    }

    if (!selectedInput || !selectedOutput) {
      // Auto-detecção: procurar portas Yamaha
      selectedInput = inputs.find(name => 
        name.toLowerCase().includes('yamaha') || 
        name.toLowerCase().includes('01v96') ||
        name.toLowerCase().includes('usb-midi')
      );
      selectedOutput = outputs.find(name => 
        name.toLowerCase().includes('yamaha') || 
        name.toLowerCase().includes('01v96') ||
        name.toLowerCase().includes('usb-midi')
      );
    }

    if (selectedInput && selectedOutput) {
      console.log(`Conectando MIDI → Entrada: "${selectedInput}" | Saída: "${selectedOutput}"`);
      
      midiInput = new easymidi.Input(selectedInput);
      midiOutput = new easymidi.Output(selectedOutput);
      activeInputPort = selectedInput;
      activeOutputPort = selectedOutput;
      midiStatus = `Connected to ${selectedInput}`;
      
      setupMIDIListeners();

      // Solicita sincronismo de faders/mutes da mesa física após conectar
      setTimeout(() => {
        requestMixerStateFromDesk();
      }, 1000);
    } else {
      activeInputPort = null;
      activeOutputPort = null;
      midiStatus = 'Disconnected (Demo Mode)';
      console.warn('Nenhum dispositivo MIDI Yamaha detectado. Iniciando em Modo de Demonstração (Simulado).');
    }
  } catch (err) {
    console.error('Erro ao conectar com MIDI:', err.message);
    midiStatus = 'Error connecting to MIDI';
  }

  // Notifica todos os clientes sobre a mudança de status do MIDI
  broadcast({ type: 'status', status: midiStatus });
}

/**
 * Configura escutas para eventos MIDI recebidos da mesa
 */
function setupMIDIListeners() {
  if (!midiInput) return;

  // Lida com mensagens SysEx da Yamaha
  midiInput.on('sysex', (msg) => {
    // No easymidi, mensagens SysEx contêm a propriedade 'bytes'
    if (msg && msg.bytes) {
      const decoded = midiProtocol.decodeMIDIMessage(msg.bytes);
      if (decoded) {
        handleMixerUpdate(decoded, 'midi');
      }
    }
  });

  // Lida com mensagens Control Change (Fallback/Simples)
  midiInput.on('cc', (msg) => {
    // easymidi envia objeto cc formatado: { channel: 0..15, controller: 0..127, value: 0..127 }
    // O protocolo decodeMIDIMessage espera um array bruto de bytes.
    // Vamos reconstruir os bytes do CC para decodificar
    const statusByte = 0xB0 | (msg.channel & 0x0F);
    const bytes = [statusByte, msg.controller, msg.value];
    
    const decoded = midiProtocol.decodeMIDIMessage(bytes);
    if (decoded) {
      handleMixerUpdate(decoded, 'midi');
    }
  });

  console.log('Escutas MIDI ativadas com sucesso.');
}

/**
 * Processa a atualização de fader/mute e retransmite para quem for necessário
 * 
 * @param {Object} data Objeto de dados { type, target, channel, value, [auxIndex] }
 * @param {string} source Origem da atualização: 'midi' ou 'web'
 */
function handleMixerUpdate(data, source) {
  const { type, target, channel, value, auxIndex, band, param } = data;
  
  // Mensagens de navegação de tela não afetam o mixerState de áudio e não são transmitidas via MIDI
  if (type === 'navigate') {
    if (source === 'web') {
      broadcast(data, true);
    }
    return;
  }
  
  // Atualiza estado interno da aplicação
  if (target === 'auxsend') {
    if (mixerState.auxsend[channel] && mixerState.auxsend[channel][auxIndex]) {
      if (type === 'fader') {
        mixerState.auxsend[channel][auxIndex].fader = value;
      } else if (type === 'mute') {
        mixerState.auxsend[channel][auxIndex].mute = value;
      } else if (type === 'routing') {
        mixerState.auxsend[channel][auxIndex].routing = value;
      }
    }
  } else if (mixerState[target] && mixerState[target][channel]) {
    if (type === 'fader') {
      mixerState[target][channel].fader = value;
    } else if (type === 'mute') {
      mixerState[target][channel].mute = value;
    } else if (type === 'pan') {
      mixerState[target][channel].pan = value;
    } else if (type === 'eq' && (target === 'input' || target === 'master' || target === 'aux')) {
      const eqState = mixerState[target][channel].eq;
      if (param === 'on') {
        eqState.on = value;
      } else if (band && (param === 'q' || param === 'freq' || param === 'gain' || param === 'type')) {
        if (!eqState.bands[band]) {
          eqState.bands[band] = { q: 64, freq: 64, gain: 64, type: 'peaking' };
        }
        eqState.bands[band][param] = value;
      }
    } else if ((type === 'gate' || type === 'comp') && (target === 'input' || target === 'master' || target === 'aux')) {
      const dynState = mixerState[target][channel][type];
      if (param === 'on') {
        dynState.on = value;
      } else if (param) {
        dynState[param] = value;
      }
    }
  }

  const logAux = target === 'auxsend' ? ` Aux ${auxIndex}` : '';
  const logEQ = type === 'eq' ? ` Band ${band} Param ${param}` : '';
  const logDyn = (type === 'gate' || type === 'comp') ? ` Param ${param}` : '';
  console.log(`[${source.toUpperCase()}] ${target ? target.toUpperCase() : 'NAV'}${logAux}${logEQ}${logDyn} Canal ${channel || ''} | ${type.toUpperCase()} -> ${value !== undefined ? value : ''}`);

  // 1. Se veio do MIDI (mesa física), envia para TODOS os clientes da web
  if (source === 'midi') {
    broadcast(data);
  } 
  
  // 2. Se veio do navegador web, envia para a mesa física e para outros navegadores conectados
  else if (source === 'web') {
    // Transmite para outros navegadores abertos para sincronização multi-dispositivo
    broadcast(data, true);

    // Se houver conexão MIDI ativa, envia a mensagem física para a mesa
    if (midiOutput) {
      try {
        // Envia via SysEx de alta resolução
        const sysexBytes = midiProtocol.encodeSysExMessage(type, target, channel, value, auxIndex, band, param);
        if (sysexBytes && sysexBytes.length > 0) {
          midiOutput.send('sysex', sysexBytes);
        }

        // CC não é suportado na 01V96 para envios Aux ou EQ/Gate/Comp, mas para outros passa
        if (target !== 'auxsend' && type !== 'eq' && type !== 'gate' && type !== 'comp') {
          const ccBytes = midiProtocol.encodeCCMessage(type, target, channel, value);
          if (ccBytes && ccBytes.length > 0) {
            midiOutput.send('cc', {
              channel: ccBytes[0] & 0x0F,
              controller: ccBytes[1],
              value: ccBytes[2]
            });
          }
        }
      } catch (err) {
        console.error('Erro ao enviar mensagem MIDI:', err.message);
      }
    }
  }
}

/**
 * Envia dados para todos os clientes WebSocket conectados
 * 
 * @param {Object} data Objeto JSON para enviar
 * @param {boolean} excludeSelf Opcional. Se verdadeiro, pode filtrar conexões se necessário (aqui enviaremos a todos)
 */
function broadcast(data, excludeSelf = false) {
  const messageStr = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

// Configura conexões de WebSocket dos clientes
wss.on('connection', (ws) => {
  console.log('Novo cliente Web conectado via WebSocket.');

  // 1. Envia o status atual da conexão MIDI
  ws.send(JSON.stringify({ type: 'status', status: midiStatus }));

  // 2. Envia o estado completo atual do Mixer para o cliente recém-conectado (sincronização inicial)
  ws.send(JSON.stringify({ type: 'sync', state: mixerState }));

  // 3. Envia a lista atual de cenas salvas no servidor
  ws.send(JSON.stringify({ type: 'scenes_list', scenes }));

  // 4. Ouve comandos recebidos do cliente
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'fader' || data.type === 'mute' || data.type === 'eq' || data.type === 'gate' || data.type === 'comp' || data.type === 'pan' || data.type === 'navigate') {
        handleMixerUpdate(data, 'web');
      } else if (data.type === 'rename') {
        const { target, channel, name } = data;
        if (mixerState[target] && mixerState[target][channel]) {
          mixerState[target][channel].name = name;
          console.log(`[RENAME] Canal ${target}.${channel} renomeado para "${name}"`);
          broadcast(data, true); // Retransmite para os demais clientes
        }
      } else if (data.type === 'color') {
        const { target, channel, value } = data;
        if (mixerState[target] && mixerState[target][channel]) {
          mixerState[target][channel].color = value;
          console.log(`[COLOR] Canal ${target}.${channel} cor alterada para "${value}"`);
          broadcast(data, true); // Retransmite para os demais clientes
        }
      } else if (data.type === 'routing_bus') {
        const { target, channel, bus, value } = data;
        if (mixerState[target] && mixerState[target][channel]) {
          if (bus === 'stereo' && target === 'bus') {
            mixerState[target][channel].routeToStereo = value;
          } else if (mixerState[target][channel].busRouting) {
            mixerState[target][channel].busRouting[bus] = value;
          }
          console.log(`[ROUTING] Canal ${target}.${channel} bus ${bus} -> ${value}`);
          broadcast(data, true);
        }
      } else if (data.type === 'fx') {
        const { processor, param, value } = data;
        if (mixerState.fx && mixerState.fx[processor]) {
          mixerState.fx[processor][param] = value;
          console.log(`[FX] Processador ${processor} ${param} -> ${value}`);
          broadcast(data, true);
        }
      } else if (data.type === 'fx_type') {
        const { processor, value: newType } = data;
        if (mixerState.fx && mixerState.fx[processor]) {
          const oldMix = mixerState.fx[processor].mix;
          const oldOn = mixerState.fx[processor].on;
          mixerState.fx[processor] = { ...mixerState.fx[processor], ...createFXParams(newType) };
          mixerState.fx[processor].mix = oldMix;
          mixerState.fx[processor].on = oldOn;
          console.log(`[FX] Processador ${processor} tipo -> ${newType}`);
          broadcast(data, true);
        }
      } else if (data.type === 'list_midi') {
        const ports = listMIDIPorts();
        ws.send(JSON.stringify({ type: 'midi_ports', ports, connected: !!midiOutput, activeInputPort, activeOutputPort, midiStatus }));
      } else if (data.type === 'connect_midi') {
        const { inputPort, outputPort } = data;
        console.log(`Solicitação de conexão MIDI: in="${inputPort}" out="${outputPort}"`);
        connectMIDI(inputPort, outputPort);
      } else if (data.type === 'disconnect_midi') {
        console.log('Solicitação de desconexão MIDI recebida da Web.');
        disconnectMIDI();
      } else if (data.type === 'reconnect') {
        console.log('Solicitação de reconexão MIDI recebida da Web.');
        connectMIDI();
      } else if (data.type === 'save_scene') {
        const { slot, name } = data;
        if (slot === 0) {
          console.warn('[SCENE] Tentativa de salvar sobre a cena protegida 0');
          return;
        }
        if (slot >= 1 && slot <= 99) {
          scenes[slot] = {
            slot,
            name: name || `Cena ${slot}`,
            state: JSON.parse(JSON.stringify(mixerState)),
            empty: false,
            timestamp: new Date().toISOString()
          };
          saveScenesToFile();
          console.log(`[SCENE] Cena salva no slot ${slot}: ${scenes[slot].name}`);
          broadcast({ type: 'scenes_list', scenes });
        }
      } else if (data.type === 'load_scene') {
        const { slot } = data;
        if (slot >= 0 && slot <= 99 && !scenes[slot].empty) {
          const scene = scenes[slot];
          
          // Copia profunda para o mixerState atual
          const prevMasterColor = mixerState.master[1] ? mixerState.master[1].color : '';
          Object.assign(mixerState.master, scene.state.master);
          if (mixerState.master[1] && mixerState.master[1].color === undefined) {
            mixerState.master[1].color = prevMasterColor;
          }
          
          Object.keys(scene.state.input).forEach(c => {
            if (mixerState.input[c]) {
              const prevName = mixerState.input[c].name;
              const prevColor = mixerState.input[c].color;
              Object.assign(mixerState.input[c], scene.state.input[c]);
              if (scene.state.input[c].name === undefined) {
                mixerState.input[c].name = prevName;
              }
              if (scene.state.input[c].color === undefined) {
                mixerState.input[c].color = prevColor;
              }
            }
          });
          
          Object.keys(scene.state.aux).forEach(c => {
            if (mixerState.aux[c]) {
              const prevName = mixerState.aux[c].name;
              const prevColor = mixerState.aux[c].color;
              Object.assign(mixerState.aux[c], scene.state.aux[c]);
              if (scene.state.aux[c].name === undefined) {
                mixerState.aux[c].name = prevName;
              }
              if (scene.state.aux[c].color === undefined) {
                mixerState.aux[c].color = prevColor;
              }
            }
          });
          
          Object.keys(scene.state.bus).forEach(c => {
            if (mixerState.bus[c]) {
              const prevName = mixerState.bus[c].name;
              const prevColor = mixerState.bus[c].color;
              Object.assign(mixerState.bus[c], scene.state.bus[c]);
              if (scene.state.bus[c].name === undefined) {
                mixerState.bus[c].name = prevName;
              }
              if (scene.state.bus[c].color === undefined) {
                mixerState.bus[c].color = prevColor;
              }
            }
          });
          
          if (scene.state.auxsend) {
            Object.keys(scene.state.auxsend).forEach(c => {
              if (mixerState.auxsend[c]) {
                Object.keys(scene.state.auxsend[c]).forEach(a => {
                  if (mixerState.auxsend[c][a]) Object.assign(mixerState.auxsend[c][a], scene.state.auxsend[c][a]);
                });
              }
            });
          }
          
          // Sincroniza FX e FX Return
          if (scene.state.fx) {
            Object.keys(scene.state.fx).forEach(p => {
              if (mixerState.fx[p]) Object.assign(mixerState.fx[p], scene.state.fx[p]);
            });
          }
          if (scene.state.fxreturn) {
            Object.keys(scene.state.fxreturn).forEach(c => {
              if (mixerState.fxreturn[c]) {
                Object.assign(mixerState.fxreturn[c], scene.state.fxreturn[c]);
              }
            });
          }
          
          console.log(`[SCENE] Cena carregada do slot ${slot}: ${scene.name}`);
          
          // Envia sincronização para todos os clientes conectados
          broadcast({ type: 'sync', state: mixerState });
          broadcast({ type: 'active_scene', slot });
          
          // Envia comandos MIDI correspondentes para a mesa física com throttling
          sendSceneMIDISync(slot, scene.state);
        }
      } else if (data.type === 'delete_scene') {
        const { slot } = data;
        if (slot === 0) {
          console.warn('[SCENE] Tentativa de excluir a cena protegida 0');
          return;
        }
        if (slot >= 1 && slot <= 99) {
          scenes[slot] = { slot, name: '', state: null, empty: true };
          saveScenesToFile();
          console.log(`[SCENE] Cena excluída do slot ${slot}`);
          broadcast({ type: 'scenes_list', scenes });
        }
      }
    } catch (err) {
      console.error('Erro ao decodificar mensagem WebSocket:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('Cliente Web desconectado.');
  });
});

// Inicia conexão MIDI na inicialização
connectMIDI();

// Tenta reconectar o MIDI a cada 10 segundos caso esteja desconectado
setInterval(() => {
  if (!midiInput || !midiOutput) {
    console.log('MIDI desconectado. Tentando reconexão automática...');
    connectMIDI();
  }
}, 10000);

// Iniciar servidor HTTP
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  localIPs = [];
  for (const name in interfaces) {
    for (const net of interfaces[name]) {
      // Filtra endereços IPv4 não internos (não 127.0.0.1)
      const family = net.family;
      if ((family === 'IPv4' || family === 4) && !net.internal) {
        localIPs.push(net.address);
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(`   01VMIX - Servidor Ativo para Yamaha 01V96`);
  console.log(`   Acesso Local: http://localhost:${PORT}`);
  if (localIPs.length > 0) {
    localIPs.forEach(ip => {
      console.log(`   Acesso na Rede: http://${ip}:${PORT}`);
    });
  }
  console.log(`   Acesse esses endereços nos navegadores dos seus dispositivos`);
  console.log(`   (computador, tablet ou smartphone na mesma rede Wi-Fi).`);
  console.log(`======================================================\n`);
});
