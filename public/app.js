/**
 * Yamaha 01V96VCM Web Control - Frontend Engine
 * 
 * Gerencia a renderização de faders com escala de dB, troca de camadas (Layers),
 * modo Sends on Fader (AUX 1-8), tela LCD interativa e conexões WebSocket.
 */

const CONFIG = {
  reconnectInterval: 3000,
  latencyInterval: 2000
};

let ws = null;
let reconnectTimer = null;
let lastPingTime = 0;

// Estado global do Mixer no Frontend (sincronizado com o servidor)
const mixerState = {
  input: {},  // 1..32 { fader, mute, pan, name }
  aux: {},    // 1..8 { fader, mute, pan, name }
  bus: {},    // 1..8 { fader, mute, pan, name }
  master: {
    1: {
      fader: 0,
      mute: 0,
      pan: 64,
      name: 'STEREO',
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
        threshold: 32,
        range: 64,
        attack: 16,
        hold: 0,
        decay: 64
      },
      comp: {
        on: 0, // 0 = OFF, 1 = ON
        threshold: 64, // -20 dB
        ratio: 48, // 4:1
        knee: 1, // SOFT
        attack: 16, // 16 ms
        release: 64, // 250 ms
        outgain: 64 // 0.0 dB
      }
    }
  },
  auxsend: {} // { canal: { auxIndex: { fader, mute } } }
};

// Inicializa valores padrão com suporte a EQ paramétrico de 4 bandas, Gate e Compressor por canal
for (let c = 1; c <= 32; c++) {
  mixerState.input[c] = {
    fader: 0,
    mute: 0,
    pan: 64,
    name: `CH ${c}`,
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
      on: 0,         // 0 = OFF, 1 = ON
      threshold: 32, // -54 dB padrão
      range: 64,     // -40 dB de range
      attack: 16,    // 16 ms
      hold: 0,       // 0 ms
      decay: 64      // 120 ms
    },
    comp: {
      on: 0,         // 0 = OFF, 1 = ON
      threshold: 64, // -20 dB
      ratio: 48,     // 4:1
      knee: 1,       // SOFT
      attack: 16,    // 16 ms
      release: 64,   // 250 ms
      outgain: 64    // 0.0 dB
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
  mixerState.auxsend[c] = {};
  for (let a = 1; a <= 8; a++) {
    mixerState.auxsend[c][a] = { fader: 0, mute: 1 }; // Mute do envio inicia ativado (1)
  }
}
for (let c = 1; c <= 8; c++) {
  mixerState.aux[c] = {
    fader: 0,
    mute: 0,
    pan: 64,
    name: `AUX ${c}`,
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
  mixerState.bus[c] = { fader: 0, mute: 0, pan: 64, name: `BUS ${c}`, routeToStereo: true };
}

// Inicializa processadores de efeitos internos (FX1, FX2) — 01V96 tem 2 processadores stereo
function createDefaultFXParams(type) {
  const base = { on: 1, mix: 64 };
  switch (type) {
    case 'reverb':
      return { ...base, type, algorithm: 'hall', decay: 80, preDelay: 32, damping: 48, diffusion: 64 };
    case 'delay':
      return { ...base, type, time: 64, feedback: 48, hpf: 0, lpf: 127 };
    case 'chorus':
      return { ...base, type, rate: 48, depth: 64, delay: 32, feedback: 24 };
    case 'flanger':
      return { ...base, type, rate: 32, depth: 72, delay: 16, feedback: 40 };
    case 'phaser':
      return { ...base, type, rate: 40, depth: 56, feedback: 32, stages: 64 };
    case 'tremolo':
      return { ...base, type, rate: 48, depth: 64, shape: 0 };
    case 'rotary':
      return { ...base, type, speed: 0, drive: 32 };
    case 'distortion':
      return { ...base, type, drive: 48, tone: 64, master: 64 };
    default:
      return { ...base, type: 'reverb', algorithm: 'hall', decay: 80, preDelay: 32, damping: 48, diffusion: 64 };
  }
}

mixerState.fx = {
  1: createDefaultFXParams('reverb'),
  2: createDefaultFXParams('delay')
};

// Inicializa canais de retorno FX (FX Return 1, FX Return 2) — retornos estéreo dedicados
mixerState.fxreturn = {};
for (let c = 1; c <= 2; c++) {
  mixerState.fxreturn[c] = {
    fader: 0,
    mute: 0,
    pan: 64,
    name: `FX RTN ${c}`,
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

// Chave para salvar nomes customizados no LocalStorage
const localChannelNamesKey = '01v96_vcm_channel_names_v3';
const localChannelColorsKey = '01v96_vcm_channel_colors_v3';
const localGlobalThemeKey = '01v96_vcm_global_theme_color';
const localLayerColorsKey = '01v96_vcm_layer_colors_v3';

// Camada ativa: 'input1' (1-16), 'input2' (17-32), 'auxbus' (Buses 1-8 + Aux 1-8), 'scenes' (Biblioteca de cenas)
let activeLayer = 'input1';

// Armazenamento de cenas e cores no frontend
let scenesList = {};
let activeSceneSlot = null;
let channelColors = {};

// Modo de Fader Ativo: 'home' (Stereo Out) ou 'aux' (Sends on Fader)
let activeFaderMode = 'home';
let activeAuxSendIndex = 1; // 1 a 8

// Canal selecionado atualmente para exibição no display LCD
let selectedTarget = 'input';
let selectedChannel = 1;

// Mapeamento dos 16 slots visuais e do master
const stripControls = {};
let masterControls = null;

document.addEventListener('DOMContentLoaded', () => {
  renderChannels();
  loadChannelNames();
  loadChannelColors();
  loadGlobalTheme();
  loadLayerColors();
  updateSlotsMapping();
  initWebSocket();
  setupGlobalEvents();
  setupPhysicalButtonsEvents();
  initChannelControlDrawer();
  updateLCD();
  startVUMetersSimulation();
  setupCustomizationEvents();
  setupAuxNamesEvents();
  setupChannelEditorEvents();
  setupFXEvents();
  setupMIDISettingsEvents();
  updateAuxButtonLabels();
  updateAuxButtonColors();
});

/**
 * Cria a estrutura física dos 16 faders do console, incluindo escala de dB
 */
function renderChannels() {
  const container = document.getElementById('channels-container');
  container.innerHTML = '';

  for (let slot = 1; slot <= 16; slot++) {
    const strip = document.createElement('div');
    strip.className = 'channel-strip';
    strip.id = `strip-${slot}`;
    
    strip.innerHTML = `
      <div class="strip-header">
        <div class="channel-select-btn" id="channel-btn-${slot}" role="button" tabindex="0" title="Segure para renomear, clique para selecionar">
          <span class="channel-number" id="label-num-${slot}">00</span>
          <input type="text" class="channel-name" id="name-input-${slot}" value="" readonly maxlength="8">
        </div>
      </div>
      
      <!-- Pan Slider Horizontal (sempre visível) -->
      <div class="pan-strip-row">
        <span class="pan-strip-label">PAN</span>
        <div class="pan-strip-inner">
          <span class="pan-strip-val" id="pan-val-${slot}">C</span>
          <input type="range" class="pan-strip-slider" id="pan-slider-${slot}" min="0" max="127" value="64" title="Pan do Canal">
        </div>
      </div>
      
      <!-- Botões de Processamento de Canal (EQ, DYNAMIC) -->
      <div class="channel-processing-wrapper">
        <button class="channel-btn eq-btn" id="eq-btn-${slot}" title="Abrir Equalizador">
          <span class="channel-btn-led"></span>
          EQ
        </button>
        <button class="channel-btn dyn-btn" id="dyn-btn-${slot}" title="Abrir Dinâmicos (Gate/Compressor)">
          <span class="channel-btn-led"></span>
          DYNAMIC
        </button>
      </div>
      
      <!-- Botões de Roteamento PRE / POST Fader para modo AUX -->
      <div class="aux-pre-post-row" id="aux-pre-post-row-${slot}" style="display: none;">
        <button class="pre-post-btn pre-btn" id="pre-btn-${slot}" title="Configurar Envio como Pré-Fader">PRE</button>
        <button class="pre-post-btn post-btn" id="post-btn-${slot}" title="Configurar Envio como Pós-Fader">POST</button>
      </div>

      <!-- Botão ON/MUTE proeminente (acima do fader, igual ao console físico) -->
      <button class="on-btn strip-mute-btn" id="on-btn-${slot}" title="ON / MUTE do Canal">ON</button>
      
      <div class="fader-section">
        <!-- Tag de Roteamento LR -->
        <div class="lr-tag-row">
          <span class="lr-tag">LR</span>
          <span class="lr-signal-led"></span>
        </div>
        
        <!-- VU + Fader + Escala dB lado a lado -->
        <div class="fader-controls-row">
          <div class="vu-meter">
            <div class="vu-bar" id="vu-${slot}"></div>
          </div>
          
          <div class="slider-wrapper">
            <span class="db-lbl-top">dB</span>
            
            <div class="db-scale-integrated">
              <div class="db-tick major" style="bottom: 100%;"><span class="tick-line"></span><span class="tick-val">10</span></div>
              <div class="db-tick minor" style="bottom: 96.875%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 93.75%;"><span class="tick-line"></span><span class="tick-val">5</span></div>
              <div class="db-tick minor" style="bottom: 92.1875%;"><span class="tick-line"></span></div>
              <div class="db-tick minor" style="bottom: 90.625%;"><span class="tick-line"></span></div>
              <div class="db-tick minor" style="bottom: 89.0625%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 87.5%;"><span class="tick-line"></span><span class="tick-val">0</span></div>
              <div class="db-tick minor" style="bottom: 85.9375%;"><span class="tick-line"></span></div>
              <div class="db-tick minor" style="bottom: 84.375%;"><span class="tick-line"></span></div>
              <div class="db-tick minor" style="bottom: 82.8125%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 81.25%;"><span class="tick-line"></span><span class="tick-val">5</span></div>
              <div class="db-tick minor" style="bottom: 78.125%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 75%;"><span class="tick-line"></span><span class="tick-val">10</span></div>
              <div class="db-tick minor" style="bottom: 68.75%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 62.5%;"><span class="tick-line"></span><span class="tick-val">20</span></div>
              <div class="db-tick minor" style="bottom: 56.25%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 50%;"><span class="tick-line"></span><span class="tick-val">30</span></div>
              <div class="db-tick minor" style="bottom: 43.75%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 37.5%;"><span class="tick-line"></span><span class="tick-val">40</span></div>
              <div class="db-tick minor" style="bottom: 31.25%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 25%;"><span class="tick-line"></span><span class="tick-val">50</span></div>
              <div class="db-tick minor" style="bottom: 18.75%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 12.5%;"><span class="tick-line"></span><span class="tick-val">60</span></div>
              <div class="db-tick minor" style="bottom: 6.25%;"><span class="tick-line"></span></div>
              <div class="db-tick major" style="bottom: 0%;"><span class="tick-line"></span><span class="tick-val">oo</span></div>
            </div>
            
            <div class="fader-groove-line"></div>
            
            <input type="range" class="fader-slider" id="fader-input-${slot}" min="0" max="1023" value="0" orient="vertical">
          </div>
        </div>
      </div>
      
      <!-- Rodapé: Botão Editar + Seletor de Cor do Canal -->
      <div class="strip-footer">
        <input type="color" class="channel-color-picker-hidden" id="color-picker-${slot}">
        <div class="channel-color-row">
          <button class="channel-edit-btn" id="edit-btn-${slot}" title="Editar nome, cor e roteamento do canal">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <span class="channel-color-badge" id="color-badge-${slot}" title="Mudar cor do canal"></span>
        </div>
      </div>
    `;

    container.appendChild(strip);

    stripControls[slot] = {
      stripElement: strip,
      channelSelectBtn: strip.querySelector(`#channel-btn-${slot}`),
      numLabel: strip.querySelector(`#label-num-${slot}`),
      nameInput: strip.querySelector(`#name-input-${slot}`),
      fader: strip.querySelector(`#fader-input-${slot}`),
      onBtn: strip.querySelector(`#on-btn-${slot}`),
      soloBtn: strip.querySelector(`#solo-btn-${slot}`),
      vuBar: strip.querySelector(`#vu-${slot}`),
      panVal: strip.querySelector(`#pan-val-${slot}`),
      panSlider: strip.querySelector(`#pan-slider-${slot}`),
      eqBtn: strip.querySelector(`#eq-btn-${slot}`),
      dynBtn: strip.querySelector(`#dyn-btn-${slot}`),
      colorBadge: strip.querySelector(`#color-badge-${slot}`),
      colorPicker: strip.querySelector(`#color-picker-${slot}`),
      editBtn: strip.querySelector(`#edit-btn-${slot}`),
      preBtn: strip.querySelector(`#pre-btn-${slot}`),
      postBtn: strip.querySelector(`#post-btn-${slot}`),
      prePostRow: strip.querySelector(`#aux-pre-post-row-${slot}`),
      isSolo: false,
      
      target: 'input',
      channel: slot
    };

    setupSlotEvents(slot);
  }

  // Mapeia o Master físico (fixo à direita)
  const masterStrip = document.getElementById('channel-master-1');
  masterControls = {
    stripElement: masterStrip,
    channelSelectBtn: masterStrip.querySelector('#channel-btn-master'),
    numLabel: masterStrip.querySelector('#label-num-master'),
    nameInput: masterStrip.querySelector('#name-input-master'),
    fader: masterStrip.querySelector('#fader-master-1'),
    onBtn: masterStrip.querySelector('#on-master-1'),
    vuBarL: masterStrip.querySelector('#master-vu-l'),
    vuBarR: masterStrip.querySelector('#master-vu-r'),
    eqBtn: masterStrip.querySelector('#eq-btn-master'),
    dynBtn: masterStrip.querySelector('#dyn-btn-master'),

    colorBadge: masterStrip.querySelector('#color-badge-master'),
    colorPicker: masterStrip.querySelector('#color-picker-master'),
    isMuted: false,
    faderValue: 0
  };
  
  setupMasterEvents();
}

/**
 * Animação de glide (deslizamento suave) para faders imitando faders motorizados físicos
 */
function glideFader(faderEl, endVal, callback) {
  const startVal = parseInt(faderEl.value);
  if (startVal === endVal) {
    if (callback) callback();
    return;
  }

  const duration = 500; // ms
  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Easing quadrático out para desaceleração suave
    const easeProgress = progress * (2 - progress);
    
    const currentVal = Math.round(startVal + (endVal - startVal) * easeProgress);
    faderEl.value = currentVal;

    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      if (callback) callback();
    }
  }
  requestAnimationFrame(step);
}

/**
 * Remapeia os canais físicos da tela baseado na camada ativa (Layer)
 */
function updateSlotsMapping(animate = false) {
  const channelsViewport = document.querySelector('.channels-viewport');
  const scenesContainer = document.getElementById('scenes-container');
  const configContainer = document.getElementById('config-container');

  // Ocultar todas as viewports por padrão
  if (channelsViewport) channelsViewport.style.display = 'none';
  if (scenesContainer) scenesContainer.style.display = 'none';
  if (configContainer) configContainer.style.display = 'none';

  // Oculta o master section (fader stereo) nas telas de cenas e configuração
  const masterSection = document.querySelector('.master-section');
  if (masterSection) {
    if (activeLayer === 'scenes' || activeLayer === 'config') {
      masterSection.style.display = 'none';
    } else {
      masterSection.style.display = '';
    }
  }

  if (activeLayer === 'scenes') {
    if (scenesContainer) {
      scenesContainer.style.display = 'flex';
      renderScenesList();
    }
    return;
  } else if (activeLayer === 'config') {
    if (configContainer) {
      configContainer.style.display = 'flex';
      loadNetworkInfo();
      loadLayerColors();
      loadGlobalTheme();
      requestMIDIPorts();
    }
    return;
  } else {
    if (channelsViewport) channelsViewport.style.display = 'flex';
  }

  for (let slot = 1; slot <= 16; slot++) {
    const ctrl = stripControls[slot];
    if (!ctrl) continue;
    
    // Limpa classes visuais anteriores
    ctrl.stripElement.classList.remove('input-type', 'bus-type', 'aux-type');

    if (activeLayer === 'input1') {
      ctrl.target = 'input';
      ctrl.channel = slot;
      ctrl.stripElement.classList.add('input-type');
    } else if (activeLayer === 'input2') {
      ctrl.target = 'input';
      ctrl.channel = slot + 16;
      ctrl.stripElement.classList.add('input-type');
    } else if (activeLayer === 'auxbus') {
      if (slot <= 8) {
        ctrl.target = 'aux';
        ctrl.channel = slot;
        ctrl.stripElement.classList.add('aux-type');
      } else {
        ctrl.target = 'bus';
        ctrl.channel = slot - 8;
        ctrl.stripElement.classList.add('bus-type');
      }
    }

    // Carrega o estado do canal lógico na interface física
    syncSlotUI(slot, animate);
  }

  // Sincroniza também o fader Master que pode ter sido remapeado
  syncMasterUI(animate);
}

/**
 * Sincroniza fader/mute do slot físico baseado no modo (Normal ou Sends on Fader)
 */
function syncSlotUI(slot, animate = false) {
  const ctrl = stripControls[slot];
  if (!ctrl) return;
  const { target, channel } = ctrl;

  // 1. Se for entrada (input) e estivermos em modo AUX (Sends on Fader), controlamos a matriz de envios
  if (target === 'input' && activeFaderMode === 'aux') {
    const sendState = mixerState.auxsend[channel][activeAuxSendIndex];
    const inputState = mixerState.input[channel];
    
    if (!sendState) return;

    ctrl.numLabel.textContent = String(channel).padStart(2, '0');
    // Mostramos o nome do canal de entrada original para saber quem está enviando
    ctrl.nameInput.value = inputState.name; 
    
    if (animate) {
      glideFader(ctrl.fader, sendState.fader);
    } else {
      ctrl.fader.value = sendState.fader;
    }

    // No Sends on Fader, o botão ON controla o Send ON do canal
    if (sendState.mute === 0) {
      ctrl.onBtn.classList.add('active');
    } else {
      ctrl.onBtn.classList.remove('active');
    }

    // Desativa Pan visualmente no modo Send
    ctrl.panVal.textContent = 'SND';
    if (ctrl.panSlider) ctrl.panSlider.value = 64;
    // Atualiza exibição número/nome (modo send mostra nome customizado se existir)
    updateChannelLabel(slot, ctrl.numLabel.textContent, inputState.name);

    // Sincroniza visual do seletor PRE / POST fader
    if (ctrl.prePostRow) {
      ctrl.prePostRow.style.display = 'flex';
    }
    if (ctrl.preBtn && ctrl.postBtn) {
      const isPre = sendState.routing === 'pre';
      if (isPre) {
        ctrl.preBtn.classList.add('active');
        ctrl.postBtn.classList.remove('active');
      } else {
        ctrl.preBtn.classList.remove('active');
        ctrl.postBtn.classList.add('active');
      }
    }
  } 
  
  // 2. Modo Normal (HOME) ou canal de saída (Buses / Auxes)
  else {
    if (ctrl.prePostRow) {
      ctrl.prePostRow.style.display = 'none';
    }
    const state = mixerState[target][channel];
    if (!state) return;

    let numText = '';
    if (target === 'input') {
      numText = String(channel).padStart(2, '0');
    } else if (target === 'bus') {
      numText = `B${channel}`;
    } else if (target === 'aux') {
      numText = `A${channel}`;
    }
    ctrl.numLabel.textContent = numText;

    ctrl.nameInput.value = state.name;
    // Alterna exibição: se tem nome, esconde o número e mostra o nome; se não, mostra o número
    updateChannelLabel(slot, numText, state.name);
    
    if (animate) {
      glideFader(ctrl.fader, state.fader);
    } else {
      ctrl.fader.value = state.fader;
    }

    if (state.mute === 0) {
      ctrl.onBtn.classList.add('active');
    } else {
      ctrl.onBtn.classList.remove('active');
    }

    updatePanUI(slot, state.pan);
  }

  // Sincroniza status do Solo (puramente local)
  if (ctrl.soloBtn) {
    if (ctrl.isSolo) {
      ctrl.soloBtn.classList.add('active');
    } else {
      ctrl.soloBtn.classList.remove('active');
    }
  }

  // Sincroniza status do EQ/Dynamic (para canais de entrada e auxiliares)
  if (target === 'input' || target === 'aux') {
    ctrl.eqBtn.style.display = 'flex';
    ctrl.dynBtn.style.display = 'flex';
    
    const eqState = mixerState[target][channel].eq;
    if (eqState && eqState.on === 1) {
      ctrl.eqBtn.classList.add('active');
    } else {
      ctrl.eqBtn.classList.remove('active');
    }

    const gateState = mixerState[target][channel].gate;
    const compState = mixerState[target][channel].comp;
    const isDynActive = (gateState && gateState.on === 1) || (compState && compState.on === 1);
    if (isDynActive) {
      ctrl.dynBtn.classList.add('active');
    } else {
      ctrl.dynBtn.classList.remove('active');
    }
  } else {
    ctrl.eqBtn.style.display = 'none';
    ctrl.dynBtn.style.display = 'none';
  }

  // Sincroniza cor do canal. Começa como padrão na cor preta (#000000)
  const layerColor = (channelColors[target] && channelColors[target][channel]) || '#000000';
  applyChannelColor(slot, layerColor);
  
  if (ctrl.colorPicker) {
    ctrl.colorPicker.value = layerColor;
  }
}

/**
 * Sincroniza o fader Master físico
 * Em modo HOME -> Controla o Master Estéreo
 * Em modo AUX -> Controla o Volume de Saída Geral daquele Auxiliar
 */
function syncMasterUI(animate = false) {
  const master = masterControls;
  if (!master) return;

  if (activeFaderMode === 'home') {
    const state = mixerState.master[1];
    master.numLabel.textContent = 'MST';
    master.nameInput.value = state.name || 'STEREO';
    master.nameInput.setAttribute('readonly', 'true');
    // Master HOME: mostra nome se customizado, senão mostra MST
    const hasName = state.name && state.name.trim() && !/^STEREO$/i.test(state.name);
    master.numLabel.style.display = hasName ? 'none' : 'inline';
    master.nameInput.style.display = hasName ? 'inline' : 'none';
    
    if (animate) {
      glideFader(master.fader, state.fader);
    } else {
      master.fader.value = state.fader;
    }
    
    master.faderValue = state.fader;
    master.isMuted = state.mute === 1;

    if (state.mute === 0) {
      master.onBtn.classList.add('active');
    } else {
      master.onBtn.classList.remove('active');
    }

    // Exibe botões de processamento no Master e atualiza LEDs reativos
    master.eqBtn.style.display = 'flex';
    master.dynBtn.style.display = 'flex';

    if (state.eq && state.eq.on === 1) {
      master.eqBtn.classList.add('active');
    } else {
      master.eqBtn.classList.remove('active');
    }

    const isDynActive = (state.gate && state.gate.on === 1) || (state.comp && state.comp.on === 1);
    if (isDynActive) {
      master.dynBtn.classList.add('active');
    } else {
      master.dynBtn.classList.remove('active');
    }
  } else if (activeFaderMode === 'aux') {
    const state = mixerState.aux[activeAuxSendIndex];
    master.numLabel.textContent = `A${activeAuxSendIndex}`;
    master.nameInput.value = state.name;
    master.nameInput.setAttribute('readonly', 'true');
    // No modo AUX: mostra nome se houver nome customizado, senão mostra número
    const hasAuxName = state.name && state.name.trim() && !/^AUX \d+$/i.test(state.name);
    master.numLabel.style.display = hasAuxName ? 'none' : 'inline';
    master.nameInput.style.display = hasAuxName ? 'inline' : 'none';
    
    if (animate) {
      glideFader(master.fader, state.fader);
    } else {
      master.fader.value = state.fader;
    }
    
    master.faderValue = state.fader;
    master.isMuted = state.mute === 1;

    if (state.mute === 0) {
      master.onBtn.classList.add('active');
    } else {
      master.onBtn.classList.remove('active');
    }

    // Auxiliares possuem botões de processamento ativos se estiver no modo AUX
    master.eqBtn.style.display = 'flex';
    master.dynBtn.style.display = 'flex';

    if (state.eq && state.eq.on === 1) {
      master.eqBtn.classList.add('active');
    } else {
      master.eqBtn.classList.remove('active');
    }

    const isDynActive = (state.gate && state.gate.on === 1) || (state.comp && state.comp.on === 1);
    if (isDynActive) {
      master.dynBtn.classList.add('active');
    } else {
      master.dynBtn.classList.remove('active');
    }
  }

  // Sincroniza cor do Master. Começa como padrão na cor preta (#000000)
  let masterColor = '#000000';
  if (activeFaderMode === 'home') {
    masterColor = (channelColors.master && channelColors.master[1]) || '#000000';
  } else if (activeFaderMode === 'aux') {
    masterColor = (channelColors.aux && channelColors.aux[activeAuxSendIndex]) || '#000000';
  }
  applyMasterColor(masterColor);
  if (master.colorPicker) {
    master.colorPicker.value = masterColor;
  }
}

/**
 * Atualiza rótulo do canal: se o canal tem nome customizado, esconde número e mostra nome.
 * Se não tem nome, mostra o número.
 */
function updateChannelLabel(slot, numText, nameText) {
  const ctrl = stripControls[slot];
  if (!ctrl) return;
  const hasName = nameText && nameText.trim().length > 0;
  ctrl.numLabel.style.display = hasName ? 'none' : 'inline';
  ctrl.nameInput.style.display = hasName ? 'inline' : 'none';
}

/**
 * Aplica renomeação de canal em TODOS os locais da interface:
 * - Botão do canal nos faders (número ↔ nome)
 * - Cabeçalho da gaveta (drawer-channel-name)
 * - LCD
 * - Input do painel AUX (se for canal AUX)
 */
function applyChannelRename(target, channel, name) {
  // 1. Atualiza estado central
  if (mixerState[target] && mixerState[target][channel]) {
    mixerState[target][channel].name = name;
  }

  // 2. Atualiza todos os slots visíveis que mostram esse canal
  for (let slot = 1; slot <= 16; slot++) {
    const ctrl = stripControls[slot];
    if (!ctrl) continue;
    if (ctrl.target === target && ctrl.channel === channel) {
      ctrl.nameInput.value = name;
      const numText = ctrl.numLabel.textContent;
      updateChannelLabel(slot, numText, name);
    }
  }

  // 3. Atualiza o Master se for o canal exibido no master
  if (masterControls) {
    if (target === 'master' && channel === 1 && activeFaderMode === 'home') {
      masterControls.nameInput.value = name;
      const hasName = name && name.trim() && !/^STEREO$/i.test(name);
      masterControls.numLabel.style.display = hasName ? 'none' : 'inline';
      masterControls.nameInput.style.display = hasName ? 'inline' : 'none';
    } else if (target === 'aux' && channel === activeAuxSendIndex && activeFaderMode === 'aux') {
      masterControls.nameInput.value = name;
      const hasAuxName = name && name.trim() && !/^AUX \d+$/i.test(name);
      masterControls.numLabel.style.display = hasAuxName ? 'none' : 'inline';
      masterControls.nameInput.style.display = hasAuxName ? 'inline' : 'none';
    }
  }

  // 4. Atualiza nome na gaveta se o canal selecionado for este
  if (target === selectedTarget && channel === selectedChannel) {
    const drawerName = document.getElementById('drawer-channel-name');
    if (drawerName) drawerName.textContent = name;
    updateLCD();
  }

  // 5. Atualiza input de nome no painel de configurações AUX
  if (target === 'aux') {
    const inputEl = document.getElementById(`aux-name-${channel}`);
    if (inputEl) inputEl.value = name;
  }

  // 6. Atualiza label nos botões AUX da página home
  updateAuxButtonLabels();
}

/**
 * Atualiza o Slider Horizontal de Pan
 */
function updatePanUI(slot, value) {
  const ctrl = stripControls[slot];
  if (!ctrl) return;

  const panLabel = (value === 64) ? 'C' :
    (value < 64) ? `L${Math.round(((64 - value) / 64) * 100)}` :
                   `R${Math.round(((value - 64) / 63) * 100)}`;

  if (ctrl.panVal) ctrl.panVal.textContent = panLabel;
  if (ctrl.panSlider) ctrl.panSlider.value = value;
}

/**
 * Altera a seleção de canal de forma centralizada e sincroniza via rede.
 */
function selectChannel(target, channel, fromNetwork = false) {
  if (selectedTarget === target && selectedChannel === channel) return;
  selectedTarget = target;
  selectedChannel = channel;
  updateLCD();

  // Redesenha a gaveta caso o canal selecionado seja alterado
  const drawer = document.getElementById('channel-control-drawer');
  if (drawer && drawer.style.display !== 'none') {
    updateChannelControlDrawerUI();
  }

  if (!fromNetwork) {
    sendWSMessage({
      type: 'navigate',
      action: 'select',
      target,
      channel
    });
  }
}

/**
 * Configura escuta de eventos para os slots físicos
 */
function setupSlotEvents(slot) {
  const ctrl = stripControls[slot];

  // Foco do canal selecionado ao interagir
  const setSelection = () => {
    selectChannel(ctrl.target, ctrl.channel);
  };

  // 1. Fader
  ctrl.fader.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    const { target, channel } = ctrl;
    setSelection();

    // Se estiver em modo Sends on Fader e for Input, alteramos o envio Aux
    if (target === 'input' && activeFaderMode === 'aux') {
      mixerState.auxsend[channel][activeAuxSendIndex].fader = val;
      
      sendWSMessage({
        type: 'fader',
        target: 'auxsend',
        channel,
        auxIndex: activeAuxSendIndex,
        value: val
      });
    } 
    
    // Caso contrário (Normal ou Buses/Auxes), volume principal
    else {
      mixerState[target][channel].fader = val;
      
      sendWSMessage({
        type: 'fader',
        target,
        channel,
        value: val
      });
    }

    // Exibe nível instantâneo em dB no visor LCD
    showValueOnLCD(val);
  });

  // 2. Botão ON (Mute/Ativo)
  ctrl.onBtn.addEventListener('click', () => {
    const { target, channel } = ctrl;
    setSelection();

    if (target === 'input' && activeFaderMode === 'aux') {
      const currentMute = mixerState.auxsend[channel][activeAuxSendIndex].mute;
      const newMute = currentMute === 0 ? 1 : 0;
      mixerState.auxsend[channel][activeAuxSendIndex].mute = newMute;

      if (newMute === 0) {
        ctrl.onBtn.classList.add('active');
      } else {
        ctrl.onBtn.classList.remove('active');
      }

      sendWSMessage({
        type: 'mute',
        target: 'auxsend',
        channel,
        auxIndex: activeAuxSendIndex,
        value: newMute
      });
    } else {
      const currentMute = mixerState[target][channel].mute;
      const newMute = currentMute === 0 ? 1 : 0;
      mixerState[target][channel].mute = newMute;

      if (newMute === 0) {
        ctrl.onBtn.classList.add('active');
      } else {
        ctrl.onBtn.classList.remove('active');
      }

      sendWSMessage({
        type: 'mute',
        target,
        channel,
        value: newMute
      });
    }
  });

  // 3. Botão Solo
  if (ctrl.soloBtn) {
    ctrl.soloBtn.addEventListener('click', () => {
      ctrl.isSolo = !ctrl.isSolo;
      if (ctrl.isSolo) {
        ctrl.soloBtn.classList.add('active');
      } else {
        ctrl.soloBtn.classList.remove('active');
      }
    });
  }

  // 4. Botão Unificado do Canal com Suporte a Clique Longo para Editar e Clique Simples para Selecionar
  let pressTimer = null;
  let isLongPress = false;
  let longPressStartX = 0;
  let longPressStartY = 0;

  const startPress = (e) => {

    if (!ctrl.nameInput.hasAttribute('readonly')) return;
    if (e.type === 'mousedown' && e.button !== 0) return;
    
    isLongPress = false;
    longPressStartX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    longPressStartY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
    
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      isLongPress = true;
      enableNameEditing();
    }, 550);
  };

  const endPress = (e) => {
    clearTimeout(pressTimer);
    if (!isLongPress) {
      setSelection();
    }
    isLongPress = false;
  };

  const cancelPress = (e) => {
    clearTimeout(pressTimer);
    isLongPress = false;
  };

  const movePress = (e) => {
    const currentX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    const currentY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
    if (Math.abs(currentX - longPressStartX) > 10 || Math.abs(currentY - longPressStartY) > 10) {
      clearTimeout(pressTimer);
    }
  };

  const enableNameEditing = () => {
    setSelection();
    ctrl.nameInput.removeAttribute('readonly');
    // Mostra o input de nome e oculta o número para edição
    ctrl.numLabel.style.display = 'none';
    ctrl.nameInput.style.display = 'inline';
    ctrl.nameInput.style.pointerEvents = 'auto';
    ctrl.nameInput.focus();
    setTimeout(() => {
      ctrl.nameInput.select();
    }, 10);
  };

  // Eventos de clique longo e clique simples no botão unificado do canal
  ctrl.channelSelectBtn.addEventListener('mousedown', startPress);
  ctrl.channelSelectBtn.addEventListener('mouseup', endPress);
  ctrl.channelSelectBtn.addEventListener('mouseleave', cancelPress);
  ctrl.channelSelectBtn.addEventListener('mousemove', movePress);

  ctrl.channelSelectBtn.addEventListener('touchstart', startPress, { passive: true });
  ctrl.channelSelectBtn.addEventListener('touchend', endPress);
  ctrl.channelSelectBtn.addEventListener('touchcancel', cancelPress);
  ctrl.channelSelectBtn.addEventListener('touchmove', movePress, { passive: true });

  // Salvar alterações ao perder o foco (blur)
  ctrl.nameInput.addEventListener('blur', () => {
    ctrl.nameInput.setAttribute('readonly', 'true');
    const { target, channel } = ctrl;
    const oldName = mixerState[target][channel].name;
    // Se o usuário apagou tudo, volta ao padrão (número)
    const defaultName = (target === 'input' ? `CH ${channel}` : `${target.toUpperCase()} ${channel}`);
    const rawVal = ctrl.nameInput.value.trim();
    const isDefaultPattern = /^(CH \d+|BUS \d+|AUX \d+)$/i.test(rawVal);
    // Se digitou o padrão ou está vazio, remove o nome (mostra número)
    const newName = (rawVal === '' || isDefaultPattern) ? '' : rawVal;
    ctrl.nameInput.value = newName;

    // Atualiza rótulo (número x nome)
    const numText = ctrl.numLabel.textContent;
    updateChannelLabel(slot, numText, newName);

    if (oldName !== (newName || defaultName)) {
      mixerState[target][channel].name = newName || defaultName;
      saveChannelNames();
      updateLCD();
      sendWSMessage({
        type: 'rename',
        target,
        channel,
        name: newName || defaultName
      });
    }
  });

  // Salvar ao apertar Enter ou reverter ao apertar Escape
  ctrl.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      ctrl.nameInput.blur();
    } else if (e.key === 'Escape') {
      const { target, channel } = ctrl;
      ctrl.nameInput.value = mixerState[target][channel].name;
      ctrl.nameInput.blur();
    }
  });

  // 5. Slider Horizontal de Pan (sempre visível)
  if (ctrl.panSlider) {
    ctrl.panSlider.addEventListener('input', (e) => {
      if (ctrl.target === 'input' && activeFaderMode === 'aux') return; // Bloqueado no modo Send
      const newPan = parseInt(e.target.value);
      const { target, channel } = ctrl;
      mixerState[target][channel].pan = newPan;
      updatePanUI(slot, newPan);
      setSelection();
      sendWSMessage({
        type: 'pan',
        target,
        channel,
        value: newPan
      });
    });
    // Duplo clique no slider: reseta para centro
    ctrl.panSlider.addEventListener('dblclick', () => {
      if (ctrl.target === 'input' && activeFaderMode === 'aux') return;
      const { target, channel } = ctrl;
      mixerState[target][channel].pan = 64;
      updatePanUI(slot, 64);
      sendWSMessage({ type: 'pan', target, channel, value: 64 });
    });
  }

  // 6. Botões de Processamento para abrir a Gaveta de Canal na aba correta
  ctrl.eqBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectChannel(ctrl.target, ctrl.channel);
    toggleChannelControlDrawer(ctrl.target, ctrl.channel, 'eq');
  });

  ctrl.dynBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectChannel(ctrl.target, ctrl.channel);
    toggleChannelControlDrawer(ctrl.target, ctrl.channel, 'gate');
  });

  // Eventos de personalização de cor do canal individual
  if (ctrl.colorBadge && ctrl.colorPicker) {
    ctrl.colorBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      selectChannel(ctrl.target, ctrl.channel);
      ctrl.colorPicker.click();
    });

    const handleColorChange = (e) => {
      const newColor = e.target.value;
      const { target, channel } = ctrl;
      
      if (!channelColors[target]) {
        channelColors[target] = {};
      }
      if (channelColors[target][channel] === newColor) return;
      channelColors[target][channel] = newColor;
      
      if (mixerState[target] && mixerState[target][channel]) {
        mixerState[target][channel].color = newColor;
      }
      
      applyChannelColor(slot, newColor);
      localStorage.setItem(localChannelColorsKey, JSON.stringify(channelColors));
      if (target === 'aux') updateAuxButtonColors();
      
      sendWSMessage({
        type: 'color',
        target,
        channel,
        value: newColor
      });
    };

    ctrl.colorPicker.addEventListener('input', handleColorChange);
    ctrl.colorPicker.addEventListener('change', handleColorChange);
  }

  // 7. Botão Editar Canal (abre modal de edição)
  if (ctrl.editBtn) {
    ctrl.editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectChannel(ctrl.target, ctrl.channel);
      openChannelEditor(ctrl.target, ctrl.channel);
    });
  }

  // Eventos de Roteamento PRE / POST Fader
  if (ctrl.preBtn && ctrl.postBtn) {
    ctrl.preBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setSelection();
      const { channel } = ctrl;
      if (activeFaderMode === 'aux') {
        if (mixerState.auxsend[channel] && mixerState.auxsend[channel][activeAuxSendIndex]) {
          mixerState.auxsend[channel][activeAuxSendIndex].routing = 'pre';
          syncSlotUI(slot);
          sendWSMessage({
            type: 'routing',
            target: 'auxsend',
            channel,
            auxIndex: activeAuxSendIndex,
            value: 'pre'
          });
        }
      }
    });

    ctrl.postBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setSelection();
      const { channel } = ctrl;
      if (activeFaderMode === 'aux') {
        if (mixerState.auxsend[channel] && mixerState.auxsend[channel][activeAuxSendIndex]) {
          mixerState.auxsend[channel][activeAuxSendIndex].routing = 'post';
          syncSlotUI(slot);
          sendWSMessage({
            type: 'routing',
            target: 'auxsend',
            channel,
            auxIndex: activeAuxSendIndex,
            value: 'post'
          });
        }
      }
    });
  }
}

/**
 * Configura escuta de eventos do Master Físico
 */
function setupMasterEvents() {
  const master = masterControls;

  master.fader.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    master.faderValue = val;

    if (activeFaderMode === 'home') {
      mixerState.master[1].fader = val;
      sendWSMessage({
        type: 'fader',
        target: 'master',
        channel: 1,
        value: val
      });
    } else if (activeFaderMode === 'aux') {
      mixerState.aux[activeAuxSendIndex].fader = val;
      sendWSMessage({
        type: 'fader',
        target: 'aux',
        channel: activeAuxSendIndex,
        value: val
      });
    }

    showValueOnLCD(val);
  });

  master.onBtn.addEventListener('click', () => {
    if (activeFaderMode === 'home') {
      const currentMute = mixerState.master[1].mute;
      const newMute = currentMute === 0 ? 1 : 0;
      mixerState.master[1].mute = newMute;
      master.isMuted = newMute === 1;

      if (newMute === 0) {
        master.onBtn.classList.add('active');
      } else {
        master.onBtn.classList.remove('active');
      }

      sendWSMessage({
        type: 'mute',
        target: 'master',
        channel: 1,
        value: newMute
      });
    } else if (activeFaderMode === 'aux') {
      const currentMute = mixerState.aux[activeAuxSendIndex].mute;
      const newMute = currentMute === 0 ? 1 : 0;
      mixerState.aux[activeAuxSendIndex].mute = newMute;
      master.isMuted = newMute === 1;

      if (newMute === 0) {
        master.onBtn.classList.add('active');
      } else {
        master.onBtn.classList.remove('active');
      }

      sendWSMessage({
        type: 'mute',
        target: 'aux',
        channel: activeAuxSendIndex,
        value: newMute
      });
    }
  });

  // 3. Botões de Processamento do Master (EQ / DYNAMIC)
  master.eqBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeFaderMode === 'home') {
      selectChannel('master', 1);
      toggleChannelControlDrawer('master', 1, 'eq');
    } else if (activeFaderMode === 'aux') {
      selectChannel('aux', activeAuxSendIndex);
      toggleChannelControlDrawer('aux', activeAuxSendIndex, 'eq');
    }
  });

  master.dynBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeFaderMode === 'home') {
      selectChannel('master', 1);
      toggleChannelControlDrawer('master', 1, 'gate');
    } else if (activeFaderMode === 'aux') {
      selectChannel('aux', activeAuxSendIndex);
      toggleChannelControlDrawer('aux', activeAuxSendIndex, 'gate');
    }
  });

  // Eventos de personalização de cor do Master
  if (master.colorBadge && master.colorPicker) {
    master.colorBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeFaderMode === 'home') {
        selectChannel('master', 1);
      } else {
        selectChannel('aux', activeAuxSendIndex);
      }
      master.colorPicker.click();
    });

    const handleMasterColorChange = (e) => {
      const newColor = e.target.value;
      let target = 'master';
      let channel = 1;
      
      if (activeFaderMode === 'aux') {
        target = 'aux';
        channel = activeAuxSendIndex;
      }
      
      if (!channelColors[target]) {
        channelColors[target] = {};
      }
      if (channelColors[target][channel] === newColor) return;
      channelColors[target][channel] = newColor;
      
      if (mixerState[target] && mixerState[target][channel]) {
        mixerState[target][channel].color = newColor;
      }
      
      applyMasterColor(newColor);
      
      if (target === 'aux' && activeLayer === 'auxbus') {
        updateSlotsMapping();
      }
      
      localStorage.setItem(localChannelColorsKey, JSON.stringify(channelColors));
      if (target === 'aux') updateAuxButtonColors();
      
      sendWSMessage({
        type: 'color',
        target,
        channel,
        value: newColor
      });
    };

    master.colorPicker.addEventListener('input', handleMasterColorChange);
    master.colorPicker.addEventListener('change', handleMasterColorChange);
  }

  // 4. Edição de Nome do Master com Clique Longo (HOME e AUX) e Clique Simples para Seleção
  let masterPressTimer = null;
  let isMasterLongPress = false;
  let masterStartX = 0;
  let masterStartY = 0;

  const startMasterPress = (e) => {
    if (e.target.classList.contains('channel-color-badge') || e.target.closest('.channel-color-badge')) {
      return;
    }

    if (!master.nameInput.hasAttribute('readonly')) return;
    if (e.type === 'mousedown' && e.button !== 0) return;
    
    isMasterLongPress = false;
    masterStartX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    masterStartY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
    
    clearTimeout(masterPressTimer);
    masterPressTimer = setTimeout(() => {
      isMasterLongPress = true;
      enableMasterNameEditing();
    }, 550);
  };

  const endMasterPress = (e) => {
    if (e.target.classList.contains('channel-color-badge') || e.target.closest('.channel-color-badge')) {
      return;
    }

    clearTimeout(masterPressTimer);
    if (!isMasterLongPress) {
      if (activeFaderMode === 'home') {
        selectChannel('master', 1);
      } else if (activeFaderMode === 'aux') {
        selectChannel('aux', activeAuxSendIndex);
      }
    }
    isMasterLongPress = false;
  };

  const cancelMasterPress = (e) => {
    clearTimeout(masterPressTimer);
    isMasterLongPress = false;
  };

  const moveMasterPress = (e) => {
    const currentX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    const currentY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
    if (Math.abs(currentX - masterStartX) > 10 || Math.abs(currentY - masterStartY) > 10) {
      clearTimeout(masterPressTimer);
    }
  };

  const enableMasterNameEditing = () => {
    if (activeFaderMode === 'home') {
      selectChannel('master', 1);
    } else {
      selectChannel('aux', activeAuxSendIndex);
    }
    master.nameInput.removeAttribute('readonly');
    // Mostra o input de nome e oculta o número para edição
    master.numLabel.style.display = 'none';
    master.nameInput.style.display = 'inline';
    master.nameInput.style.pointerEvents = 'auto';
    master.nameInput.focus();
    setTimeout(() => {
      master.nameInput.select();
    }, 10);
  };

  // Eventos de clique longo e clique simples no botão unificado do fader Master
  master.channelSelectBtn.addEventListener('mousedown', startMasterPress);
  master.channelSelectBtn.addEventListener('mouseup', endMasterPress);
  master.channelSelectBtn.addEventListener('mouseleave', cancelMasterPress);
  master.channelSelectBtn.addEventListener('mousemove', moveMasterPress);

  master.channelSelectBtn.addEventListener('touchstart', startMasterPress, { passive: true });
  master.channelSelectBtn.addEventListener('touchend', endMasterPress);
  master.channelSelectBtn.addEventListener('touchcancel', cancelMasterPress);
  master.channelSelectBtn.addEventListener('touchmove', moveMasterPress, { passive: true });

  // Salvar alterações ao perder o foco (blur)
  master.nameInput.addEventListener('blur', () => {
    master.nameInput.setAttribute('readonly', 'true');
    master.nameInput.style.pointerEvents = 'none';
    
    const rawVal = master.nameInput.value.trim();
    const isDefaultPattern = /^STEREO$/i.test(rawVal);
    const newName = (rawVal === '' || isDefaultPattern) ? '' : rawVal;
    master.nameInput.value = newName;
    
    const hasName = newName && newName.trim();
    master.numLabel.style.display = hasName ? 'none' : 'inline';
    master.nameInput.style.display = hasName ? 'inline' : 'none';
    
    if (activeFaderMode === 'home') {
      const oldName = mixerState.master[1].name;
      const finalName = newName || 'STEREO';
      if (oldName !== finalName) {
        mixerState.master[1].name = finalName;
        saveChannelNames();
        updateLCD();
        sendWSMessage({
          type: 'rename',
          target: 'master',
          channel: 1,
          name: finalName
        });
      }
    } else if (activeFaderMode === 'aux') {
      const oldName = mixerState.aux[activeAuxSendIndex].name;
      const finalName = newName || `AUX ${activeAuxSendIndex}`;
      if (oldName !== finalName) {
        mixerState.aux[activeAuxSendIndex].name = finalName;
        saveChannelNames();
        updateLCD();
        
        if (activeLayer === 'auxbus') {
          updateSlotsMapping();
        }
        
        const inputEl = document.getElementById(`aux-name-${activeAuxSendIndex}`);
        if (inputEl) inputEl.value = finalName;

        sendWSMessage({
          type: 'rename',
          target: 'aux',
          channel: activeAuxSendIndex,
          name: finalName
        });
      }
    }
  });

  // Salvar ao apertar Enter ou reverter ao apertar Escape
  master.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      master.nameInput.blur();
    } else if (e.key === 'Escape') {
      if (activeFaderMode === 'home') {
        master.nameInput.value = mixerState.master[1].name;
      } else if (activeFaderMode === 'aux') {
        master.nameInput.value = mixerState.aux[activeAuxSendIndex].name;
      }
      master.nameInput.blur();
    }
  });
}

/**
 * Configura alternância das abas de camadas do topo
 */
function setupGlobalEvents() {
  const tabs = document.querySelectorAll('.layer-tab');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      tabs.forEach(t => t.classList.remove('active'));
      const clicked = e.currentTarget;
      clicked.classList.add('active');

      activeLayer = clicked.getAttribute('data-layer');
      updateSlotsMapping();

      sendWSMessage({
        type: 'navigate',
        action: 'layer',
        value: activeLayer
      });
    });
  });

  document.getElementById('btn-reconnect').addEventListener('click', (e) => {
    const icon = e.currentTarget.querySelector('i');
    icon.classList.add('fa-spin');
    sendWSMessage({ type: 'reconnect' });
    setTimeout(() => icon.classList.remove('fa-spin'), 1000);
  });
}

/**
 * Configura botões físicos laterais 3D (HOME / AUX 1-8)
 * Implementando o comportamento de Sends on Fader idêntico à mesa física
 */
function setupPhysicalButtonsEvents() {
  const btnHome = document.getElementById('btn-mode-home');
  const ledHome = document.getElementById('led-home');
  const auxBtns = document.querySelectorAll('.btn-aux');

  // Clique no botão HOME
  btnHome.addEventListener('click', () => {
    if (activeFaderMode === 'home') return;

    activeFaderMode = 'home';
    
    // Ajusta LEDs físicos
    btnHome.classList.add('active');
    ledHome.classList.add('active');
    
    auxBtns.forEach(btn => {
      btn.classList.remove('active');
      btn.querySelector('.btn-led').classList.remove('active');
    });

    // Remapeia faders
    updateSlotsMapping();
    updateLCD();

    sendWSMessage({
      type: 'navigate',
      action: 'fadermode',
      mode: 'home'
    });
  });

  // Cliques nos botões de AUX 1 a 8
  auxBtns.forEach(btn => {
    // Clique simples: troca modo fader
    btn.addEventListener('click', (e) => {
      const auxIdx = parseInt(e.currentTarget.getAttribute('data-aux'));
      
      activeFaderMode = 'aux';
      activeAuxSendIndex = auxIdx;

      // Desliga LED do HOME
      btnHome.classList.remove('active');
      ledHome.classList.remove('active');

      // Liga o LED do AUX correto e desliga os demais
      auxBtns.forEach(b => {
        const idx = parseInt(b.getAttribute('data-aux'));
        const led = b.querySelector('.btn-led');
        if (idx === auxIdx) {
          b.classList.add('active');
          led.classList.add('active');
        } else {
          b.classList.remove('active');
          led.classList.remove('active');
        }
      });

      // Remapeia faders para a matriz de envios do Auxiliar correspondente
      updateSlotsMapping();
      updateLCD();

      sendWSMessage({
        type: 'navigate',
        action: 'fadermode',
        mode: 'aux',
        auxIndex: auxIdx
      });
    });

    // Duplo clique: renomeia o auxiliar
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const auxIdx = parseInt(btn.getAttribute('data-aux'));
      const currentName = mixerState.aux[auxIdx]?.name || `AUX ${auxIdx}`;
      const newName = prompt(`Renomear AUX ${auxIdx}:`, currentName);
      if (newName === null) return;
      const trimmed = newName.trim();
      const finalName = trimmed || `AUX ${auxIdx}`;
      mixerState.aux[auxIdx].name = finalName;
      updateAuxButtonLabels();
      updateSlotsMapping();
      updateLCD();
      saveChannelNames();
      const inputEl = document.getElementById(`aux-name-${auxIdx}`);
      if (inputEl) inputEl.value = finalName;
      sendWSMessage({
        type: 'rename',
        target: 'aux',
        channel: auxIdx,
        name: finalName
      });
    });
  });
}

function updateAuxButtonLabels() {
  for (let a = 1; a <= 8; a++) {
    const label = document.getElementById(`aux-label-${a}`);
    if (!label) continue;
    const name = mixerState.aux[a]?.name;
    label.textContent = name || `AUX ${a}`;
  }
}

function updateAuxButtonColors() {
  const defaultBg = '';
  const defaultBorder = '';
  for (let a = 1; a <= 8; a++) {
    const btn = document.querySelector(`.btn-aux[data-aux="${a}"]`);
    if (!btn) continue;
    const color = (channelColors.aux && channelColors.aux[a]) || null;
    if (color) {
      btn.style.borderColor = color;
      btn.style.background = `linear-gradient(180deg, ${hexToRgba(color, 0.25)} 0%, #1f2937 100%)`;
    } else {
      btn.style.borderColor = defaultBorder;
      btn.style.background = defaultBg;
    }
  }
}

// -------------------------------------------------------------
// GERENCIAMENTO DO DISPLAY LCD AZUL
// -------------------------------------------------------------

/**
 * Atualiza todas as informações impressas na tela LCD retroiluminada
 */
function updateLCD() {
  const lcdSelCh = document.getElementById('lcd-sel-ch');
  const lcdChName = document.getElementById('lcd-ch-name');
  const lcdModeStatus = document.getElementById('lcd-mode-status');

  // 1. Canal Selecionado
  let typeLabel = '';
  if (selectedTarget === 'input') typeLabel = 'CH';
  else if (selectedTarget === 'bus') typeLabel = 'BUS';
  else if (selectedTarget === 'aux') typeLabel = 'AUX';
  else if (selectedTarget === 'master') typeLabel = 'MST';

  const chNum = selectedTarget === 'master' ? '' : String(selectedChannel).padStart(2, '0');
  lcdSelCh.textContent = `${typeLabel} ${chNum}`.trim();

  // 2. Nome do Canal Selecionado
  if (selectedTarget === 'master') {
    const masterState = mixerState.master[1];
    lcdChName.textContent = masterState ? masterState.name.toUpperCase() : 'STEREO MASTER';
  } else {
    const state = mixerState[selectedTarget][selectedChannel];
    lcdChName.textContent = state ? state.name.toUpperCase() : 'NO NAME';
  }

  // 3. Fader Mode
  if (activeFaderMode === 'home') {
    lcdModeStatus.textContent = 'HOME (STEREO OUT)';
    lcdModeStatus.className = 'lcd-highlight';
  } else if (activeFaderMode === 'aux') {
    const auxName = mixerState.aux[activeAuxSendIndex].name.toUpperCase();
    lcdModeStatus.textContent = `SENDS ON FADER -> ${auxName}`;
    lcdModeStatus.className = 'lcd-highlight';
  }
}

/**
 * Exibe temporariamente o valor de fader em dB no LCD ao mover o slider
 * 
 * @param {number} rawValue Valor de 10 bits (0-1023)
 */
let lcdValueTimer = null;
function showValueOnLCD(rawValue) {
  const lcdChName = document.getElementById('lcd-ch-name');
  
  // Converte valor 0-1023 em escala de decibéis aproximada (+10 dB a -inf dB)
  let dbVal = '';
  if (rawValue === 0) {
    dbVal = '-oo dB';
  } else {
    const db = ((rawValue / 1023) * 80) - 70; // 0 = -70dB, 1023 = +10dB
    dbVal = db >= 0 ? `+${db.toFixed(1)} dB` : `${db.toFixed(1)} dB`;
  }

  // Cancela timer anterior se houver
  if (lcdValueTimer) clearTimeout(lcdValueTimer);

  // Substitui temporariamente o nome do canal pelo valor de dB no LCD
  const originalName = lcdChName.textContent;
  lcdChName.textContent = `LEVEL: ${dbVal}`;

  // Restaura o nome original após 1.2 segundos sem mexer
  lcdValueTimer = setTimeout(() => {
    updateLCD();
  }, 1200);
}

// -------------------------------------------------------------
// PERSISTÊNCIA LOCAL
// -------------------------------------------------------------

function saveChannelNames() {
  const names = {
    input: {},
    aux: {},
    bus: {},
    master: {}
  };

  for (let c = 1; c <= 32; c++) {
    names.input[c] = mixerState.input[c].name;
  }
  for (let c = 1; c <= 8; c++) {
    names.aux[c] = mixerState.aux[c].name;
    names.bus[c] = mixerState.bus[c].name;
  }
  names.master[1] = mixerState.master[1].name;

  localStorage.setItem(localChannelNamesKey, JSON.stringify(names));
}

function loadChannelNames() {
  try {
    const saved = localStorage.getItem(localChannelNamesKey);
    if (saved) {
      const names = JSON.parse(saved);
      if (names.input) {
        for (let c = 1; c <= 32; c++) {
          if (names.input[c]) mixerState.input[c].name = names.input[c];
        }
      }
      if (names.aux) {
        for (let c = 1; c <= 8; c++) {
          if (names.aux[c]) {
            mixerState.aux[c].name = names.aux[c];
            // Sincroniza o input correspondente na aba de Configurações
            const inputEl = document.getElementById(`aux-name-${c}`);
            if (inputEl) inputEl.value = names.aux[c];
          }
        }
      }
      if (names.bus) {
        for (let c = 1; c <= 8; c++) {
          if (names.bus[c]) mixerState.bus[c].name = names.bus[c];
        }
      }
      if (names.master && names.master[1]) {
        mixerState.master[1].name = names.master[1];
      }
    }
    updateAuxButtonLabels();
  } catch (e) {
    console.error('Falha ao carregar nomes do LocalStorage', e);
  }
}

// -------------------------------------------------------------
// WEBSOCKET & SYNC
// -------------------------------------------------------------

function initWebSocket() {
  const wsDot = document.getElementById('ws-dot');
  const wsText = document.getElementById('ws-text');
  
  wsDot.className = 'status-dot connecting';
  wsText.textContent = 'Connecting...';

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:3000';
  
  try {
    ws = new WebSocket(`${protocol}//${host}`);

    ws.onopen = () => {
      wsDot.className = 'status-dot connected';
      wsText.textContent = 'Connected';
      
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
      
      startLatencyCheck();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleIncomingMessage(data);
      } catch (e) {
        console.error('Erro ao ler pacote WebSocket:', e);
      }
    };

    ws.onclose = () => {
      wsDot.className = 'status-dot disconnected';
      wsText.textContent = 'Disconnected';
      
      if (!reconnectTimer) {
        reconnectTimer = setInterval(initWebSocket, CONFIG.reconnectInterval);
      }
    };
  } catch (err) {
    console.error('Conexão WebSocket falhou:', err);
  }
}

function handleIncomingMessage(data) {
  // 1. Atualizações de volume (fader) ou ativo (mute/ON)
  if (data.type === 'fader' || data.type === 'mute') {
    const { type, target, channel, value, auxIndex } = data;
    
    // Atualiza estado lógico do mixer
    if (target === 'auxsend') {
      if (mixerState.auxsend[channel] && mixerState.auxsend[channel][auxIndex]) {
        if (type === 'fader') mixerState.auxsend[channel][auxIndex].fader = value;
        else if (type === 'mute') mixerState.auxsend[channel][auxIndex].mute = value;
      }
    } else {
      if (mixerState[target] && mixerState[target][channel]) {
        if (type === 'fader') mixerState[target][channel].fader = value;
        else if (type === 'mute') mixerState[target][channel].mute = value;
      }
    }

    // Se o canal alterado estiver visível na tela atualmente, atualiza a interface física
    for (let slot = 1; slot <= 16; slot++) {
      const ctrl = stripControls[slot];
      
      // Se for atualização de Aux Send e estivermos no modo Sends on Fader ativo daquele Aux
      if (target === 'auxsend' && activeFaderMode === 'aux' && activeAuxSendIndex === auxIndex) {
        if (ctrl.target === 'input' && ctrl.channel === channel) {
          syncSlotUI(slot);
          break;
        }
      } 
      // Se for modo normal
      else if (target !== 'auxsend' && ctrl.target === target && ctrl.channel === channel) {
        syncSlotUI(slot);
        break;
      }
    }

    // Se for alteração no Master
    if (target === 'master' && channel === 1 && activeFaderMode === 'home') {
      syncMasterUI();
    } else if (target === 'aux' && channel === activeAuxSendIndex && activeFaderMode === 'aux') {
      syncMasterUI();
    }

    // Atualiza LCD se o canal alterado for o selecionado
    if (target === selectedTarget && channel === selectedChannel) {
      updateLCD();
    }
  }
  
  // 1.2. Atualizações de Renomeação
  else if (data.type === 'rename') {
    const { target, channel, name } = data;
    if (mixerState[target] && mixerState[target][channel]) {
      mixerState[target][channel].name = name;
      saveChannelNames();

      // Se o canal alterado estiver visível na tela atualmente, atualiza a interface física
      for (let slot = 1; slot <= 16; slot++) {
        const ctrl = stripControls[slot];
        if (ctrl && ctrl.target === target && ctrl.channel === channel) {
          ctrl.nameInput.value = name;
          break;
        }
      }

      // Se for alteração no Master
      if (target === 'master' && channel === 1 && activeFaderMode === 'home') {
        if (masterControls) {
          masterControls.nameInput.value = name;
          const hasName = name && name.trim() && !/^STEREO$/i.test(name);
          masterControls.numLabel.style.display = hasName ? 'none' : 'inline';
          masterControls.nameInput.style.display = hasName ? 'inline' : 'none';
        }
      } else if (target === 'aux' && channel === activeAuxSendIndex && activeFaderMode === 'aux') {
        if (masterControls) masterControls.nameInput.value = name;
      }

      // Atualiza LCD se o canal alterado for o selecionado
      if (target === selectedTarget && channel === selectedChannel) {
        updateLCD();
      }

      // Sincroniza o valor do input na tela de configurações se for Aux
      if (target === 'aux') {
        const inputEl = document.getElementById(`aux-name-${channel}`);
        if (inputEl) inputEl.value = name;
      }

      // Atualiza labels dos botões AUX na página home
      updateAuxButtonLabels();
    }
  }
  
  // 1.2.5. Atualizações de Cor
  else if (data.type === 'color') {
    const { target, channel, value } = data;
    if (mixerState[target] && mixerState[target][channel]) {
      mixerState[target][channel].color = value;
    }
    if (!channelColors[target]) {
      channelColors[target] = {};
    }
    channelColors[target][channel] = value;
    localStorage.setItem(localChannelColorsKey, JSON.stringify(channelColors));

    // Se o canal alterado estiver visível na tela atualmente, atualiza a interface física
    for (let slot = 1; slot <= 16; slot++) {
      const ctrl = stripControls[slot];
      if (ctrl && ctrl.target === target && ctrl.channel === channel) {
        applyChannelColor(slot, value);
        if (ctrl.colorPicker) {
          ctrl.colorPicker.value = value;
        }
        break;
      }
    }

    // Atualiza botões AUX na página home se a cor for de um auxiliar
    if (target === 'aux') updateAuxButtonColors();

    // Se for alteração no Master ou Auxiliar ativo no Master
    if (target === 'master' && channel === 1 && activeFaderMode === 'home') {
      applyMasterColor(value);
      if (masterControls && masterControls.colorPicker) {
        masterControls.colorPicker.value = value;
      }
    } else if (target === 'aux' && channel === activeAuxSendIndex && activeFaderMode === 'aux') {
      applyMasterColor(value);
      if (masterControls && masterControls.colorPicker) {
        masterControls.colorPicker.value = value;
      }
    }
  }

  // 1.3. Atualizações do Pan
  else if (data.type === 'pan') {
    const { target, channel, value } = data;
    if (mixerState[target] && mixerState[target][channel]) {
      mixerState[target][channel].pan = value;
    }

    // Se o canal alterado estiver visível na tela atualmente, atualiza a interface física
    for (let slot = 1; slot <= 16; slot++) {
      const ctrl = stripControls[slot];
      if (ctrl && ctrl.target === target && ctrl.channel === channel) {
        updatePanUI(slot, value);
        break;
      }
    }
  }
  
  // 1.4. Atualizações de Roteamento (PRE / POST fader)
  else if (data.type === 'routing') {
    const { target, channel, value, auxIndex } = data;
    if (target === 'auxsend') {
      if (mixerState.auxsend[channel] && mixerState.auxsend[channel][auxIndex]) {
        mixerState.auxsend[channel][auxIndex].routing = value;
      }
    }

    // Se o canal alterado estiver visível na tela atualmente, atualiza a interface física
    for (let slot = 1; slot <= 16; slot++) {
      const ctrl = stripControls[slot];
      if (ctrl && ctrl.target === 'input' && ctrl.channel === channel && activeFaderMode === 'aux' && activeAuxSendIndex === auxIndex) {
        syncSlotUI(slot);
        break;
      }
    }
  }
  
  // 1.4.5. Atualizações de Roteamento para BUS (busRouting)
  else if (data.type === 'routing_bus') {
    const { target, channel, bus, value } = data;
    if (mixerState[target] && mixerState[target][channel]) {
      if (bus === 'stereo' && target === 'bus') {
        mixerState[target][channel].routeToStereo = value;
      } else if (mixerState[target][channel].busRouting) {
        mixerState[target][channel].busRouting[bus] = value;
      }
    }
    // Atualiza UI do FX se estiver visível
    if (target === 'fxreturn' && activeTab === 'fx') {
      updateFxRtnRoutingUI();
    }
  }
  
  // 1.5. Atualizações do Equalizador Paramétrico (EQ)
  else if (data.type === 'eq') {
    const { target, channel, band, param, value } = data;
    if (mixerState[target] && mixerState[target][channel]) {
      const eqState = mixerState[target][channel].eq;
      if (eqState) {
        if (param === 'on') {
          eqState.on = value;
        } else if (band && (param === 'q' || param === 'freq' || param === 'gain' || param === 'type')) {
          if (!eqState.bands[band]) {
            eqState.bands[band] = { q: 64, freq: 64, gain: 64, type: 'peaking' };
          }
          eqState.bands[band][param] = value;
        }

        // Sincroniza visual do botão EQ na mesa se o canal estiver visível
        if (target === 'input' || target === 'aux') {
          for (let slot = 1; slot <= 16; slot++) {
            const ctrl = stripControls[slot];
            if (ctrl && ctrl.target === target && ctrl.channel === channel) {
              if (eqState.on === 1) {
                ctrl.eqBtn.classList.add('active');
              } else {
                ctrl.eqBtn.classList.remove('active');
              }
              break;
            }
          }
          // Se for aux e estiver ativo no master
          if (target === 'aux' && activeFaderMode === 'aux' && channel === activeAuxSendIndex) {
            if (masterControls) {
              if (eqState.on === 1) {
                masterControls.eqBtn.classList.add('active');
              } else {
                masterControls.eqBtn.classList.remove('active');
              }
            }
          }
        } else if (target === 'master' && channel === 1 && activeFaderMode === 'home') {
          if (masterControls) {
            if (eqState.on === 1) {
              masterControls.eqBtn.classList.add('active');
            } else {
              masterControls.eqBtn.classList.remove('active');
            }
          }
        }

        // Sincroniza visual da gaveta se estiver aberta para este canal
        const drawer = document.getElementById('channel-control-drawer');
        if (channel === selectedChannel && target === selectedTarget && drawer && drawer.style.display !== 'none') {
          updateEQDrawerUI();
        }
      }
    }
  }
  
  // 1.6. Atualizações do Gate (GATE)
  else if (data.type === 'gate') {
    const { target, channel, param, value } = data;
    if (mixerState[target] && mixerState[target][channel]) {
      const gateState = mixerState[target][channel].gate;
      if (gateState) {
        if (param === 'on') {
          gateState.on = value;
        } else if (param) {
          gateState[param] = value;
        }

        // Sincroniza visual do botão DYNAMIC na mesa se o canal estiver visível
        if (target === 'input' || target === 'aux') {
          for (let slot = 1; slot <= 16; slot++) {
            const ctrl = stripControls[slot];
            if (ctrl && ctrl.target === target && ctrl.channel === channel) {
              const compState = mixerState[target][channel].comp;
              const isDynActive = (gateState.on === 1) || (compState && compState.on === 1);
              if (isDynActive) {
                ctrl.dynBtn.classList.add('active');
              } else {
                ctrl.dynBtn.classList.remove('active');
              }
              break;
            }
          }
          // Se for aux e estiver ativo no master
          if (target === 'aux' && activeFaderMode === 'aux' && channel === activeAuxSendIndex) {
            if (masterControls) {
              const compState = mixerState.aux[channel].comp;
              const isDynActive = (gateState.on === 1) || (compState && compState.on === 1);
              if (isDynActive) {
                masterControls.dynBtn.classList.add('active');
              } else {
                masterControls.dynBtn.classList.remove('active');
              }
            }
          }
        } else if (target === 'master' && channel === 1 && activeFaderMode === 'home') {
          if (masterControls) {
            const compState = mixerState.master[1].comp;
            const isDynActive = (gateState.on === 1) || (compState && compState.on === 1);
            if (isDynActive) {
              masterControls.dynBtn.classList.add('active');
            } else {
              masterControls.dynBtn.classList.remove('active');
            }
          }
        }

        // Sincroniza visual do painel se estiver aberto para este canal
        const drawer = document.getElementById('channel-control-drawer');
        if (channel === selectedChannel && target === selectedTarget && drawer && drawer.style.display !== 'none') {
          updateGatePaneUI();
        }
      }
    }
  }

  // 1.7. Atualizações do Compressor (COMP)
  else if (data.type === 'comp') {
    const { target, channel, param, value } = data;
    if (mixerState[target] && mixerState[target][channel]) {
      const compState = mixerState[target][channel].comp;
      if (compState) {
        if (param === 'on') {
          compState.on = value;
        } else if (param) {
          compState[param] = value;
        }

        // Sincroniza visual do botão DYNAMIC na mesa se o canal estiver visível
        if (target === 'input' || target === 'aux') {
          for (let slot = 1; slot <= 16; slot++) {
            const ctrl = stripControls[slot];
            if (ctrl && ctrl.target === target && ctrl.channel === channel) {
              const gateState = mixerState[target][channel].gate;
              const isDynActive = (gateState && gateState.on === 1) || (compState.on === 1);
              if (isDynActive) {
                ctrl.dynBtn.classList.add('active');
              } else {
                ctrl.dynBtn.classList.remove('active');
              }
              break;
            }
          }
          // Se for aux e estiver ativo no master
          if (target === 'aux' && activeFaderMode === 'aux' && channel === activeAuxSendIndex) {
            if (masterControls) {
              const gateState = mixerState.aux[channel].gate;
              const isDynActive = (gateState && gateState.on === 1) || (compState.on === 1);
              if (isDynActive) {
                masterControls.dynBtn.classList.add('active');
              } else {
                masterControls.dynBtn.classList.remove('active');
              }
            }
          }
        } else if (target === 'master' && channel === 1 && activeFaderMode === 'home') {
          if (masterControls) {
            const gateState = mixerState.master[1].gate;
            const isDynActive = (gateState && gateState.on === 1) || (compState.on === 1);
            if (isDynActive) {
              masterControls.dynBtn.classList.add('active');
            } else {
              masterControls.dynBtn.classList.remove('active');
            }
          }
        }

        // Sincroniza visual do painel se estiver aberto para este canal
        const drawer = document.getElementById('channel-control-drawer');
        if (channel === selectedChannel && target === selectedTarget && drawer && drawer.style.display !== 'none') {
          updateCompPaneUI();
        }
      }
    }
  }
  
  // 1.7. Atualizações de Efeitos (FX)
  else if (data.type === 'fx') {
    const { processor, param, value } = data;
    if (mixerState.fx && mixerState.fx[processor]) {
      mixerState.fx[processor][param] = value;
      if (activeTab === 'fx') updateFXDrawerUI();
    }
  }
  else if (data.type === 'fx_type') {
    const { processor, value: newType } = data;
    if (mixerState.fx && mixerState.fx[processor]) {
      const oldMix = mixerState.fx[processor].mix;
      const oldOn = mixerState.fx[processor].on;
      mixerState.fx[processor] = createDefaultFXParams(newType);
      mixerState.fx[processor].mix = oldMix;
      mixerState.fx[processor].on = oldOn;
      if (activeTab === 'fx') updateFXDrawerUI();
    }
  }

  // 1.8 Sincronização de Navegação e Estados Visuais
  else if (data.type === 'navigate') {
    const { action, value, mode, auxIndex, target, channel, tab, band, open } = data;

    if (action === 'layer') {
      const targetLayer = value === 'customize' ? 'config' : value;
      activeLayer = targetLayer;
      // Atualiza abas visuais do Layer no HTML
      const tabs = document.querySelectorAll('.layer-tab');
      tabs.forEach(t => {
        if (t.getAttribute('data-layer') === targetLayer) {
          t.classList.add('active');
        } else {
          t.classList.remove('active');
        }
      });
      updateSlotsMapping();
    }
    
    else if (action === 'fadermode') {
      activeFaderMode = mode;
      if (mode === 'aux') {
        activeAuxSendIndex = auxIndex;
      }

      // Atualiza botões e LEDs de Home / Aux na tela
      const btnHome = document.getElementById('btn-mode-home');
      const ledHome = document.getElementById('led-home');
      const auxBtns = document.querySelectorAll('.btn-aux');

      if (mode === 'home') {
        btnHome.classList.add('active');
        ledHome.classList.add('active');
        auxBtns.forEach(btn => {
          btn.classList.remove('active');
          btn.querySelector('.btn-led').classList.remove('active');
        });
      } else {
        btnHome.classList.remove('active');
        ledHome.classList.remove('active');
        auxBtns.forEach(btn => {
          const idx = parseInt(btn.getAttribute('data-aux'));
          const led = btn.querySelector('.btn-led');
          if (idx === auxIndex) {
            btn.classList.add('active');
            led.classList.add('active');
          } else {
            btn.classList.remove('active');
            led.classList.remove('active');
          }
        });
      }
      updateSlotsMapping();
      updateLCD();
    }
    
    else if (action === 'select') {
      selectChannel(target, channel, true);
    }
    
    else if (action === 'drawer') {
      const drawer = document.getElementById('channel-control-drawer');
      if (drawer) {
        if (open === false) {
          drawer.style.display = 'none';
          updateLayoutVisibility();
        } else {
          // Garante a sincronização do canal selecionado em rede
          selectChannel(target, channel, true);
          activeTab = tab;
          drawer.style.display = 'block';
          updateLayoutVisibility();

          // Sincroniza abas do drawer
          document.querySelectorAll('.drawer-tab').forEach(t => {
            t.classList.remove('active');
            if (t.getAttribute('data-tab') === tab) {
              t.classList.add('active');
            }
          });

          // Exibe o painel correto
          document.querySelectorAll('.drawer-pane').forEach(p => p.style.display = 'none');
          document.getElementById('drawer-eq-section').style.display = 'none';
          if (tab === 'rta') {
            document.getElementById('pane-rta').style.display = 'flex';
            document.getElementById('drawer-eq-section').style.display = '';
          } else {
            document.getElementById(`pane-${tab}`).style.display = 'grid';
          }

          // Redesenha canvas do painel ativado
          setTimeout(() => {
            if (tab === 'rta') {
              RTAModule.resizeCanvas();
              RTAModule.openPanel();
            } else {
              RTAModule.stop();
              const canvasMap = {
                eq: document.getElementById('eq-canvas'),
                gate: document.getElementById('gate-canvas'),
                comp: document.getElementById('comp-canvas')
              };
              const canvas = canvasMap[tab];
              if (canvas) {
                const rect = canvas.getBoundingClientRect();
                canvas.width = rect.width * window.devicePixelRatio;
                canvas.height = rect.height * window.devicePixelRatio;
              }
            }
            updateChannelControlDrawerUI();
            updateLayoutVisibility();
          }, 50);
        }
      }
    }

    else if (action === 'eqband') {
      activeEQBand = band;
      const tabEl = document.getElementById(`tab-band-${band}`);
      if (tabEl) {
        document.querySelectorAll('.eq-band-tab').forEach(t => t.classList.remove('active'));
        tabEl.classList.add('active');
        document.getElementById('channel-control-drawer').setAttribute('data-active-band', band);
      }
      updateEQDrawerUI();
    }
  }
  
  // 2. Sincronização geral de dados inicial
  else if (data.type === 'sync') {
    console.log('Sincronização geral recebida:', data.state);
    
    // Sincroniza canais normais
    for (const target in data.state) {
      if (target === 'auxsend') continue;
      for (const ch in data.state[target]) {
        if (mixerState[target] && mixerState[target][ch]) {
          mixerState[target][ch].fader = data.state[target][ch].fader;
          mixerState[target][ch].mute = data.state[target][ch].mute;
          if (data.state[target][ch].name !== undefined) {
            mixerState[target][ch].name = data.state[target][ch].name;
          }
          if (data.state[target][ch].color !== undefined) {
            mixerState[target][ch].color = data.state[target][ch].color;
            if (!channelColors[target]) {
              channelColors[target] = {};
            }
            channelColors[target][ch] = data.state[target][ch].color;
          }
          
          // Se for input, sincroniza também o EQ e Dinâmica
          if (target === 'input') {
            if (data.state.input[ch].eq) mixerState.input[ch].eq = data.state.input[ch].eq;
            if (data.state.input[ch].gate) mixerState.input[ch].gate = data.state.input[ch].gate;
            if (data.state.input[ch].comp) mixerState.input[ch].comp = data.state.input[ch].comp;
            if (data.state.input[ch].busRouting) mixerState.input[ch].busRouting = data.state.input[ch].busRouting;
          }

          // Se for bus, sincroniza routeToStereo
          if (target === 'bus') {
            if (data.state.bus[ch].routeToStereo !== undefined) mixerState.bus[ch].routeToStereo = data.state.bus[ch].routeToStereo;
          }
        }
      }
    }

    // Sincroniza FX Return (EQ, busRouting)
    if (data.state.fxreturn) {
      for (const ch in data.state.fxreturn) {
        if (mixerState.fxreturn[ch]) {
          if (data.state.fxreturn[ch].eq) mixerState.fxreturn[ch].eq = data.state.fxreturn[ch].eq;
          if (data.state.fxreturn[ch].busRouting) mixerState.fxreturn[ch].busRouting = data.state.fxreturn[ch].busRouting;
        }
      }
    }

    // Sincroniza FX processors
    if (data.state.fx) {
      for (const p in data.state.fx) {
        if (mixerState.fx[p]) Object.assign(mixerState.fx[p], data.state.fx[p]);
      }
    }

    // Sincroniza matriz auxsend
    if (data.state.auxsend) {
      for (const ch in data.state.auxsend) {
        for (const auxIdx in data.state.auxsend[ch]) {
          if (mixerState.auxsend[ch] && mixerState.auxsend[ch][auxIdx]) {
            mixerState.auxsend[ch][auxIdx].fader = data.state.auxsend[ch][auxIdx].fader;
            mixerState.auxsend[ch][auxIdx].mute = data.state.auxsend[ch][auxIdx].mute;
          }
        }
      }
    }
    
    // Atualiza labels e cores dos botões AUX
    updateAuxButtonLabels();
    updateAuxButtonColors();
    
    // Salva localmente os nomes atualizados vindos do servidor
    saveChannelNames();
    
    // Salva localmente as cores atualizadas vindas do servidor
    localStorage.setItem(localChannelColorsKey, JSON.stringify(channelColors));
    
    // Recarrega visual da tela (com animação se for recall de cena)
    updateSlotsMapping(data.isRecall === true);
    updateLCD();
  }

  // 2.5. Lista de cenas recebida do servidor
  else if (data.type === 'scenes_list') {
    scenesList = data.scenes;
    if (activeLayer === 'scenes') {
      renderScenesList();
    }
  }

  // 2.6. Cena ativa atualizada
  else if (data.type === 'active_scene') {
    activeSceneSlot = data.slot;
    if (activeLayer === 'scenes') {
      renderScenesList();
    }
  }

  // 2.7. Lista de portas MIDI recebida
  else if (data.type === 'midi_ports') {
    updateMIDISettingsUI(data);
  }

  // 3. Status MIDI física
  else if (data.type === 'status') {
    const midiDot = document.getElementById('midi-dot');
    const midiText = document.getElementById('midi-text');
    const lcdMidiName = document.getElementById('lcd-midi-port-name');
    
    midiText.textContent = data.status;
    lcdMidiName.textContent = `MIDI: ${data.status.toUpperCase()}`;

    if (data.status.toLowerCase().includes('connected to')) {
      midiDot.className = 'status-dot connected';
    } else if (data.status.toLowerCase().includes('disconnected') || data.status.toLowerCase().includes('demo')) {
      midiDot.className = 'status-dot disconnected';
      midiText.textContent = 'Disconnected (Demo Mode)';
      lcdMidiName.textContent = 'MIDI: SIMULATION MODE';
    } else {
      midiDot.className = 'status-dot connecting';
    }

    // Sincroniza o painel de configurações MIDI
    updateMIDIStatusFromMain(data.status);

    // Atualiza lista de portas MIDI após qualquer mudança de status
    setTimeout(requestMIDIPorts, 500);
  }

  // 4. Pong de latência
  else if (data.type === 'pong') {
    const elapsed = Date.now() - lastPingTime;
    document.getElementById('latency-val').textContent = `${elapsed} ms`;
  }
}

function sendWSMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function startLatencyCheck() {
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      lastPingTime = Date.now();
      sendWSMessage({ type: 'ping' });
    }
  }, CONFIG.latencyInterval);
}

// -------------------------------------------------------------
// SIMULAÇÃO DO VU METER (ESTÉTICA PREMIUM)
// -------------------------------------------------------------

function startVUMetersSimulation() {
  const lcdVuL = document.getElementById('lcd-vu-l');
  const lcdVuR = document.getElementById('lcd-vu-r');

  setInterval(() => {
    // 1. Tiras de faders visuais
    for (let slot = 1; slot <= 16; slot++) {
      const ctrl = stripControls[slot];
      if (!ctrl) continue;

      const { target, channel } = ctrl;
      
      // Se em Sends on Fader, o volume do VU oscila com base no fader de envio
      if (target === 'input' && activeFaderMode === 'aux') {
        const sendState = mixerState.auxsend[channel][activeAuxSendIndex];
        if (!sendState || sendState.mute === 1 || sendState.fader === 0) {
          ctrl.vuBar.style.height = '100%'; // cobre tudo (sem sinal)
          continue;
        }

        const baseHeight = (sendState.fader / 1023) * 88;
        const noise = (Math.random() - 0.5) * 16;
        let level = Math.max(0, Math.min(100, baseHeight + noise));
        if (level < 5) level = 0;
        // Overlay escuro: quanto maior o nível, menor a barra (revela o gradiente de baixo)
        ctrl.vuBar.style.height = `${100 - level}%`;
      } 
      
      // Modo normal
      else {
        const state = mixerState[target][channel];
        if (!state || state.mute === 1 || state.fader === 0) {
          ctrl.vuBar.style.height = '100%'; // cobre tudo (sem sinal)
          continue;
        }

        const baseHeight = (state.fader / 1023) * 88;
        const noise = (Math.random() - 0.5) * 16;
        let level = Math.max(0, Math.min(100, baseHeight + noise));
        if (level < 5) level = 0;
        // Overlay escuro: quanto maior o nível, menor a barra (revela o gradiente de baixo)
        ctrl.vuBar.style.height = `${100 - level}%`;
      }
    }

    // 2. Fader Master Físico (Master Estéreo ou Master do Aux)
    const master = masterControls;
    let masterFaderVal = 0;
    let masterMuted = true;

    if (activeFaderMode === 'home') {
      const state = mixerState.master[1];
      masterFaderVal = state.fader;
      masterMuted = state.mute === 1;
    } else {
      const state = mixerState.aux[activeAuxSendIndex];
      masterFaderVal = state.fader;
      masterMuted = state.mute === 1;
    }

    if (master && masterMuted === false && masterFaderVal > 0) {
      const baseHeight = (masterFaderVal / 1023) * 88;
      const noiseL = (Math.random() - 0.45) * 12;
      const noiseR = (Math.random() - 0.45) * 12;

      let levelL = Math.max(0, Math.min(100, baseHeight + noiseL));
      let levelR = Math.max(0, Math.min(100, baseHeight + noiseR));

      if (levelL < 5) levelL = 0;
      if (levelR < 5) levelR = 0;

      // Overlay escuro invertido para o Master VU
      master.vuBarL.style.height = `${100 - levelL}%`;
      master.vuBarR.style.height = `${100 - levelR}%`;
    } else if (master) {
      master.vuBarL.style.height = '100%'; // cobre tudo (sem sinal)
      master.vuBarR.style.height = '100%';
    }

    // 3. VU Meters Estéreo Horizontais do Display LCD Azul (Mostram a Saída Estéreo Principal)
    const stState = mixerState.master[1];
    if (stState && stState.mute === 0 && stState.fader > 0) {
      const basePct = (stState.fader / 1023) * 90;
      const noiseL = (Math.random() - 0.5) * 15;
      const noiseR = (Math.random() - 0.5) * 15;
      
      const widthL = Math.max(0, Math.min(100, basePct + noiseL));
      const widthR = Math.max(0, Math.min(100, basePct + noiseR));
      
      lcdVuL.style.width = `${widthL}%`;
      lcdVuR.style.width = `${widthR}%`;
    } else {
      lcdVuL.style.width = '0%';
      lcdVuR.style.width = '0%';
    }

    // 4. VU de Gain Reduction (GR) do Compressor (apenas se a gaveta estiver aberta na aba COMP)
    const drawer = document.getElementById('channel-control-drawer');
    const compPane = document.getElementById('pane-comp');
    if (drawer && drawer.style.display !== 'none' && compPane && compPane.style.display !== 'none') {
      const compState = mixerState[selectedTarget][selectedChannel]?.comp;
      const faderVal = mixerState[selectedTarget][selectedChannel]?.fader || 0;
      const grFill = document.getElementById('comp-gr-fill');
      
      if (compState && compState.on === 1 && faderVal > 0 && grFill) {
        // Sinal de entrada estimado a partir da posição do fader (mapeado de -80dB a +10dB)
        const inputDB = (faderVal / 1023) * 90 - 80;
        const threshDB = DYN_MATH.midiToCompThreshold(compState.threshold);
        const ratio = DYN_MATH.midiToRatio(compState.ratio);
        
        let reduction = 0;
        if (inputDB > threshDB) {
          const over = inputDB - threshDB;
          reduction = over * (1 - 1 / ratio);
        }
        
        if (reduction > 0.5) {
          const noise = (Math.random() - 0.5) * 1.5;
          reduction = Math.max(0, reduction + noise);
        }
        
        // Mapear redução de 0dB a 24dB em porcentagem (0% a 100% de altura do fill)
        const pct = Math.max(0, Math.min(100, (reduction / 24) * 100));
        grFill.style.height = `${pct}%`;
      } else if (grFill) {
        grFill.style.height = '0%';
      }
    }

  }, 80);
}

// =============================================================
// SISTEMA DE EQUALIZAÇÃO PARAMÉTRICA DE 4 BANDAS (ESTILO MIXING STATION)
// =============================================================

// Mapeamentos Matemáticos para o Equalizador
const EQ_MATH = {
  // Converte valor MIDI (0..127) para Ganho em dB (-18..+18)
  midiToGain: (val) => {
    return parseFloat(((val - 64) * (18 / 64)).toFixed(1));
  },
  // Converte Ganho em dB (-18..+18) para valor MIDI (0..127)
  gainToMidi: (db) => {
    return Math.max(0, Math.min(127, Math.round((db * 64 / 18) + 64)));
  },
  
  // Converte valor MIDI (0..127) para Frequência em Hz (20..20000) escala logarítmica
  midiToFreq: (val) => {
    const f = 20 * Math.pow(1000, val / 127);
    return Math.round(f);
  },
  // Converte Frequência em Hz (20..20000) para valor MIDI (0..127)
  freqToMidi: (freq) => {
    const val = 127 * Math.log(freq / 20) / Math.log(1000);
    return Math.max(0, Math.min(127, Math.round(val)));
  },
  
  // Converte valor MIDI (0..127) para Fator Q (0.1..10.0) escala logarítmica
  midiToQ: (val) => {
    const q = 0.1 * Math.pow(100, val / 127);
    return parseFloat(q.toFixed(2));
  },
  // Converte Fator Q (0.1..10.0) para valor MIDI (0..127)
  qToMidi: (q) => {
    const val = 127 * Math.log(q / 0.1) / Math.log(100);
    return Math.max(0, Math.min(127, Math.round(val)));
  }
};

let activeEQBand = 1; // Banda ativa selecionada para sliders (1..4)
let draggingBand = null; // Banda sendo arrastada no canvas (1..4 ou null)
let isMouseInCanvas = false;
let canvasMouseX = 0;
let canvasMouseY = 0;

// Variáveis globais para dinâmica e abas da gaveta
let activeTab = 'eq'; // 'eq' | 'gate' | 'comp' | 'fx'
let draggingGateThreshold = false;
let draggingCompThreshold = false;
let draggingCompRatio = false;

const DYN_MATH = {
  // Gate
  midiToGateThreshold: (val) => Math.round((val / 127) * 50 - 80), // -80 dB a -30 dB
  gateThresholdToMidi: (db) => Math.round(((db + 80) / 50) * 127),
  
  midiToGateRange: (val) => Math.round((val / 127) * -70), // 0 dB a -70 dB
  gateRangeToMidi: (db) => Math.round((db / -70) * 127),
  
  midiToAttack: (val) => Math.round((val / 127) * 119 + 1), // 1 ms a 120 ms
  attackToMidi: (ms) => Math.round(((ms - 1) / 119) * 127),
  
  midiToHold: (val) => val * 20, // 0 ms a 2540 ms
  holdToMidi: (ms) => Math.round(ms / 20),
  
  midiToDecay: (val) => Math.round((val / 127) * 4980 + 20), // 20 ms a 5000 ms
  decayToMidi: (ms) => Math.round(((ms - 20) / 4980) * 127),
  
  // Compressor
  midiToCompThreshold: (val) => Math.round((val / 127) * 54 - 54), // -54 dB a 0 dB
  compThresholdToMidi: (db) => Math.round(((db + 54) / 54) * 127),
  
  midiToRatio: (val) => {
    if (val >= 120) return Infinity;
    return parseFloat((1 + (val / 119) * 19).toFixed(1)); // 1.0 a 20.0
  },
  ratioToMidi: (ratio) => {
    if (ratio === Infinity) return 120;
    return Math.round(((ratio - 1) / 19) * 119);
  },
  
  midiToOutGain: (val) => parseFloat(((val - 64) / 64 * 18).toFixed(1)), // -18.0 dB a +18.0 dB
  outGainToMidi: (db) => Math.round((db / 18) * 64 + 64)
};

// Mapeamentos de dB para pixels e vice-versa no canvas de dinâmica
function dbToX(canvas, db) {
  return ((db + 80) / 80) * canvas.width;
}

function xToDb(canvas, x) {
  return (x / canvas.width) * 80 - 80;
}

function dbToY(canvas, db) {
  return canvas.height - ((db + 80) / 80) * canvas.height;
}

function yToDb(canvas, y) {
  return ((canvas.height - y) / canvas.height) * 80 - 80;
}

function getTouchPos(canvas, e) {
  if (!e.touches || e.touches.length === 0) return null;
  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  return {
    x: (touch.clientX - rect.left) * (canvas.width / rect.width),
    y: (touch.clientY - rect.top) * (canvas.height / rect.height),
    clientX: touch.clientX,
    clientY: touch.clientY
  };
}

function initChannelControlDrawer() {
  const eqCanvas = document.getElementById('eq-canvas');
  const gateCanvas = document.getElementById('gate-canvas');
  const compCanvas = document.getElementById('comp-canvas');
  if (!eqCanvas || !gateCanvas || !compCanvas) return;

  const drawer = document.getElementById('channel-control-drawer');
  const closeBtn = document.getElementById('drawer-close-btn');

  // Redimensionar todos os canvas
  const resizeAllCanvas = () => {
    [eqCanvas, gateCanvas, compCanvas].forEach(c => {
      const rect = c.getBoundingClientRect();
      c.width = rect.width * window.devicePixelRatio;
      c.height = rect.height * window.devicePixelRatio;
    });
    if (typeof RTAModule !== 'undefined' && RTAModule.resizeCanvas) {
      RTAModule.resizeCanvas();
    }
    drawActivePaneCurve();
  };

  window.addEventListener('resize', resizeAllCanvas);
  setTimeout(resizeAllCanvas, 200);

  // 1. Lógica de Troca de Abas do Canal
  document.querySelectorAll('.drawer-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.getAttribute('data-tab');
      activeTab = targetTab;

      document.querySelectorAll('.drawer-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Ocultar/Exibir painéis
      document.querySelectorAll('.drawer-pane').forEach(p => p.style.display = 'none');
      document.getElementById('drawer-eq-section').style.display = 'none';
      if (targetTab === 'rta') {
        document.getElementById('pane-rta').style.display = 'flex';
        document.getElementById('drawer-eq-section').style.display = '';
        setTimeout(() => {
          RTAModule.resizeCanvas();
          RTAModule.openPanel();
        }, 50);
      } else if (targetTab === 'fx') {
        document.getElementById('pane-fx').style.display = 'flex';
        RTAModule.stop();
        updateFXDrawerUI();
      } else {
        document.getElementById(`pane-${targetTab}`).style.display = 'grid';
        RTAModule.stop();
        const canvasMap = { eq: eqCanvas, gate: gateCanvas, comp: compCanvas };
        const activeCanvas = canvasMap[targetTab];
        if (activeCanvas) {
          const rect = activeCanvas.getBoundingClientRect();
          activeCanvas.width = rect.width * window.devicePixelRatio;
          activeCanvas.height = rect.height * window.devicePixelRatio;
        }
      }
      updateChannelControlDrawerUI();

      sendWSMessage({
        type: 'navigate',
        action: 'drawer',
        open: true,
        target: selectedTarget,
        channel: selectedChannel,
        tab: targetTab
      });
    });
  });

  // 2. Fechar Gaveta
  closeBtn.addEventListener('click', () => {
    RTAModule.stop();
    drawer.style.display = 'none';
    updateLayoutVisibility();
    sendWSMessage({
      type: 'navigate',
      action: 'drawer',
      open: false
    });
  });

  // 3. Configurar Controles e Eventos do EQUALIZADOR
  initEQControls(eqCanvas);

  // 4. Configurar Controles e Eventos do GATE
  initGateControls(gateCanvas);

  // 5. Configurar Controles e Eventos do COMPRESSOR
  initCompControls(compCanvas);

  // 6. Navegação rápida entre canais
  buildDrawerChannelNav();

  // 7. Inicializar RTA (Master / Aux only)
  RTAModule.init({
    getMixerState: () => mixerState,
    getSelectedTarget: () => selectedTarget,
    getSelectedChannel: () => selectedChannel
  });

  // Botão toggle do RTA
  document.getElementById('rta-toggle-btn')?.addEventListener('click', () => {
    const statusText = document.getElementById('rta-status-text');
    if (statusText && statusText.textContent === 'ANALISANDO...') {
      RTAModule.stop();
    } else {
      RTAModule.start();
    }
  });
}

function drawActivePaneCurve() {
  if (activeTab === 'eq') drawEQCurve();
  else if (activeTab === 'gate') drawGateCurve();
  else if (activeTab === 'comp') drawCompCurve();
}

function initEQControls(canvas) {
  const sliderGain = document.getElementById('eq-slider-gain');
  const sliderFreq = document.getElementById('eq-slider-freq');
  const sliderQ = document.getElementById('eq-slider-q');
  const bypassBtn = document.getElementById('eq-bypass-btn');

  // Abas das Bandas
  for (let b = 1; b <= 4; b++) {
    const tab = document.getElementById(`tab-band-${b}`);
    if (tab) {
      tab.addEventListener('click', () => {
        activeEQBand = b;
        document.querySelectorAll('.eq-band-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('channel-control-drawer').setAttribute('data-active-band', b);
        updateEQDrawerUI();

        sendWSMessage({
          type: 'navigate',
          action: 'eqband',
          band: b
        });
      });
    }
  }

  // Sliders
  sliderGain.addEventListener('input', (e) => updateEQParameter('gain', parseInt(e.target.value)));
  sliderFreq.addEventListener('input', (e) => updateEQParameter('freq', parseInt(e.target.value)));
  sliderQ.addEventListener('input', (e) => updateEQParameter('q', parseInt(e.target.value)));

  // Bypass
  bypassBtn.addEventListener('click', () => {
    const chState = mixerState[selectedTarget][selectedChannel];
    if (!chState || !chState.eq) return;
    const newVal = chState.eq.on === 1 ? 0 : 1;
    chState.eq.on = newVal;

    sendWSMessage({
      type: 'eq',
      target: selectedTarget,
      channel: selectedChannel,
      param: 'on',
      value: newVal
    });

    updateSlotsMapping();
    updateEQDrawerUI();
  });

  // Mouse no Canvas de EQ
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    let closestBand = null;
    let minDistance = 25 * window.devicePixelRatio;

    for (let b = 1; b <= 4; b++) {
      const coords = getEQPointCoords(canvas, b);
      const dx = x - coords.x;
      const dy = y - coords.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDistance) {
        minDistance = dist;
        closestBand = b;
      }
    }

    if (closestBand !== null) {
      draggingBand = closestBand;
      activeEQBand = closestBand;
      
      document.querySelectorAll('.eq-band-tab').forEach(t => t.classList.remove('active'));
      const tabEl = document.getElementById(`tab-band-${closestBand}`);
      if (tabEl) tabEl.classList.add('active');
      document.getElementById('channel-control-drawer').setAttribute('data-active-band', closestBand);
      
      updateEQDrawerUI();
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    
    isMouseInCanvas = true;
    canvasMouseX = x;
    canvasMouseY = y;

    if (draggingBand !== null) {
      const freq = xToFreq(canvas, x);
      const gain = yToGain(canvas, y);

      const freqMIDI = EQ_MATH.freqToMidi(freq);
      const gainMIDI = EQ_MATH.gainToMidi(gain);

      mixerState[selectedTarget][selectedChannel].eq.bands[draggingBand].freq = freqMIDI;
      const bandType = mixerState[selectedTarget][selectedChannel].eq.bands[draggingBand].type || 'peaking';

      sendWSMessage({
        type: 'eq',
        target: selectedTarget,
        channel: selectedChannel,
        band: draggingBand,
        param: 'freq',
        value: freqMIDI
      });

      if (bandType !== 'hpf' && bandType !== 'lpf') {
        mixerState[selectedTarget][selectedChannel].eq.bands[draggingBand].gain = gainMIDI;
        sendWSMessage({
          type: 'eq',
          target: selectedTarget,
          channel: selectedChannel,
          band: draggingBand,
          param: 'gain',
          value: gainMIDI
        });
      } else {
        mixerState[selectedTarget][selectedChannel].eq.bands[draggingBand].gain = 64;
      }

      updateEQDrawerUI();
      showEQTooltip(e.clientX, e.clientY, draggingBand);
    } else {
      let hoverBand = null;
      let minDistance = 15 * window.devicePixelRatio;

      for (let b = 1; b <= 4; b++) {
        const coords = getEQPointCoords(canvas, b);
        const dx = x - coords.x;
        const dy = y - coords.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDistance) {
          minDistance = dist;
          hoverBand = b;
        }
      }

      if (hoverBand !== null) {
        canvas.style.cursor = 'grab';
        showEQTooltip(e.clientX, e.clientY, hoverBand);
      } else {
        canvas.style.cursor = 'default';
        hideEQTooltip();
      }
    }
  });

  const stopDragging = () => {
    draggingBand = null;
    hideEQTooltip();
  };

  canvas.addEventListener('mouseup', stopDragging);
  canvas.addEventListener('mouseleave', () => {
    isMouseInCanvas = false;
    stopDragging();
  });

  // Eventos de toque (Touch Screen) para o Canvas de EQ
  canvas.addEventListener('touchstart', (e) => {
    const pos = getTouchPos(canvas, e);
    if (!pos) return;
    e.preventDefault();

    const x = pos.x;
    const y = pos.y;

    let closestBand = null;
    let minDistance = 25 * window.devicePixelRatio;

    for (let b = 1; b <= 4; b++) {
      const coords = getEQPointCoords(canvas, b);
      const dx = x - coords.x;
      const dy = y - coords.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDistance) {
        minDistance = dist;
        closestBand = b;
      }
    }

    if (closestBand !== null) {
      draggingBand = closestBand;
      activeEQBand = closestBand;
      
      document.querySelectorAll('.eq-band-tab').forEach(t => t.classList.remove('active'));
      const tabEl = document.getElementById(`tab-band-${closestBand}`);
      if (tabEl) tabEl.classList.add('active');
      document.getElementById('channel-control-drawer').setAttribute('data-active-band', closestBand);
      
      updateEQDrawerUI();
      showEQTooltip(pos.clientX, pos.clientY, closestBand);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (draggingBand === null) return;
    const pos = getTouchPos(canvas, e);
    if (!pos) return;
    e.preventDefault();

    const x = pos.x;
    const y = pos.y;

    const freq = xToFreq(canvas, x);
    const gain = yToGain(canvas, y);

    const freqMIDI = EQ_MATH.freqToMidi(freq);
    const gainMIDI = EQ_MATH.gainToMidi(gain);

    mixerState[selectedTarget][selectedChannel].eq.bands[draggingBand].freq = freqMIDI;
    const bandType = mixerState[selectedTarget][selectedChannel].eq.bands[draggingBand].type || 'peaking';

    sendWSMessage({
      type: 'eq',
      target: selectedTarget,
      channel: selectedChannel,
      band: draggingBand,
      param: 'freq',
      value: freqMIDI
    });

    if (bandType !== 'hpf' && bandType !== 'lpf') {
      mixerState[selectedTarget][selectedChannel].eq.bands[draggingBand].gain = gainMIDI;
      sendWSMessage({
        type: 'eq',
        target: selectedTarget,
        channel: selectedChannel,
        band: draggingBand,
        param: 'gain',
        value: gainMIDI
      });
    } else {
      mixerState[selectedTarget][selectedChannel].eq.bands[draggingBand].gain = 64;
    }

    updateEQDrawerUI();
    showEQTooltip(pos.clientX, pos.clientY, draggingBand);
  }, { passive: false });

  const stopTouchDragging = () => {
    draggingBand = null;
    hideEQTooltip();
  };
  canvas.addEventListener('touchend', stopTouchDragging);
  canvas.addEventListener('touchcancel', stopTouchDragging);

  canvas.addEventListener('wheel', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    let targetBand = null;
    let minDistance = 25 * window.devicePixelRatio;

    for (let b = 1; b <= 4; b++) {
      const coords = getEQPointCoords(canvas, b);
      const dx = x - coords.x;
      const dy = y - coords.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDistance) {
        minDistance = dist;
        targetBand = b;
      }
    }

    if (targetBand !== null) {
      e.preventDefault();
      const bandState = mixerState[selectedTarget][selectedChannel].eq.bands[targetBand];
      let val = bandState.q;

      if (e.deltaY < 0) val = Math.min(127, val + 4);
      else val = Math.max(0, val - 4);

      bandState.q = val;

      sendWSMessage({
        type: 'eq',
        target: selectedTarget,
        channel: selectedChannel,
        band: targetBand,
        param: 'q',
        value: val
      });

      updateEQDrawerUI();
      showEQTooltip(e.clientX, e.clientY, targetBand);
    }
  });

  // Evento dos botões do tipo de filtro
  document.querySelectorAll('.filter-type-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const filterType = e.currentTarget.getAttribute('data-type');
      const eqState = mixerState[selectedTarget][selectedChannel]?.eq;
      if (!eqState) return;

      const band = eqState.bands[activeEQBand];
      if (band) {
        band.type = filterType;
        
        // Se mudarmos para HPF ou LPF, resetamos o ganho da banda para 0dB (MIDI 64)
        if (filterType === 'hpf' || filterType === 'lpf') {
          band.gain = 64;
          
          sendWSMessage({
            type: 'eq',
            target: selectedTarget,
            channel: selectedChannel,
            band: activeEQBand,
            param: 'gain',
            value: 64
          });
        }

        sendWSMessage({
          type: 'eq',
          target: selectedTarget,
          channel: selectedChannel,
          band: activeEQBand,
          param: 'type',
          value: filterType
        });

        updateEQDrawerUI();
      }
    });
  });

  // Evento do botão de Reset de EQ
  const resetBtn = document.getElementById('eq-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const eqState = mixerState[selectedTarget][selectedChannel]?.eq;
      if (!eqState) return;

      // Valores padrão do equalizador de 4 bandas da Yamaha 01V96:
      const defaultBands = {
        1: { q: 64, freq: 27, gain: 64, type: 'peaking' },  // ~80Hz
        2: { q: 64, freq: 56, gain: 64, type: 'peaking' },  // ~400Hz
        3: { q: 64, freq: 85, gain: 64, type: 'peaking' },  // ~2.0kHz
        4: { q: 64, freq: 110, gain: 64, type: 'peaking' }  // ~8.0kHz
      };

      for (let b = 1; b <= 4; b++) {
        const band = eqState.bands[b];
        if (band) {
          band.q = defaultBands[b].q;
          band.freq = defaultBands[b].freq;
          band.gain = defaultBands[b].gain;
          band.type = defaultBands[b].type;

          sendWSMessage({ type: 'eq', target: selectedTarget, channel: selectedChannel, band: b, param: 'q', value: band.q });
          sendWSMessage({ type: 'eq', target: selectedTarget, channel: selectedChannel, band: b, param: 'freq', value: band.freq });
          sendWSMessage({ type: 'eq', target: selectedTarget, channel: selectedChannel, band: b, param: 'gain', value: band.gain });
          sendWSMessage({ type: 'eq', target: selectedTarget, channel: selectedChannel, band: b, param: 'type', value: band.type });
        }
      }

      updateEQDrawerUI();
      updateSlotsMapping();
    });
  }
}

function initGateControls(canvas) {
  const sliderThresh = document.getElementById('gate-slider-threshold');
  const sliderRange = document.getElementById('gate-slider-range');
  const sliderAttack = document.getElementById('gate-slider-attack');
  const sliderHold = document.getElementById('gate-slider-hold');
  const sliderDecay = document.getElementById('gate-slider-decay');
  const bypassBtn = document.getElementById('gate-bypass-btn');

  // Sliders
  sliderThresh.addEventListener('input', (e) => updateGateParameter('threshold', parseInt(e.target.value)));
  sliderRange.addEventListener('input', (e) => updateGateParameter('range', parseInt(e.target.value)));
  sliderAttack.addEventListener('input', (e) => updateGateParameter('attack', parseInt(e.target.value)));
  sliderHold.addEventListener('input', (e) => updateGateParameter('hold', parseInt(e.target.value)));
  sliderDecay.addEventListener('input', (e) => updateGateParameter('decay', parseInt(e.target.value)));

  // Bypass
  bypassBtn.addEventListener('click', () => {
    const chState = mixerState[selectedTarget][selectedChannel];
    if (!chState || !chState.gate) return;
    const newVal = chState.gate.on === 1 ? 0 : 1;
    chState.gate.on = newVal;

    sendWSMessage({
      type: 'gate',
      target: selectedTarget,
      channel: selectedChannel,
      param: 'on',
      value: newVal
    });

    updateSlotsMapping();
    updateGatePaneUI();
  });

  // Canvas Mouse Events
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    
    const gateState = mixerState[selectedTarget][selectedChannel].gate;
    if (!gateState) return;

    const threshDB = DYN_MATH.midiToGateThreshold(gateState.threshold);
    const nodeX = dbToX(canvas, threshDB);
    const nodeY = dbToY(canvas, threshDB);

    const dx = x - nodeX;
    const dy = y - nodeY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 20 * window.devicePixelRatio) {
      draggingGateThreshold = true;
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    
    const gateState = mixerState[selectedTarget][selectedChannel].gate;
    if (!gateState) return;

    if (draggingGateThreshold) {
      // Arrastar ao longo da diagonal X=Y
      // Vamos obter a coordenada de dB do X
      let db = xToDb(canvas, x);
      db = Math.max(-80, Math.min(-30, db)); // Limites de Threshold
      const valMIDI = DYN_MATH.gateThresholdToMidi(db);
      
      updateGateParameter('threshold', valMIDI);
      showGateTooltip(e.clientX, e.clientY, db);
    } else {
      const threshDB = DYN_MATH.midiToGateThreshold(gateState.threshold);
      const nodeX = dbToX(canvas, threshDB);
      const nodeY = dbToY(canvas, threshDB);

      const dx = x - nodeX;
      const dy = y - nodeY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 15 * window.devicePixelRatio) {
        canvas.style.cursor = 'grab';
        showGateTooltip(e.clientX, e.clientY, threshDB);
      } else {
        canvas.style.cursor = 'default';
        hideGateTooltip();
      }
    }
  });

  const stopDragging = () => {
    draggingGateThreshold = false;
    hideGateTooltip();
  };

  canvas.addEventListener('mouseup', stopDragging);
  canvas.addEventListener('mouseleave', stopDragging);

  // Eventos de toque (Touch Screen) para o Canvas de Gate
  canvas.addEventListener('touchstart', (e) => {
    const pos = getTouchPos(canvas, e);
    if (!pos) return;
    e.preventDefault();

    const x = pos.x;
    const y = pos.y;
    
    const gateState = mixerState[selectedTarget][selectedChannel].gate;
    if (!gateState) return;

    const threshDB = DYN_MATH.midiToGateThreshold(gateState.threshold);
    const nodeX = dbToX(canvas, threshDB);
    const nodeY = dbToY(canvas, threshDB);

    const dx = x - nodeX;
    const dy = y - nodeY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 25 * window.devicePixelRatio) {
      draggingGateThreshold = true;
      showGateTooltip(pos.clientX, pos.clientY, threshDB);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!draggingGateThreshold) return;
    const pos = getTouchPos(canvas, e);
    if (!pos) return;
    e.preventDefault();

    const x = pos.x;
    
    const gateState = mixerState[selectedTarget][selectedChannel].gate;
    if (!gateState) return;

    let db = xToDb(canvas, x);
    db = Math.max(-80, Math.min(-30, db));
    const valMIDI = DYN_MATH.gateThresholdToMidi(db);
    
    updateGateParameter('threshold', valMIDI);
    showGateTooltip(pos.clientX, pos.clientY, db);
  }, { passive: false });

  const stopTouchDraggingGate = () => {
    draggingGateThreshold = false;
    hideGateTooltip();
  };
  canvas.addEventListener('touchend', stopTouchDraggingGate);
  canvas.addEventListener('touchcancel', stopTouchDraggingGate);
}

function initCompControls(canvas) {
  const sliderThresh = document.getElementById('comp-slider-threshold');
  const sliderRatio = document.getElementById('comp-slider-ratio');
  const sliderKnee = document.getElementById('comp-slider-knee');
  const sliderAttack = document.getElementById('comp-slider-attack');
  const sliderRelease = document.getElementById('comp-slider-release');
  const sliderGain = document.getElementById('comp-slider-outgain');
  const bypassBtn = document.getElementById('comp-bypass-btn');

  // Sliders
  sliderThresh.addEventListener('input', (e) => updateCompParameter('threshold', parseInt(e.target.value)));
  sliderRatio.addEventListener('input', (e) => updateCompParameter('ratio', parseInt(e.target.value)));
  sliderKnee.addEventListener('input', (e) => updateCompParameter('knee', parseInt(e.target.value)));
  sliderAttack.addEventListener('input', (e) => updateCompParameter('attack', parseInt(e.target.value)));
  sliderRelease.addEventListener('input', (e) => updateCompParameter('release', parseInt(e.target.value)));
  sliderGain.addEventListener('input', (e) => updateCompParameter('outgain', parseInt(e.target.value)));

  // Bypass
  bypassBtn.addEventListener('click', () => {
    const chState = mixerState[selectedTarget][selectedChannel];
    if (!chState || !chState.comp) return;
    const newVal = chState.comp.on === 1 ? 0 : 1;
    chState.comp.on = newVal;

    sendWSMessage({
      type: 'comp',
      target: selectedTarget,
      channel: selectedChannel,
      param: 'on',
      value: newVal
    });

    updateSlotsMapping();
    updateCompPaneUI();
  });

  // Canvas Mouse Events
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    
    const compState = mixerState[selectedTarget][selectedChannel].comp;
    if (!compState) return;

    const threshDB = DYN_MATH.midiToCompThreshold(compState.threshold);
    const ratio = DYN_MATH.midiToRatio(compState.ratio);

    // Nó de Threshold (na diagonal)
    const tx = dbToX(canvas, threshDB);
    const ty = dbToY(canvas, threshDB);
    const distThresh = Math.sqrt((x - tx)*(x - tx) + (y - ty)*(y - ty));

    // Nó de Ratio (na borda direita, X = 0dB)
    const rx = dbToX(canvas, 0);
    const ry = dbToY(canvas, compressSignal(0, threshDB, ratio, compState.knee));
    const distRatio = Math.sqrt((x - rx)*(x - rx) + (y - ry)*(y - ry));

    const scale = window.devicePixelRatio;
    if (distThresh < 20 * scale) {
      draggingCompThreshold = true;
      canvas.style.cursor = 'grabbing';
    } else if (distRatio < 20 * scale) {
      draggingCompRatio = true;
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    
    const compState = mixerState[selectedTarget][selectedChannel].comp;
    if (!compState) return;

    const threshDB = DYN_MATH.midiToCompThreshold(compState.threshold);
    const ratio = DYN_MATH.midiToRatio(compState.ratio);
    const scale = window.devicePixelRatio;

    if (draggingCompThreshold) {
      let db = xToDb(canvas, x);
      db = Math.max(-54, Math.min(0, db));
      const valMIDI = DYN_MATH.compThresholdToMidi(db);
      updateCompParameter('threshold', valMIDI);
      showCompTooltip(e.clientX, e.clientY, 'threshold', db);
    } else if (draggingCompRatio) {
      // Arrastar verticalmente para alterar o Ratio (altera Y da saída em X=0)
      const outDB = yToDb(canvas, y);
      // Formula: Y = Thresh + (0 - Thresh) / Ratio  => Ratio = -Thresh / (Y - Thresh)
      const diff = outDB - threshDB;
      let newRatio = 1.0;
      if (diff > 0.1) {
        newRatio = -threshDB / diff;
      } else if (diff <= 0) {
        newRatio = Infinity;
      }
      newRatio = Math.max(1.0, Math.min(20.0, newRatio)); // Limita entre 1.0 e 20.0
      
      const valMIDI = DYN_MATH.ratioToMidi(newRatio);
      updateCompParameter('ratio', valMIDI);
      showCompTooltip(e.clientX, e.clientY, 'ratio', newRatio);
    } else {
      // Hover checks
      const tx = dbToX(canvas, threshDB);
      const ty = dbToY(canvas, threshDB);
      const distThresh = Math.sqrt((x - tx)*(x - tx) + (y - ty)*(y - ty));

      const rx = dbToX(canvas, 0);
      const ry = dbToY(canvas, compressSignal(0, threshDB, ratio, compState.knee));
      const distRatio = Math.sqrt((x - rx)*(x - rx) + (y - ry)*(y - ry));

      if (distThresh < 15 * scale) {
        canvas.style.cursor = 'grab';
        showCompTooltip(e.clientX, e.clientY, 'threshold', threshDB);
      } else if (distRatio < 15 * scale) {
        canvas.style.cursor = 'grab';
        showCompTooltip(e.clientX, e.clientY, 'ratio', ratio);
      } else {
        canvas.style.cursor = 'default';
        hideCompTooltip();
      }
    }
  });

  const stopDragging = () => {
    draggingCompThreshold = false;
    draggingCompRatio = false;
    hideCompTooltip();
  };

  canvas.addEventListener('mouseup', stopDragging);
  canvas.addEventListener('mouseleave', stopDragging);

  // Eventos de toque (Touch Screen) para o Canvas de Compressor
  canvas.addEventListener('touchstart', (e) => {
    const pos = getTouchPos(canvas, e);
    if (!pos) return;
    e.preventDefault();

    const x = pos.x;
    const y = pos.y;
    
    const compState = mixerState[selectedTarget][selectedChannel].comp;
    if (!compState) return;

    const threshDB = DYN_MATH.midiToCompThreshold(compState.threshold);
    const ratio = DYN_MATH.midiToRatio(compState.ratio);

    const tx = dbToX(canvas, threshDB);
    const ty = dbToY(canvas, threshDB);
    const distThresh = Math.sqrt((x - tx)*(x - tx) + (y - ty)*(y - ty));

    const rx = dbToX(canvas, 0);
    const ry = dbToY(canvas, compressSignal(0, threshDB, ratio, compState.knee));
    const distRatio = Math.sqrt((x - rx)*(x - rx) + (y - ry)*(y - ry));

    const scale = window.devicePixelRatio;
    if (distThresh < 25 * scale) {
      draggingCompThreshold = true;
      showCompTooltip(pos.clientX, pos.clientY, 'threshold', threshDB);
    } else if (distRatio < 25 * scale) {
      draggingCompRatio = true;
      showCompTooltip(pos.clientX, pos.clientY, 'ratio', ratio);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!draggingCompThreshold && !draggingCompRatio) return;
    const pos = getTouchPos(canvas, e);
    if (!pos) return;
    e.preventDefault();

    const x = pos.x;
    const y = pos.y;
    
    const compState = mixerState[selectedTarget][selectedChannel].comp;
    if (!compState) return;

    const threshDB = DYN_MATH.midiToCompThreshold(compState.threshold);

    if (draggingCompThreshold) {
      let db = xToDb(canvas, x);
      db = Math.max(-54, Math.min(0, db));
      const valMIDI = DYN_MATH.compThresholdToMidi(db);
      updateCompParameter('threshold', valMIDI);
      showCompTooltip(pos.clientX, pos.clientY, 'threshold', db);
    } else if (draggingCompRatio) {
      const outDB = yToDb(canvas, y);
      const diff = outDB - threshDB;
      let newRatio = 1.0;
      if (diff > 0.1) {
        newRatio = -threshDB / diff;
      } else if (diff <= 0) {
        newRatio = Infinity;
      }
      newRatio = Math.max(1.0, Math.min(20.0, newRatio));
      
      const valMIDI = DYN_MATH.ratioToMidi(newRatio);
      updateCompParameter('ratio', valMIDI);
      showCompTooltip(pos.clientX, pos.clientY, 'ratio', newRatio);
    }
  }, { passive: false });

  const stopTouchDraggingComp = () => {
    draggingCompThreshold = false;
    draggingCompRatio = false;
    hideCompTooltip();
  };
  canvas.addEventListener('touchend', stopTouchDraggingComp);
  canvas.addEventListener('touchcancel', stopTouchDraggingComp);
}

function updateGateParameter(param, midiValue) {
  const gateState = mixerState[selectedTarget][selectedChannel].gate;
  if (!gateState) return;

  gateState[param] = midiValue;

  sendWSMessage({
    type: 'gate',
    target: selectedTarget,
    channel: selectedChannel,
    param: param,
    value: midiValue
  });

  updateGatePaneUI();
}

function updateCompParameter(param, midiValue) {
  const compState = mixerState[selectedTarget][selectedChannel].comp;
  if (!compState) return;

  compState[param] = midiValue;

  sendWSMessage({
    type: 'comp',
    target: selectedTarget,
    channel: selectedChannel,
    param: param,
    value: midiValue
  });

  updateCompPaneUI();
}

function toggleChannelControlDrawer(target, channel, initialTab = 'eq', fromNetwork = false) {
  if (target !== 'input' && target !== 'master' && target !== 'aux' && target !== 'fxreturn') return;

  const drawer = document.getElementById('channel-control-drawer');
  if (!drawer) return;

  const isSameChannel = selectedChannel === channel && selectedTarget === target;
  const isSameTab = activeTab === initialTab;
  const isDrawerOpen = drawer.style.display !== 'none';

  if (isDrawerOpen && isSameChannel && isSameTab) {
    drawer.style.display = 'none';
    updateLayoutVisibility();
    if (!fromNetwork) {
      sendWSMessage({
        type: 'navigate',
        action: 'drawer',
        open: false
      });
    }
  } else {
    selectedTarget = target;
    selectedChannel = channel;
    activeTab = initialTab;
    drawer.style.display = 'block';
    updateLayoutVisibility();
    updateChannelControlDrawerUI();

    updateLCD();

    // Sincroniza aba ativa no HTML
    document.querySelectorAll('.drawer-tab').forEach(t => {
      t.classList.remove('active');
      if (t.getAttribute('data-tab') === initialTab) {
        t.classList.add('active');
      }
    });

    // Exibe o painel correto
    document.querySelectorAll('.drawer-pane').forEach(p => p.style.display = 'none');
    document.getElementById('drawer-eq-section').style.display = 'none';
    if (initialTab === 'rta') {
      document.getElementById('pane-rta').style.display = 'flex';
      document.getElementById('drawer-eq-section').style.display = '';
    } else {
      document.getElementById(`pane-${initialTab}`).style.display = 'grid';
    }

    // Redesenhar Canvas Ativo
    setTimeout(() => {
      if (initialTab === 'rta') {
        RTAModule.resizeCanvas();
        RTAModule.openPanel();
      } else {
        RTAModule.stop();
        const canvasMap = {
          eq: document.getElementById('eq-canvas'),
          gate: document.getElementById('gate-canvas'),
          comp: document.getElementById('comp-canvas')
        };
        const canvas = canvasMap[initialTab];
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          canvas.width = rect.width * window.devicePixelRatio;
          canvas.height = rect.height * window.devicePixelRatio;
        }
      }
      updateChannelControlDrawerUI();
      updateLayoutVisibility();
    }, 50);

    if (!fromNetwork) {
      sendWSMessage({
        type: 'navigate',
        action: 'drawer',
        open: true,
        target,
        channel,
        tab: initialTab
      });
    }
  }
}

function updateLayoutVisibility() {
  const drawer = document.getElementById('channel-control-drawer');
  const container = document.querySelector('.app-container');
  if (!container) return;

  if (drawer && drawer.style.display !== 'none') {
    container.classList.add('drawer-open');
  } else {
    container.classList.remove('drawer-open');
  }
}

function buildDrawerChannelNav() {
  const list = document.getElementById('drawer-nav-list');
  if (!list) return;
  list.innerHTML = '';

  for (let i = 1; i <= 32; i++) {
    const btn = document.createElement('button');
    btn.className = 'drawer-nav-btn';
    btn.dataset.target = 'input';
    btn.dataset.channel = i;
    const color = (channelColors.input && channelColors.input[i]) || '#000000';
    btn.innerHTML = `<span class="drawer-nav-num">${i}</span><span class="drawer-nav-name">${mixerState?.input?.[i]?.name || `INPUT ${i}`}</span>`;
    if (color !== '#000000') {
      btn.style.borderColor = color;
      btn.style.background = hexToRgba(color, 0.18);
    }
    btn.addEventListener('click', () => selectChannel('input', i));
    list.appendChild(btn);
  }
}

function updateChannelControlDrawerUI() {
  if (selectedTarget === 'master') {
    document.getElementById('drawer-channel-num').textContent = 'MST';
    const masterState = mixerState.master[1];
    document.getElementById('drawer-channel-name').textContent = masterState ? masterState.name : 'STEREO MASTER';
  } else {
    document.getElementById('drawer-channel-num').textContent = String(selectedChannel).padStart(2, '0');
    document.getElementById('drawer-channel-name').textContent = mixerState[selectedTarget][selectedChannel].name;
  }

  // Visibilidade da aba RTA (só Master/Aux)
  const rtaTab = document.getElementById('tab-drawer-rta');
  if (rtaTab) {
    const showRta = selectedTarget === 'master' || selectedTarget === 'aux';
    rtaTab.style.display = showRta ? '' : 'none';
    if (activeTab === 'rta' && !showRta) {
      activeTab = 'eq';
      document.querySelectorAll('.drawer-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-drawer-eq')?.classList.add('active');
      document.querySelectorAll('.drawer-pane').forEach(p => p.style.display = 'none');
      document.getElementById('drawer-eq-section').style.display = 'none';
      document.getElementById('pane-eq').style.display = 'grid';
      RTAModule.stop();
    }
  }

  // Atualiza nomes, cores e botão ativo na navegação
  const navContainer = document.getElementById('drawer-channel-nav');
  if (navContainer) {
    navContainer.style.display = selectedTarget !== 'input' ? 'none' : '';
  }
  const activeNavBtn = document.querySelector(`.drawer-nav-btn[data-target="${selectedTarget}"][data-channel="${selectedChannel}"]`);
  document.querySelectorAll('.drawer-nav-btn').forEach(b => {
    b.classList.remove('active');
    const isActive = b === activeNavBtn;
    const nameEl = b.querySelector('.drawer-nav-name');
    if (nameEl && b.dataset.target === 'input') {
      const ch = parseInt(b.dataset.channel);
      nameEl.textContent = mixerState?.input?.[ch]?.name || `INPUT ${ch}`;
      const color = (channelColors.input && channelColors.input[ch]) || '#000000';
      if (color !== '#000000' && !isActive) {
        b.style.borderColor = color;
        b.style.background = hexToRgba(color, 0.18);
      } else {
        b.style.borderColor = '';
        b.style.background = '';
      }
    }
  });
  if (activeNavBtn) activeNavBtn.classList.add('active');

  if (activeTab === 'eq') updateEQDrawerUI();
  else if (activeTab === 'gate') updateGatePaneUI();
  else if (activeTab === 'comp') updateCompPaneUI();
  else if (activeTab === 'fx') updateFXDrawerUI();
}

function updateEQDrawerUI() {
  const eqState = mixerState[selectedTarget][selectedChannel]?.eq;
  if (!eqState) return;

  const bypassBtn = document.getElementById('eq-bypass-btn');
  const bypassLed = document.getElementById('eq-bypass-led');
  const sliderGain = document.getElementById('eq-slider-gain');
  const sliderFreq = document.getElementById('eq-slider-freq');
  const sliderQ = document.getElementById('eq-slider-q');
  
  const valGain = document.getElementById('eq-val-gain');
  const valFreq = document.getElementById('eq-val-freq');
  const valQ = document.getElementById('eq-val-q');

  if (eqState.on === 1) {
    bypassBtn?.classList.add('active');
    bypassLed?.classList.add('active');
  } else {
    bypassBtn?.classList.remove('active');
    bypassLed?.classList.remove('active');
  }

  const band = eqState.bands[activeEQBand];
  if (band) {
    const filterType = band.type || 'peaking';
    
    // Habilita/Desabilita o seletor de ganho na interface
    const gainGroup = document.getElementById('eq-slider-gain')?.closest('.eq-param-group');
    if (gainGroup) {
      if (filterType === 'hpf' || filterType === 'lpf') {
        gainGroup.classList.add('disabled');
        if (sliderGain) sliderGain.disabled = true;
      } else {
        gainGroup.classList.remove('disabled');
        if (sliderGain) sliderGain.disabled = false;
      }
    }

    if (sliderGain) sliderGain.value = band.gain;
    if (sliderFreq) sliderFreq.value = band.freq;
    if (sliderQ) sliderQ.value = band.q;

    const db = EQ_MATH.midiToGain(band.gain);
    const hz = EQ_MATH.midiToFreq(band.freq);
    const qVal = EQ_MATH.midiToQ(band.q);

    if (valGain) {
      if (filterType === 'hpf' || filterType === 'lpf') {
        valGain.textContent = '--- dB (Cortado)';
      } else {
        valGain.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
      }
    }
    if (valFreq) valFreq.textContent = hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz} Hz`;
    if (valQ) valQ.textContent = qVal.toFixed(2);

    // Configura o seletor de tipo de filtro
    const filterRow = document.getElementById('eq-filter-type-row');
    if (filterRow) {
      if (activeEQBand === 1 || activeEQBand === 4) {
        filterRow.style.display = 'flex';
        
        const btnHPF = document.getElementById('btn-filter-hpf');
        const btnLPF = document.getElementById('btn-filter-lpf');
        
        if (activeEQBand === 1) {
          if (btnHPF) btnHPF.style.display = 'block';
          if (btnLPF) btnLPF.style.display = 'none';
        } else {
          if (btnHPF) btnHPF.style.display = 'none';
          if (btnLPF) btnLPF.style.display = 'block';
        }
        
        // Define qual botão está ativo
        document.querySelectorAll('.filter-type-btn').forEach(btn => {
          btn.classList.remove('active');
          if (btn.getAttribute('data-type') === filterType) {
            btn.classList.add('active');
          }
        });
      } else {
        filterRow.style.display = 'none'; // Bandas L-MID e H-MID são sempre peaking
      }
    }
  }

  drawEQCurve();
}

function updateEQParameter(param, midiValue) {
  const eqState = mixerState[selectedTarget][selectedChannel].eq;
  if (!eqState) return;

  eqState.bands[activeEQBand][param] = midiValue;

  sendWSMessage({
    type: 'eq',
    target: selectedTarget,
    channel: selectedChannel,
    band: activeEQBand,
    param: param,
    value: midiValue
  });

  updateEQDrawerUI();
}

function drawEQCurve() {
  const canvas = document.getElementById('eq-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const scale = window.devicePixelRatio;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#090d14';
  ctx.fillRect(0, 0, w, h);

  // Linhas horizontais (Ganho dB)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.font = `${8 * scale}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';

  const gains = [18, 12, 6, 0, -6, -12, -18];
  gains.forEach(g => {
    const y = gainToY(canvas, g);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    if (g !== -18) {
      ctx.fillText(`${g >= 0 ? '+' : ''}${g}dB`, 10 * scale, y - 4 * scale);
    }
  });

  // Linhas verticais (Freq logarítmica)
  const freqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  freqs.forEach(f => {
    const x = freqToX(canvas, f);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    let label = f >= 1000 ? `${f / 1000}k` : `${f}`;
    ctx.save();
    ctx.translate(x + 4 * scale, h - 8 * scale);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });

  // Desenhar a curva combinada (soma das bandas)
  const points = [];
  const resolution = 200;
  const eqState = mixerState[selectedTarget][selectedChannel].eq;
  
  if (eqState) {
    for (let i = 0; i <= resolution; i++) {
      const x = (i / resolution) * w;
      const freq = xToFreq(canvas, x);
      let totalGainDB = 0;

      if (eqState.on === 1) {
        for (let b = 1; b <= 4; b++) {
          const band = eqState.bands[b];
          if (band) {
            const G = EQ_MATH.midiToGain(band.gain);
            const f0 = EQ_MATH.midiToFreq(band.freq);
            const Q = EQ_MATH.midiToQ(band.q);
            const type = band.type || 'peaking';

            if (type === 'peaking') {
              const logRatio = Math.log(freq / f0);
              const sigma = 1.0 / (Q * Math.LN2);
              const exponent = - (logRatio * logRatio) / (2.0 * sigma * sigma);
              totalGainDB += G * Math.exp(exponent);
            } else if (type === 'hpf' && b === 1) {
              // HPF 2ª ordem
              const r = freq / f0;
              if (r < 0.001) {
                totalGainDB += -45;
              } else {
                const r2 = r * r;
                const d = (1 - r2) * (1 - r2) + (r / Q) * (r / Q);
                const amp = r2 / Math.sqrt(d);
                let gain = 20 * Math.log10(amp);
                if (gain < -45) gain = -45;
                totalGainDB += gain;
              }
            } else if (type === 'lpf' && b === 4) {
              // LPF 2ª ordem
              const r = freq / f0;
              const r2 = r * r;
              const d = (1 - r2) * (1 - r2) + (r / Q) * (r / Q);
              const amp = 1.0 / Math.sqrt(d);
              let gain = 20 * Math.log10(amp);
              if (gain < -45) gain = -45;
              totalGainDB += gain;
            } else if (type === 'shelving') {
              // Shelving aproximado
              const logRatio = Math.log(freq / f0);
              if (b === 1) {
                // Low Shelf
                const t = 1.0 / (1.0 + Math.exp(Q * logRatio));
                totalGainDB += G * t;
              } else if (b === 4) {
                // High Shelf
                const t = 1.0 / (1.0 + Math.exp(-Q * logRatio));
                totalGainDB += G * t;
              }
            }
          }
        }
      }
      
      const y = gainToY(canvas, totalGainDB);
      points.push({ x, y });
    }
  }

  // Linha da curva
  if (points.length > 0) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    
    ctx.strokeStyle = eqState && eqState.on === 1 ? '#10b981' : '#64748b';
    ctx.lineWidth = 3.5 * scale;
    ctx.shadowBlur = eqState && eqState.on === 1 ? 8 * scale : 0;
    ctx.shadowColor = '#10b981';
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Desenhar os nós interativos
  if (eqState) {
    for (let b = 1; b <= 4; b++) {
      const coords = getEQPointCoords(canvas, b);
      const color = getBandColor(b);
      const isSelected = b === activeEQBand;
      const isDragging = b === draggingBand;
      const size = (isSelected ? 10 : 7) * scale;

      ctx.beginPath();
      ctx.arc(coords.x, coords.y, size + (isDragging ? 4 : 2) * scale, 0, 2 * Math.PI);
      ctx.fillStyle = isSelected ? `${color}44` : 'rgba(255, 255, 255, 0.08)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(coords.x, coords.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * scale;
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${8 * scale}px 'Outfit', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(getBandName(b), coords.x, coords.y + 0.5 * scale);
    }
  }
}

function getEQPointCoords(canvas, band) {
  const eqState = mixerState[selectedTarget][selectedChannel].eq;
  if (!eqState) return { x: 0, y: 0 };

  const b = eqState.bands[band];
  if (!b) return { x: 0, y: 0 };

  const freq = EQ_MATH.midiToFreq(b.freq);
  const type = b.type || 'peaking';
  const gain = (type === 'hpf' || type === 'lpf') ? 0 : EQ_MATH.midiToGain(b.gain);

  return {
    x: freqToX(canvas, freq),
    y: gainToY(canvas, gain)
  };
}

function getBandColor(band) {
  switch (band) {
    case 1: return '#3b82f6';
    case 2: return '#10b981';
    case 3: return '#f59e0b';
    case 4: return '#ef4444';
    default: return '#94a3b8';
  }
}

function getBandName(band) {
  switch (band) {
    case 1: return 'L';
    case 2: return 'LM';
    case 3: return 'HM';
    case 4: return 'H';
    default: return '';
  }
}

function getBandFullName(band) {
  switch (band) {
    case 1: return 'LOW';
    case 2: return 'LOW-MID';
    case 3: return 'HIGH-MID';
    case 4: return 'HIGH';
    default: return '';
  }
}

function showEQTooltip(clientX, clientY, band) {
  const tooltip = document.getElementById('eq-tooltip');
  if (!tooltip) return;

  const bandState = mixerState[selectedTarget][selectedChannel].eq.bands[band];
  if (!bandState) return;

  const freq = EQ_MATH.midiToFreq(bandState.freq);
  const gain = EQ_MATH.midiToGain(bandState.gain);
  const qVal = EQ_MATH.midiToQ(bandState.q);

  const freqStr = freq >= 1000 ? `${(freq / 1000).toFixed(2)} kHz` : `${freq} Hz`;
  const gainStr = `${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`;

  tooltip.innerHTML = `
    <strong>${getBandFullName(band)}</strong><br>
    Freq: ${freqStr}<br>
    Gain: ${gainStr}<br>
    Q: ${qVal.toFixed(2)}
  `;

  tooltip.style.left = `${clientX + 15}px`;
  tooltip.style.top = `${clientY - 40}px`;
  tooltip.style.display = 'block';
}

function hideEQTooltip() {
  const tooltip = document.getElementById('eq-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

function freqToX(canvas, freq) {
  return canvas.width * Math.log(freq / 20) / Math.log(1000);
}

function xToFreq(canvas, x) {
  return 20 * Math.pow(1000, x / canvas.width);
}

function gainToY(canvas, gain) {
  const halfH = canvas.height / 2;
  return halfH * (1 - gain / 18);
}

function yToGain(canvas, y) {
  const halfH = canvas.height / 2;
  return 18 * (1 - y / halfH);
}

// -------------------------------------------------------------
// SISTEMA DE DINÂMICA: GATE E COMPRESSOR
// -------------------------------------------------------------

function compressSignal(inputDB, thresholdDB, ratio, knee) {
  if (inputDB < thresholdDB) {
    if (knee === 1) {
      const kneeWidth = 8;
      if (inputDB > thresholdDB - kneeWidth) {
        const t = (inputDB - (thresholdDB - kneeWidth)) / (2 * kneeWidth); // 0..1
        const gainRed = (1 - 1/ratio) * (inputDB - thresholdDB + kneeWidth) * t * t * 0.5;
        return inputDB - gainRed;
      }
    }
    return inputDB;
  } else {
    if (knee === 1) {
      const kneeWidth = 8;
      if (inputDB < thresholdDB + kneeWidth) {
        const t = (inputDB - (thresholdDB - kneeWidth)) / (2 * kneeWidth); // 0..1
        const gainRed = (1 - 1/ratio) * (inputDB - thresholdDB + kneeWidth) * t * t * 0.5;
        return inputDB - gainRed;
      }
    }
    return thresholdDB + (inputDB - thresholdDB) / ratio;
  }
}

function updateGatePaneUI() {
  const gateState = mixerState[selectedTarget][selectedChannel]?.gate;
  if (!gateState) return;

  const sliderThresh = document.getElementById('gate-slider-threshold');
  const sliderRange = document.getElementById('gate-slider-range');
  const sliderAttack = document.getElementById('gate-slider-attack');
  const sliderHold = document.getElementById('gate-slider-hold');
  const sliderDecay = document.getElementById('gate-slider-decay');
  const bypassBtn = document.getElementById('gate-bypass-btn');
  const bypassLed = document.getElementById('gate-bypass-led');

  const valThresh = document.getElementById('gate-val-threshold');
  const valRange = document.getElementById('gate-val-range');
  const valAttack = document.getElementById('gate-val-attack');
  const valHold = document.getElementById('gate-val-hold');
  const valDecay = document.getElementById('gate-val-decay');

  sliderThresh.value = gateState.threshold;
  sliderRange.value = gateState.range;
  sliderAttack.value = gateState.attack;
  sliderHold.value = gateState.hold;
  sliderDecay.value = gateState.decay;

  const dbThresh = DYN_MATH.midiToGateThreshold(gateState.threshold);
  const dbRange = DYN_MATH.midiToGateRange(gateState.range);
  const msAttack = DYN_MATH.midiToAttack(gateState.attack);
  const msHold = DYN_MATH.midiToHold(gateState.hold);
  const msDecay = DYN_MATH.midiToDecay(gateState.decay);

  valThresh.textContent = `${dbThresh} dB`;
  valRange.textContent = `${dbRange} dB`;
  valAttack.textContent = `${msAttack} ms`;
  valHold.textContent = msHold >= 1000 ? `${(msHold / 1000).toFixed(2)} s` : `${msHold} ms`;
  valDecay.textContent = msDecay >= 1000 ? `${(msDecay / 1000).toFixed(2)} s` : `${msDecay} ms`;

  if (gateState.on === 1) {
    bypassBtn.classList.add('active');
    bypassLed.classList.add('active');
  } else {
    bypassBtn.classList.remove('active');
    bypassLed.classList.remove('active');
  }

  drawGateCurve();
}

function updateCompPaneUI() {
  const compState = mixerState[selectedTarget][selectedChannel]?.comp;
  if (!compState) return;

  const sliderThresh = document.getElementById('comp-slider-threshold');
  const sliderRatio = document.getElementById('comp-slider-ratio');
  const sliderKnee = document.getElementById('comp-slider-knee');
  const sliderAttack = document.getElementById('comp-slider-attack');
  const sliderRelease = document.getElementById('comp-slider-release');
  const sliderGain = document.getElementById('comp-slider-outgain');
  const bypassBtn = document.getElementById('comp-bypass-btn');
  const bypassLed = document.getElementById('comp-bypass-led');

  const valThresh = document.getElementById('comp-val-threshold');
  const valRatio = document.getElementById('comp-val-ratio');
  const valKnee = document.getElementById('comp-val-knee');
  const valAttack = document.getElementById('comp-val-attack');
  const valRelease = document.getElementById('comp-val-release');
  const valGain = document.getElementById('comp-val-outgain');

  sliderThresh.value = compState.threshold;
  sliderRatio.value = compState.ratio;
  sliderKnee.value = compState.knee;
  sliderAttack.value = compState.attack;
  sliderRelease.value = compState.release;
  sliderGain.value = compState.outgain;

  const dbThresh = DYN_MATH.midiToCompThreshold(compState.threshold);
  const ratio = DYN_MATH.midiToRatio(compState.ratio);
  const kneeText = compState.knee === 1 ? 'SOFT' : 'HARD';
  const msAttack = DYN_MATH.midiToAttack(compState.attack);
  const msRelease = DYN_MATH.midiToDecay(compState.release);
  const dbGain = DYN_MATH.midiToOutGain(compState.outgain);

  valThresh.textContent = `${dbThresh} dB`;
  valRatio.textContent = ratio === Infinity ? 'LIMIT' : `${ratio}:1`;
  valKnee.textContent = kneeText;
  valAttack.textContent = `${msAttack} ms`;
  valRelease.textContent = msRelease >= 1000 ? `${(msRelease / 1000).toFixed(2)} s` : `${msRelease} ms`;
  valGain.textContent = `${dbGain >= 0 ? '+' : ''}${dbGain.toFixed(1)} dB`;

  if (compState.on === 1) {
    bypassBtn.classList.add('active');
    bypassLed.classList.add('active');
  } else {
    bypassBtn.classList.remove('active');
    bypassLed.classList.remove('active');
  }

  drawCompCurve();
}

function drawGateCurve() {
  const canvas = document.getElementById('gate-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const scale = window.devicePixelRatio;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#090d14';
  ctx.fillRect(0, 0, w, h);

  // Linhas da grade e texto
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1 * scale;
  ctx.font = `${8 * scale}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';

  const dbs = [0, -10, -20, -30, -40, -50, -60, -70, -80];
  dbs.forEach(db => {
    // Linha horizontal
    const y = dbToY(canvas, db);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(`${db}dB`, 5 * scale, y - 3 * scale);

    // Linha vertical
    const x = dbToX(canvas, db);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (db !== -80) {
      ctx.fillText(`${db}dB`, x + 3 * scale, h - 5 * scale);
    }
  });

  const gateState = mixerState[selectedTarget][selectedChannel]?.gate;
  if (!gateState) return;

  const threshDB = DYN_MATH.midiToGateThreshold(gateState.threshold);
  const rangeDB = DYN_MATH.midiToGateRange(gateState.range);

  // Curva de Transferência
  const points = [];
  const startDB = -80;
  const endDB = 0;
  const resolution = 160;

  for (let i = 0; i <= resolution; i++) {
    const inDB = startDB + (i / resolution) * (endDB - startDB);
    let outDB = inDB;
    if (gateState.on === 1) {
      if (inDB < threshDB) {
        outDB = inDB + rangeDB;
      }
    }
    outDB = Math.max(-80, outDB);
    points.push({ x: dbToX(canvas, inDB), y: dbToY(canvas, outDB) });
  }

  // Desenhar curva
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = gateState.on === 1 ? '#f59e0b' : '#64748b';
  ctx.lineWidth = 3 * scale;
  ctx.shadowBlur = gateState.on === 1 ? 6 * scale : 0;
  ctx.shadowColor = '#f59e0b';
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Desenhar Nó de Threshold
  if (gateState.on === 1) {
    const nx = dbToX(canvas, threshDB);
    const ny = dbToY(canvas, threshDB);
    const isDragging = draggingGateThreshold;

    ctx.beginPath();
    ctx.arc(nx, ny, 8 * scale + (isDragging ? 3 : 0) * scale, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(nx, ny, 5 * scale, 0, 2 * Math.PI);
    ctx.fillStyle = '#f59e0b';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * scale;
    ctx.fill();
    ctx.stroke();
  }
}

function drawCompCurve() {
  const canvas = document.getElementById('comp-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const scale = window.devicePixelRatio;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#090d14';
  ctx.fillRect(0, 0, w, h);

  // Linhas da grade e texto
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1 * scale;
  ctx.font = `${8 * scale}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';

  const dbs = [0, -10, -20, -30, -40, -50, -60, -70, -80];
  dbs.forEach(db => {
    // Linha horizontal
    const y = dbToY(canvas, db);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(`${db}dB`, 5 * scale, y - 3 * scale);

    // Linha vertical
    const x = dbToX(canvas, db);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (db !== -80) {
      ctx.fillText(`${db}dB`, x + 3 * scale, h - 5 * scale);
    }
  });

  const compState = mixerState[selectedTarget][selectedChannel]?.comp;
  if (!compState) return;

  const threshDB = DYN_MATH.midiToCompThreshold(compState.threshold);
  const ratio = DYN_MATH.midiToRatio(compState.ratio);

  // 1. Linha diagonal de referência 1:1
  ctx.beginPath();
  ctx.setLineDash([4 * scale, 4 * scale]);
  ctx.moveTo(dbToX(canvas, -80), dbToY(canvas, -80));
  ctx.lineTo(dbToX(canvas, 0), dbToY(canvas, 0));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1 * scale;
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. Curva de Compressão
  const points = [];
  const resolution = 160;
  for (let i = 0; i <= resolution; i++) {
    const inDB = -80 + (i / resolution) * 80;
    let outDB = inDB;
    if (compState.on === 1) {
      outDB = compressSignal(inDB, threshDB, ratio, compState.knee);
    }
    points.push({ x: dbToX(canvas, inDB), y: dbToY(canvas, outDB) });
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = compState.on === 1 ? '#ef4444' : '#64748b';
  ctx.lineWidth = 3 * scale;
  ctx.shadowBlur = compState.on === 1 ? 6 * scale : 0;
  ctx.shadowColor = '#ef4444';
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 3. Desenhar Nós
  if (compState.on === 1) {
    // Nó de Threshold
    const tx = dbToX(canvas, threshDB);
    const ty = dbToY(canvas, threshDB);
    const isDraggingT = draggingCompThreshold;

    ctx.beginPath();
    ctx.arc(tx, ty, 8 * scale + (isDraggingT ? 3 : 0) * scale, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(tx, ty, 5 * scale, 0, 2 * Math.PI);
    ctx.fillStyle = '#ef4444';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * scale;
    ctx.fill();
    ctx.stroke();

    // Nó de Ratio (a X=0dB)
    const rx = dbToX(canvas, 0);
    const ry = dbToY(canvas, compressSignal(0, threshDB, ratio, compState.knee));
    const isDraggingR = draggingCompRatio;

    ctx.beginPath();
    ctx.arc(rx, ry, 8 * scale + (isDraggingR ? 3 : 0) * scale, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(rx, ry, 5 * scale, 0, 2 * Math.PI);
    ctx.fillStyle = '#ef4444';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * scale;
    ctx.fill();
    ctx.stroke();
  }
}

function showGateTooltip(clientX, clientY, threshDB) {
  const tooltip = document.getElementById('gate-tooltip');
  if (!tooltip) return;
  tooltip.innerHTML = `<strong>GATE THRESHOLD</strong><br>Limiar: ${threshDB} dB`;
  tooltip.style.left = `${clientX + 15}px`;
  tooltip.style.top = `${clientY - 40}px`;
  tooltip.style.display = 'block';
}

function hideGateTooltip() {
  const tooltip = document.getElementById('gate-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

function showCompTooltip(clientX, clientY, type, value) {
  const tooltip = document.getElementById('comp-tooltip');
  if (!tooltip) return;
  if (type === 'threshold') {
    tooltip.innerHTML = `<strong>COMP THRESHOLD</strong><br>Limiar: ${value} dB`;
  } else {
    tooltip.innerHTML = `<strong>COMP RATIO</strong><br>Razão: ${value === Infinity ? 'LIMIT' : value + ':1'}`;
  }
  tooltip.style.left = `${clientX + 15}px`;
  tooltip.style.top = `${clientY - 40}px`;
  tooltip.style.display = 'block';
}

function hideCompTooltip() {
  const tooltip = document.getElementById('comp-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

// -------------------------------------------------------------
// PAINEL DE EFEITOS (FX1, FX2)
// -------------------------------------------------------------

let activeFXProcessor = 1;
let activeFxRtn = 1;

function updateFXDrawerUI() {
  const fxState = mixerState.fx[activeFXProcessor];
  if (!fxState) return;

  // Seletor de processador
  document.querySelectorAll('.fx-sel-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.getAttribute('data-fx')) === activeFXProcessor);
  });

  // Bypass
  const bypassBtn = document.getElementById('fx-bypass-btn');
  const bypassLed = document.getElementById('fx-bypass-led');
  if (fxState.on === 1) {
    bypassBtn?.classList.remove('active');
    bypassLed?.classList.remove('active');
  } else {
    bypassBtn?.classList.add('active');
    bypassLed?.classList.add('active');
  }

  // Tipo de efeito
  const typeSelect = document.getElementById('fx-type-select');
  if (typeSelect) typeSelect.value = fxState.type;

  // Parâmetros
  renderFXParams(fxState);

  // Mix
  const mixSlider = document.getElementById('fx-slider-mix');
  const mixVal = document.getElementById('fx-val-mix');
  if (mixSlider) mixSlider.value = fxState.mix;
  if (mixVal) mixVal.textContent = Math.round((fxState.mix / 127) * 100) + '%';

  // Retornos FX
  ['1', '2'].forEach(n => {
    const rtn = mixerState.fxreturn[n];
    if (!rtn) return;
    const slider = document.getElementById(`fxreturn-fader-${n}`);
    const val = document.getElementById(`fxreturn-val-${n}`);
    if (slider) slider.value = rtn.fader;
    if (val) val.textContent = faderToDB(rtn.fader);
  });

  // Roteamento dos retornos
  updateFxRtnRoutingUI();
}

function updateFxRtnRoutingUI() {
  const rtn = mixerState.fxreturn[activeFxRtn];
  if (!rtn) return;

  // Aba ativa
  document.querySelectorAll('.fx-rtn-tab').forEach(t => {
    t.classList.toggle('active', parseInt(t.getAttribute('data-rtn')) === activeFxRtn);
  });

  // Toggles de roteamento
  const routing = rtn.busRouting || { lr: true };
  ['lr', '1', '2', '3', '4', '5', '6', '7', '8'].forEach(b => {
    const cb = document.getElementById(`fx-rtn-bus-${b}`);
    if (cb) cb.checked = routing[b] === true;
  });
}

function renderFXParams(fxState) {
  const grid = document.getElementById('fx-params-grid');
  if (!grid) return;

  // Mapa de nomes de parâmetros por tipo
  const paramNames = {
    reverb: { decay: 'DECAY', preDelay: 'PRÉ-DELAY', damping: 'DAMPING', diffusion: 'DIFUSÃO' },
    delay: { time: 'TEMPO', feedback: 'FEEDBACK', hpf: 'HPF', lpf: 'LPF' },
    chorus: { rate: 'RATE', depth: 'PROFUND.', delay: 'DELAY', feedback: 'FEEDBACK' },
    flanger: { rate: 'RATE', depth: 'PROFUND.', delay: 'DELAY', feedback: 'FEEDBACK' },
    phaser: { rate: 'RATE', depth: 'PROFUND.', feedback: 'FEEDBACK', stages: 'ESTÁGIOS' },
    tremolo: { rate: 'RATE', depth: 'PROFUND.', shape: 'FORMA' },
    rotary: { speed: 'VELOCIDADE', drive: 'DRIVE' },
    distortion: { drive: 'DRIVE', tone: 'TOM', master: 'MASTER' }
  };

  const type = fxState.type;
  const params = paramNames[type] || paramNames.reverb;
  const paramKeys = Object.keys(params);

  let html = '';
  paramKeys.forEach(key => {
    const valMid = fxState[key] !== undefined ? fxState[key] : 64;
    let displayVal = valMid;
    // Formatação específica
    if (key === 'decay') displayVal = (valMid / 127 * 20).toFixed(1) + 's';
    else if (key === 'preDelay') displayVal = Math.round(valMid / 127 * 250) + 'ms';
    else if (key === 'time') displayVal = Math.round(valMid / 127 * 1000) + 'ms';
    else if (key === 'feedback' || key === 'mix') displayVal = Math.round((valMid / 127) * 100) + '%';
    else if (key === 'damping' || key === 'diffusion') displayVal = Math.round((valMid / 127) * 100) + '%';
    else if (key === 'hpf') displayVal = Math.round(valMid / 127 * 20000) + 'Hz';
    else if (key === 'lpf') displayVal = Math.round(valMid / 127 * 20000) + 'Hz';
    else if (key === 'depth' || key === 'rate') displayVal = Math.round((valMid / 127) * 100) + '%';
    else if (key === 'drive' || key === 'master') displayVal = Math.round((valMid / 127) * 100) + '%';
    else if (key === 'tone') displayVal = Math.round((valMid / 127) * 100) + '%';
    else if (key === 'stages') displayVal = Math.max(2, Math.round(valMid / 127 * 10 + 2));
    else if (key === 'speed') displayVal = valMid < 64 ? 'LENTO' : 'RÁPIDO';
    else if (key === 'shape') displayVal = valMid < 64 ? 'SENOIDAL' : 'TRIANGULAR';

    html += `
      <div class="fx-param-item" data-param="${key}">
        <label for="fx-slider-${key}">${params[key]}</label>
        <div class="fx-slider-wrapper">
          <input type="range" class="fx-slider" id="fx-slider-${key}" min="0" max="127" value="${valMid}">
          <span class="fx-param-val" id="fx-val-${key}">${displayVal}</span>
        </div>
      </div>
    `;
  });

  grid.innerHTML = html;

  // Conecta eventos dos sliders de parâmetro
  grid.querySelectorAll('.fx-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const param = e.target.closest('.fx-param-item')?.getAttribute('data-param');
      if (!param) return;
      const val = parseInt(e.target.value);
      const fxState = mixerState.fx[activeFXProcessor];
      if (!fxState) return;
      fxState[param] = val;
      renderFXParams(fxState);
      sendWSMessage({ type: 'fx', processor: activeFXProcessor, param, value: val });
    });
  });
}

function setupFXEvents() {
  // Seletor de processador FX1/FX2
  document.querySelectorAll('.fx-sel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFXProcessor = parseInt(btn.getAttribute('data-fx'));
      updateFXDrawerUI();
    });
  });

  // Seletor de tipo de efeito
  const typeSelect = document.getElementById('fx-type-select');
  if (typeSelect) {
    typeSelect.addEventListener('change', (e) => {
      const newType = e.target.value;
      const current = mixerState.fx[activeFXProcessor];
      if (!current) return;
      const oldMix = current.mix;
      const oldOn = current.on;
      mixerState.fx[activeFXProcessor] = createDefaultFXParams(newType);
      mixerState.fx[activeFXProcessor].mix = oldMix;
      mixerState.fx[activeFXProcessor].on = oldOn;
      updateFXDrawerUI();
      sendWSMessage({ type: 'fx_type', processor: activeFXProcessor, value: newType });
    });
  }

  // Bypass
  const bypassBtn = document.getElementById('fx-bypass-btn');
  if (bypassBtn) {
    bypassBtn.addEventListener('click', () => {
      const current = mixerState.fx[activeFXProcessor];
      if (!current) return;
      current.on = current.on === 1 ? 0 : 1;
      updateFXDrawerUI();
      sendWSMessage({ type: 'fx', processor: activeFXProcessor, param: 'on', value: current.on });
    });
  }

  // Mix slider
  const mixSlider = document.getElementById('fx-slider-mix');
  if (mixSlider) {
    mixSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const current = mixerState.fx[activeFXProcessor];
      if (!current) return;
      current.mix = val;
      updateFXDrawerUI();
      sendWSMessage({ type: 'fx', processor: activeFXProcessor, param: 'mix', value: val });
    });
  }

  // FX Return faders
  ['1', '2'].forEach(n => {
    const slider = document.getElementById(`fxreturn-fader-${n}`);
    if (slider) {
      slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        const rtn = mixerState.fxreturn[n];
        if (!rtn) return;
        rtn.fader = val;
        const valEl = document.getElementById(`fxreturn-val-${n}`);
        if (valEl) valEl.textContent = faderToDB(val);
        sendWSMessage({ type: 'fader', target: 'fxreturn', channel: parseInt(n), value: val });
      });
    }
  });

  // Abas de roteamento FX Return
  document.querySelectorAll('.fx-rtn-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeFxRtn = parseInt(tab.getAttribute('data-rtn'));
      updateFxRtnRoutingUI();
    });
  });

  // Toggles de roteamento dos retornos FX
  document.querySelectorAll('#fx-rtn-bus-grid .bus-toggle').forEach(toggle => {
    const cb = toggle.querySelector('input[type="checkbox"]');
    if (!cb) return;
    cb.addEventListener('change', () => {
      const bus = toggle.getAttribute('data-bus');
      const checked = cb.checked;
      const rtn = mixerState.fxreturn[activeFxRtn];
      if (!rtn || !rtn.busRouting) return;
      rtn.busRouting[bus] = checked;
      sendWSMessage({ type: 'routing_bus', target: 'fxreturn', channel: activeFxRtn, bus, value: checked });
    });
  });
}

// Converte valor MIDI 0-1023 para dB
function faderToDB(val) {
  if (val === 0) return '-oo dB';
  const dB = (val / 1023) * 20 - 20;
  return (dB >= 0 ? '+' : '') + dB.toFixed(1) + ' dB';
}

// -------------------------------------------------------------
// GERENCIADOR DE CENAS DO SISTEMA
// -------------------------------------------------------------

/**
 * Renderiza o grid de cartões de cena da biblioteca (0 a 99)
 */
function renderScenesList() {
  const container = document.getElementById('scenes-grid-list');
  if (!container) return;

  container.innerHTML = '';

  // Cria cards para as cenas 0 a 99
  for (let slot = 0; slot <= 99; slot++) {
    const scene = scenesList[slot] || { slot, name: '', empty: true };
    const card = document.createElement('div');
    card.className = `scene-card${activeSceneSlot === slot ? ' active' : ''}`;
    
    // Formata a data se existir
    let timeStr = '';
    if (scene.timestamp) {
      const date = new Date(scene.timestamp);
      timeStr = date.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    card.innerHTML = `
      <div class="scene-card-header">
        <span class="scene-number">SCENE ${String(slot).padStart(2, '0')}</span>
        <span class="scene-status-led">${scene.empty ? 'Vazia' : (scene.protected ? 'Sistema' : 'Ativa')}</span>
      </div>
      <div class="scene-card-body">
        <input type="text" class="scene-name-input" id="scene-name-${slot}" 
          value="${scene.empty ? '' : scene.name}" 
          placeholder="${scene.empty ? 'Vazia (Clique em Store)' : 'Sem Nome'}"
          ${scene.protected || (!scene.empty && activeSceneSlot !== slot) ? 'disabled' : ''}>
        ${timeStr ? `<span class="scene-time">${timeStr}</span>` : ''}
      </div>
      <div class="scene-card-actions">
        <button class="scene-btn scene-btn-recall" id="btn-recall-${slot}" ${scene.empty ? 'disabled' : ''} title="Carregar Cena">
          <i class="fa-solid fa-folder-open"></i> Recall
        </button>
        <button class="scene-btn scene-btn-store" id="btn-store-${slot}" ${scene.protected ? 'disabled' : ''} title="${scene.protected ? 'Cena protegida' : 'Salvar Estado Atual'}">
          <i class="fa-solid fa-floppy-disk"></i> Store
        </button>
        <button class="scene-btn scene-btn-delete" id="btn-delete-${slot}" ${scene.empty || scene.protected ? 'disabled' : ''} title="Apagar Cena">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;

    container.appendChild(card);

    // Eventos
    const nameInput = card.querySelector(`#scene-name-${slot}`);
    const btnRecall = card.querySelector(`#btn-recall-${slot}`);
    const btnStore = card.querySelector(`#btn-store-${slot}`);
    const btnDelete = card.querySelector(`#btn-delete-${slot}`);

    // Recall
    btnRecall.addEventListener('click', () => {
      recallScene(slot);
    });

    // Store (Salvar)
    btnStore.addEventListener('click', () => {
      if (scene.protected) return;
      let name = nameInput.value.trim();
      if (!name) {
        name = prompt(`Digite um nome para a Cena ${slot}:`, `Cena ${slot}`);
        if (name === null) return; // Cancelado
        name = name.trim() || `Cena ${slot}`;
      }
      storeScene(slot, name);
    });

    // Delete (Limpar)
    btnDelete.addEventListener('click', () => {
      if (scene.protected) return;
      if (confirm(`Tem certeza de que deseja apagar a Cena ${slot}?`)) {
        deleteScene(slot);
      }
    });

    // Permitir renomear apenas clicando duas vezes no input se já estiver salvo e não for protegido
    if (!scene.empty && !scene.protected) {
      nameInput.addEventListener('dblclick', () => {
        nameInput.removeAttribute('disabled');
        nameInput.focus();
        nameInput.select();
      });

      nameInput.addEventListener('change', () => {
        const newName = nameInput.value.trim();
        if (newName) {
          storeScene(slot, newName);
        }
      });

      nameInput.addEventListener('blur', () => {
        nameInput.setAttribute('disabled', 'true');
      });
    }
  }
}

/**
 * Envia comando de recall de cena para o servidor
 */
function recallScene(slot) {
  console.log(`[SCENE-FRONT] Recalling Scene ${slot}`);
  sendWSMessage({
    type: 'load_scene',
    slot: parseInt(slot)
  });
}

/**
 * Envia comando para salvar o estado atual como cena
 */
function storeScene(slot, name) {
  console.log(`[SCENE-FRONT] Storing Current State in Scene ${slot} as "${name}"`);
  sendWSMessage({
    type: 'save_scene',
    slot: parseInt(slot),
    name: name
  });
}

/**
 * Envia comando para excluir cena
 */
/**
 * Envia comando para excluir cena
 */
function deleteScene(slot) {
  console.log(`[SCENE-FRONT] Deleting Scene ${slot}`);
  sendWSMessage({
    type: 'delete_scene',
    slot: parseInt(slot)
  });
}

// =============================================================
// GERENCIADOR DE CORES, TEMAS E CONFIGURAÇÃO
// =============================================================

function applyChannelColor(slot, color) {
  const ctrl = stripControls[slot];
  if (!ctrl) return;
  
  if (ctrl.colorBadge) {
    ctrl.colorBadge.style.backgroundColor = color;
  }
  
  ctrl.stripElement.style.borderTopColor = color;
  
  const rgba = hexToRgba(color, 0.12);
  ctrl.stripElement.style.backgroundColor = rgba;
  
  const groove = ctrl.stripElement.querySelector('.fader-groove-line');
  if (groove) {
    groove.style.borderLeftColor = color;
    groove.style.borderRightColor = color;
    groove.style.boxShadow = `0 0 8px ${color}`;
  }
}

function applyMasterColor(color) {
  const master = masterControls;
  if (!master) return;
  
  if (master.colorBadge) {
    master.colorBadge.style.backgroundColor = color;
  }
  
  master.stripElement.style.borderTopColor = color;
  const rgba = hexToRgba(color, 0.12);
  master.stripElement.style.backgroundColor = rgba;
  
  const groove = master.stripElement.querySelector('.fader-groove-line');
  if (groove) {
    groove.style.borderLeftColor = color;
    groove.style.borderRightColor = color;
    groove.style.boxShadow = `0 0 8px ${color}`;
  }
}

function hexToRgba(hex, alpha) {
  let c = hex.substring(1);
  if (c.length === 3) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyGlobalTheme(color) {
  document.documentElement.style.setProperty('--text-active', color);
  
  const themeInput = document.getElementById('global-theme-color');
  if (themeInput) {
    themeInput.value = color;
  }
  const themeHex = document.getElementById('global-theme-color-hex');
  if (themeHex) {
    themeHex.textContent = color.toUpperCase();
  }
  
  localStorage.setItem(localGlobalThemeKey, color);
}

function getLayerDefaultColors() {
  const saved = localStorage.getItem(localLayerColorsKey);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (e) {}
  }
  return {
    input: document.getElementById('color-layer-input')?.value || '#3b82f6',
    bus: document.getElementById('color-layer-bus')?.value || '#a855f7',
    aux: document.getElementById('color-layer-aux')?.value || '#06b6d4'
  };
}

function saveLayerDefaultColors() {
  const colors = {
    input: document.getElementById('color-layer-input').value,
    bus: document.getElementById('color-layer-bus').value,
    aux: document.getElementById('color-layer-aux').value
  };
  localStorage.setItem(localLayerColorsKey, JSON.stringify(colors));
  updateSlotsMapping();
}

function loadChannelColors() {
  try {
    const saved = localStorage.getItem(localChannelColorsKey);
    if (saved) {
      channelColors = JSON.parse(saved);
    } else {
      channelColors = {
        input: {},
        aux: {},
        bus: {},
        master: {}
      };
    }
  } catch (e) {
    channelColors = {
      input: {},
      aux: {},
      bus: {},
      master: {}
    };
  }
}

function loadGlobalTheme() {
  const saved = localStorage.getItem(localGlobalThemeKey) || '#3b82f6';
  applyGlobalTheme(saved);
}

function loadLayerColors() {
  const saved = localStorage.getItem(localLayerColorsKey);
  if (saved) {
    try {
      const colors = JSON.parse(saved);
      if (colors.input && document.getElementById('color-layer-input')) {
        document.getElementById('color-layer-input').value = colors.input;
      }
      if (colors.bus && document.getElementById('color-layer-bus')) {
        document.getElementById('color-layer-bus').value = colors.bus;
      }
      if (colors.aux && document.getElementById('color-layer-aux')) {
        document.getElementById('color-layer-aux').value = colors.aux;
      }
    } catch (e) {}
  }
}

// -------------------------------------------------------------
// MIDI SETTINGS
// -------------------------------------------------------------

function setupMIDISettingsEvents() {
  const connectBtn = document.getElementById('midi-btn-connect');
  const disconnectBtn = document.getElementById('midi-btn-disconnect');
  const refreshBtn = document.getElementById('midi-btn-refresh');
  const inputSelect = document.getElementById('midi-input-select');
  const outputSelect = document.getElementById('midi-output-select');

  if (connectBtn) {
    connectBtn.addEventListener('click', () => {
      const inputPort = inputSelect.value;
      const outputPort = outputSelect.value;
      if (inputPort && outputPort) {
        connectBtn.disabled = true;
        connectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Conectando...';
        sendWSMessage({ type: 'connect_midi', inputPort, outputPort });
      }
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => {
      sendWSMessage({ type: 'disconnect_midi' });
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshBtn.querySelector('i').classList.add('fa-spin');
      requestMIDIPorts();
      setTimeout(() => refreshBtn.querySelector('i').classList.remove('fa-spin'), 800);
    });
  }
}

function requestMIDIPorts() {
  sendWSMessage({ type: 'list_midi' });
}

function updateMIDISettingsUI(data) {
  const { ports, connected, activeInputPort, activeOutputPort, midiStatus } = data;
  const inputSelect = document.getElementById('midi-input-select');
  const outputSelect = document.getElementById('midi-output-select');
  const connectBtn = document.getElementById('midi-btn-connect');
  const disconnectBtn = document.getElementById('midi-btn-disconnect');
  const statusDot = document.getElementById('midi-settings-dot');
  const statusText = document.getElementById('midi-settings-status');
  const infoIn = document.getElementById('midi-info-in');
  const infoOut = document.getElementById('midi-info-out');

  if (!inputSelect || !outputSelect) return;

  // Salva seleção atual
  const prevInputVal = inputSelect.value;
  const prevOutputVal = outputSelect.value;

  // Atualiza dropdown de entrada
  inputSelect.innerHTML = '<option value="">— Selecione uma porta —</option>';
  if (ports && ports.inputs && ports.inputs.length > 0) {
    ports.inputs.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === activeInputPort) opt.selected = true;
      inputSelect.appendChild(opt);
    });
    inputSelect.disabled = connected ? true : false;
  } else {
    inputSelect.innerHTML = '<option value="">— Nenhuma porta encontrada —</option>';
    inputSelect.disabled = true;
  }

  // Atualiza dropdown de saída
  outputSelect.innerHTML = '<option value="">— Selecione uma porta —</option>';
  if (ports && ports.outputs && ports.outputs.length > 0) {
    ports.outputs.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === activeOutputPort) opt.selected = true;
      outputSelect.appendChild(opt);
    });
    outputSelect.disabled = connected ? true : false;
  } else {
    outputSelect.innerHTML = '<option value="">— Nenhuma porta encontrada —</option>';
    outputSelect.disabled = true;
  }

  // Status
  if (connected) {
    statusDot.className = 'midi-status-dot connected';
    statusText.textContent = 'Conectado';
    statusText.style.color = 'var(--led-green)';
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    if (infoIn) infoIn.textContent = activeInputPort || '—';
    if (infoOut) infoOut.textContent = activeOutputPort || '—';
  } else {
    statusDot.className = 'midi-status-dot disconnected';
    statusText.textContent = midiStatus && midiStatus.toLowerCase().includes('demo') ? 'Modo Demonstração' : 'Desconectado';
    statusText.style.color = 'var(--text-muted)';
    connectBtn.disabled = !(inputSelect.value && outputSelect.value);
    disconnectBtn.disabled = true;
    if (infoIn) infoIn.textContent = '—';
    if (infoOut) infoOut.textContent = '—';
  }

  // Habilita connect se ambas as portas estiverem selecionadas
  if (!connected) {
    connectBtn.disabled = !(inputSelect.value && outputSelect.value);
  }
}

function updateMIDIStatusFromMain(status) {
  const statusDot = document.getElementById('midi-settings-dot');
  const statusText = document.getElementById('midi-settings-status');
  if (!statusDot || !statusText) return;

  if (status.toLowerCase().includes('connected to')) {
    statusDot.className = 'midi-status-dot connected';
    statusText.textContent = 'Conectado';
    statusText.style.color = 'var(--led-green)';
  } else if (status.toLowerCase().includes('disconnected') || status.toLowerCase().includes('demo')) {
    statusDot.className = 'midi-status-dot disconnected';
    statusText.textContent = status.toLowerCase().includes('demo') ? 'Modo Demonstração' : 'Desconectado';
    statusText.style.color = 'var(--text-muted)';
  } else {
    statusDot.className = 'midi-status-dot connecting';
    statusText.textContent = 'Conectando...';
    statusText.style.color = 'var(--led-yellow)';
  }
}

function setupCustomizationEvents() {
  const themeInput = document.getElementById('global-theme-color');
  if (themeInput) {
    themeInput.addEventListener('input', (e) => {
      applyGlobalTheme(e.target.value);
    });
  }

  const presetBtns = document.querySelectorAll('.preset-theme-btn');
  presetBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const color = e.target.getAttribute('data-color');
      applyGlobalTheme(color);
    });
  });

  const layerInput = document.getElementById('color-layer-input');
  const layerBus = document.getElementById('color-layer-bus');
  const layerAux = document.getElementById('color-layer-aux');

  if (layerInput) layerInput.addEventListener('input', saveLayerDefaultColors);
  if (layerBus) layerBus.addEventListener('input', saveLayerDefaultColors);
  if (layerAux) layerAux.addEventListener('input', saveLayerDefaultColors);

  const resetBtn = document.getElementById('btn-reset-theme');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Deseja realmente restaurar todos os padrões de cores e temas de fábrica?')) {
        resetToFactoryDefaults();
      }
    });
  }
}

function resetToFactoryDefaults() {
  localStorage.removeItem(localChannelColorsKey);
  localStorage.removeItem(localGlobalThemeKey);
  localStorage.removeItem(localLayerColorsKey);
  
  channelColors = {
    input: {},
    aux: {},
    bus: {},
    master: {}
  };
  
  const defaultLayerColors = {
    input: '#3b82f6',
    bus: '#a855f7',
    aux: '#06b6d4'
  };
  
  const layerInput = document.getElementById('color-layer-input');
  const layerBus = document.getElementById('color-layer-bus');
  const layerAux = document.getElementById('color-layer-aux');
  
  if (layerInput) layerInput.value = defaultLayerColors.input;
  if (layerBus) layerBus.value = defaultLayerColors.bus;
  if (layerAux) layerAux.value = defaultLayerColors.aux;
  
  applyGlobalTheme('#3b82f6');
  updateSlotsMapping();
}

async function loadNetworkInfo() {
  const listEl = document.getElementById('network-ips-list');
  if (!listEl) return;
  
  try {
    const res = await fetch('/api/network');
    const data = await res.json();
    
    let html = `<li><i class="fa-solid fa-desktop"></i> http://localhost:${data.port} (Local)</li>`;
    if (data.ips && data.ips.length > 0) {
      data.ips.forEach(ip => {
        html += `<li><i class="fa-solid fa-network-wired"></i> http://${ip}:${data.port} (Rede Local)</li>`;
      });
    } else {
      html += `<li class="text-muted"><i class="fa-solid fa-triangle-exclamation"></i> Nenhum outro IP de rede detectado.</li>`;
    }
    listEl.innerHTML = html;
  } catch (err) {
    console.error('Erro ao buscar IPs locais:', err);
    listEl.innerHTML = `
      <li><i class="fa-solid fa-desktop"></i> http://localhost:3000 (Local)</li>
      <li class="text-danger"><i class="fa-solid fa-circle-exclamation"></i> Erro ao consultar IPs do servidor.</li>
    `;
  }
}

function setupAuxNamesEvents() {
  const auxInputs = document.querySelectorAll('.aux-name-input');
  auxInputs.forEach(input => {
    input.addEventListener('change', (e) => {
      const auxIdx = parseInt(e.target.getAttribute('data-aux'));
      const newName = e.target.value.trim() || `AUX ${auxIdx}`;
      
      // 1. Atualiza no mixerState
      mixerState.aux[auxIdx].name = newName;
      
      // 2. Salva localmente
      saveChannelNames();
      
      // 3. Atualiza interface e LCD
      updateSlotsMapping();
      updateLCD();
      
      // Sincroniza o valor tratado de volta no input
      e.target.value = newName;

      sendWSMessage({
        type: 'rename',
        target: 'aux',
        channel: auxIdx,
        name: newName
      });

      // Atualiza labels dos botões AUX na página home
      updateAuxButtonLabels();
    });
  });
}

// -------------------------------------------------------------
// EDITOR DE CANAL (nome, cor e roteamento para buses)
// -------------------------------------------------------------

let editorTarget = null;
let editorChannel = null;

function openChannelEditor(target, channel) {
  const state = mixerState[target] && mixerState[target][channel];
  if (!state) return;

  editorTarget = target;
  editorChannel = channel;

  const overlay = document.getElementById('channel-editor-overlay');
  const nameInput = document.getElementById('editor-channel-name');
  const colorInput = document.getElementById('editor-channel-color');
  const colorHex = document.getElementById('editor-color-hex');

  nameInput.value = state.name || '';

  const currentColor = (channelColors[target] && channelColors[target][channel]) || '#000000';
  colorInput.value = currentColor;
  colorHex.textContent = currentColor.toUpperCase();

  // Preenche roteamento
  const routing = state.busRouting || { lr: true };
  ['lr', '1', '2', '3', '4', '5', '6', '7', '8'].forEach(b => {
    const cb = document.getElementById(`editor-bus-${b}`);
    if (cb) cb.checked = routing[b] === true;
  });

  // Mostra roteamento conforme tipo de canal
  const inputBusSection = document.getElementById('editor-bus-grid');
  const busStereoSection = document.getElementById('editor-bus-stereo-section');
  if (inputBusSection) inputBusSection.style.display = (target === 'input') ? 'grid' : 'none';
  if (busStereoSection) {
    busStereoSection.style.display = (target === 'bus') ? 'flex' : 'none';
    if (target === 'bus') {
      const cb = document.getElementById('editor-bus-stereo');
      if (cb) cb.checked = state.routeToStereo !== false;
    }
  }

  overlay.style.display = 'flex';
}

function closeChannelEditor() {
  const overlay = document.getElementById('channel-editor-overlay');
  overlay.style.display = 'none';
  editorTarget = null;
  editorChannel = null;
}

function saveChannelEditor() {
  const target = editorTarget;
  const channel = editorChannel;
  if (!target || !channel) return;

  const state = mixerState[target] && mixerState[target][channel];
  if (!state) return;

  const nameInput = document.getElementById('editor-channel-name');
  const colorInput = document.getElementById('editor-channel-color');

  // 1. Salva nome
  const newName = nameInput.value.trim() || state.name;
  if (newName !== state.name) {
    state.name = newName;
    saveChannelNames();
    sendWSMessage({ type: 'rename', target, channel, name: newName });
  }

  // 2. Salva cor
  const newColor = colorInput.value;
  const oldColor = (channelColors[target] && channelColors[target][channel]) || '#000000';
  if (newColor !== oldColor) {
    if (!channelColors[target]) channelColors[target] = {};
    channelColors[target][channel] = newColor;
    state.color = newColor;
    localStorage.setItem(localChannelColorsKey, JSON.stringify(channelColors));
    sendWSMessage({ type: 'color', target, channel, value: newColor });
  }

  // 3. Salva roteamento
  if (target === 'input' && state.busRouting) {
    const routing = state.busRouting;
    ['lr', '1', '2', '3', '4', '5', '6', '7', '8'].forEach(b => {
      const cb = document.getElementById(`editor-bus-${b}`);
      if (cb) {
        const newVal = cb.checked;
        if (routing[b] !== newVal) {
          routing[b] = newVal;
          sendWSMessage({ type: 'routing_bus', target, channel, bus: b, value: newVal });
        }
      }
    });
  } else if (target === 'bus') {
    const cb = document.getElementById('editor-bus-stereo');
    if (cb) {
      const newVal = cb.checked;
      if (state.routeToStereo !== newVal) {
        state.routeToStereo = newVal;
        sendWSMessage({ type: 'routing_bus', target, channel, bus: 'stereo', value: newVal });
      }
    }
  }

  // Atualiza interface
  for (let slot = 1; slot <= 16; slot++) {
    const ctrl = stripControls[slot];
    if (ctrl && ctrl.target === target && ctrl.channel === channel) {
      ctrl.nameInput.value = newName;
      const numText = ctrl.numLabel.textContent;
      updateChannelLabel(slot, numText, newName);
      applyChannelColor(slot, newColor);
      if (ctrl.colorPicker) ctrl.colorPicker.value = newColor;
      break;
    }
  }

  if (target === 'master' && channel === 1) {
    applyMasterColor(newColor);
    if (masterControls) masterControls.nameInput.value = newName;
  }

  if (target === 'aux') {
    updateAuxButtonColors();
    updateAuxButtonLabels();
    const inputEl = document.getElementById(`aux-name-${channel}`);
    if (inputEl) inputEl.value = newName;
  }

  updateLCD();
  closeChannelEditor();
}

function setupChannelEditorEvents() {
  const overlay = document.getElementById('channel-editor-overlay');

  document.getElementById('channel-editor-close').addEventListener('click', closeChannelEditor);
  document.getElementById('channel-editor-cancel').addEventListener('click', closeChannelEditor);
  document.getElementById('channel-editor-save').addEventListener('click', saveChannelEditor);

  // Fecha ao clicar fora do modal
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeChannelEditor();
  });

  // Fecha com Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display === 'flex') {
      closeChannelEditor();
    }
  });

  // Atualiza hex ao mudar cor
  document.getElementById('editor-channel-color').addEventListener('input', (e) => {
    document.getElementById('editor-color-hex').textContent = e.target.value.toUpperCase();
  });
}
