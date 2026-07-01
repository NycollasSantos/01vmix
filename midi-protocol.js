/**
 * Yamaha 01V96VCM MIDI Protocol Helper
 * 
 * Este arquivo contém funções para decodificar mensagens MIDI recebidas da mesa
 * e para codificar comandos enviados pelo navegador em mensagens MIDI (SysEx / CC).
 * 
 * Suporta camadas: inputs (1-32), aux (1-8), bus (1-8), master, auxsend e eq paramétrico.
 */

// Yamaha 01V96 SysEx Header
const SYSEX_HEADER = [0xF0, 0x43, 0x10, 0x3E, 0x0E];
const SYSEX_END = 0xF7;

// Address High Constants
const ADDR_HIGH_INPUT = 0x1A; // Bloco dos canais de entrada (1-32)
const ADDR_HIGH_MASTER = 0x1C; // Bloco do Master / Aux / Bus

// Address Low Constants
const ADDR_LOW_ON = 0x1B;     // Parâmetro ON/OFF (Mute)
const ADDR_LOW_FADER = 0x1C;  // Parâmetro Fader

/**
 * Decodifica uma mensagem MIDI recebida.
 * Retorna um objeto com a ação se for uma mensagem reconhecida da 01V96.
 * 
 * @param {Array|Buffer} bytes Bytes da mensagem MIDI recebida
 * @returns {Object|null} Objeto de evento { type, target, channel, value, ... }
 */
function decodeMIDIMessage(bytes) {
  if (!bytes || bytes.length === 0) return null;

  // 1. Verificar se é SysEx Parameter Change da 01V96
  if (bytes[0] === 0xF0) {
    const matchesHeader = SYSEX_HEADER.every((val, index) => bytes[index] === val);
    if (!matchesHeader) return null;

    const addrHigh = bytes[5];
    const addrMid = bytes[6];
    const addrLow = bytes[7];

    // Entrada de Canal Mono (Canais 1 a 32)
    if (addrHigh === ADDR_HIGH_INPUT && addrMid >= 0x00 && addrMid <= 0x1F) {
      const channel = addrMid + 1; // Canal 1 a 32

      // Equalizador Paramétrico (Address Low de 0x00 a 0x0C)
      if (addrLow >= 0x00 && addrLow <= 0x0C) {
        if (addrLow === 0x00) {
          // EQ ON/OFF
          return {
            type: 'eq',
            target: 'input',
            channel,
            band: 0,
            param: 'on',
            value: bytes[8] // 0 = OFF, 1 = ON
          };
        } else {
          // Bandas 1 a 4 (Low, L-Mid, H-Mid, High)
          const band = Math.floor((addrLow - 0x01) / 3) + 1;
          const paramOffset = (addrLow - 0x01) % 3;
          let param = '';
          if (paramOffset === 0) param = 'q';
          else if (paramOffset === 1) param = 'freq';
          else if (paramOffset === 2) param = 'gain';

          return {
            type: 'eq',
            target: 'input',
            channel,
            band,
            param,
            value: bytes[8] // 0..127
          };
        }
      }

      // Processadores de Dinâmica: Gate (0x10 a 0x15) e Compressor (0x16 a 0x1C)
      if (addrLow >= 0x10 && addrLow <= 0x1C) {
        if (addrLow >= 0x10 && addrLow <= 0x15) {
          // Dyn 1: Gate
          let param = '';
          if (addrLow === 0x10) param = 'on';
          else if (addrLow === 0x11) param = 'threshold';
          else if (addrLow === 0x12) param = 'range';
          else if (addrLow === 0x13) param = 'attack';
          else if (addrLow === 0x14) param = 'hold';
          else if (addrLow === 0x15) param = 'decay';
          
          return {
            type: 'gate',
            target: 'input',
            channel,
            param,
            value: bytes[8] // 0..127
          };
        } else {
          // Dyn 2: Compressor
          let param = '';
          if (addrLow === 0x16) param = 'on';
          else if (addrLow === 0x17) param = 'threshold';
          else if (addrLow === 0x18) param = 'ratio';
          else if (addrLow === 0x19) param = 'attack';
          else if (addrLow === 0x1A) param = 'outgain';
          else if (addrLow === 0x1B) param = 'release';
          else if (addrLow === 0x1C) param = 'knee';
          
          return {
            type: 'comp',
            target: 'input',
            channel,
            param,
            value: bytes[8] // 0..127
          };
        }
      }

      // Fader Principal (10-bit)
      if (addrLow === ADDR_LOW_FADER && bytes.length >= 11) {
        const msb = bytes[8];
        const lsb = bytes[9];
        const value = (msb << 7) | lsb;
        return { type: 'fader', target: 'input', channel, value };
      }

      // ON/OFF Principal (Mute)
      if (addrLow === ADDR_LOW_ON && bytes.length >= 10) {
        const value = bytes[8];
        return { type: 'mute', target: 'input', channel, value: value === 0 ? 1 : 0 };
      }

      // Aux Sends (Envios de auxiliares 1 a 8)
      if (addrLow >= 0x23 && addrLow <= 0x32) {
        if (addrLow % 2 === 1) {
          const auxIndex = Math.floor((addrLow - 0x23) / 2) + 1;
          const value = bytes[8];
          return {
            type: 'mute',
            target: 'auxsend',
            channel,
            auxIndex,
            value: value === 0 ? 1 : 0
          };
        } else {
          const auxIndex = Math.floor((addrLow - 0x24) / 2) + 1;
          if (bytes.length >= 11) {
            const msb = bytes[8];
            const lsb = bytes[9];
            const value = (msb << 7) | lsb;
            return {
              type: 'fader',
              target: 'auxsend',
              channel,
              auxIndex,
              value
            };
          }
        }
      }
    }

    // Bloco Master / Aux / Bus
    if (addrHigh === ADDR_HIGH_MASTER) {
      // Fader Master (Stereo Out L)
      if (addrMid === 0x00) {
        if (addrLow === ADDR_LOW_FADER && bytes.length >= 11) {
          const msb = bytes[8];
          const lsb = bytes[9];
          const value = (msb << 7) | lsb;
          return { type: 'fader', target: 'master', channel: 1, value };
        }
        if (addrLow === ADDR_LOW_ON && bytes.length >= 10) {
          const value = bytes[8];
          return { type: 'mute', target: 'master', channel: 1, value: value === 0 ? 1 : 0 };
        }
      }

      // Buses (1 a 8)
      if (addrMid >= 0x02 && addrMid <= 0x09) {
        const channel = addrMid - 1;
        if (addrLow === ADDR_LOW_FADER && bytes.length >= 11) {
          const msb = bytes[8];
          const lsb = bytes[9];
          const value = (msb << 7) | lsb;
          return { type: 'fader', target: 'bus', channel, value };
        }
        if (addrLow === ADDR_LOW_ON && bytes.length >= 10) {
          const value = bytes[8];
          return { type: 'mute', target: 'bus', channel, value: value === 0 ? 1 : 0 };
        }
      }

      // Auxiliares (1 a 8)
      if (addrMid >= 0x0A && addrMid <= 0x11) {
        const channel = addrMid - 9;
        if (addrLow === ADDR_LOW_FADER && bytes.length >= 11) {
          const msb = bytes[8];
          const lsb = bytes[9];
          const value = (msb << 7) | lsb;
          return { type: 'fader', target: 'aux', channel, value };
        }
        if (addrLow === ADDR_LOW_ON && bytes.length >= 10) {
          const value = bytes[8];
          return { type: 'mute', target: 'aux', channel, value: value === 0 ? 1 : 0 };
        }
      }
    }
  }

  // 2. Fallback: Suporte a Control Change (CC)
  if ((bytes[0] & 0xF0) === 0xB0) {
    const cc = bytes[1];
    const val = bytes[2];
    
    if (cc >= 1 && cc <= 16) {
      const scaleValue = Math.round((val / 127) * 1023);
      return { type: 'fader', target: 'input', channel: cc, value: scaleValue };
    }
    if (cc >= 17 && cc <= 32) {
      const scaleValue = Math.round((val / 127) * 1023);
      return { type: 'fader', target: 'input', channel: cc, value: scaleValue };
    }
    if (cc >= 33 && cc <= 40) {
      const scaleValue = Math.round((val / 127) * 1023);
      return { type: 'fader', target: 'bus', channel: cc - 32, value: scaleValue };
    }
    if (cc >= 41 && cc <= 48) {
      const scaleValue = Math.round((val / 127) * 1023);
      return { type: 'fader', target: 'aux', channel: cc - 40, value: scaleValue };
    }
    if (cc === 49) {
      const scaleValue = Math.round((val / 127) * 1023);
      return { type: 'fader', target: 'master', channel: 1, value: scaleValue };
    }

    // Mutes CC
    if (cc >= 51 && cc <= 66) {
      return { type: 'mute', target: 'input', channel: cc - 50, value: val < 64 ? 1 : 0 };
    }
    if (cc >= 67 && cc <= 82) {
      return { type: 'mute', target: 'input', channel: cc - 66 + 16, value: val < 64 ? 1 : 0 };
    }
    if (cc >= 83 && cc <= 90) {
      return { type: 'mute', target: 'bus', channel: cc - 82, value: val < 64 ? 1 : 0 };
    }
    if (cc >= 91 && cc <= 98) {
      return { type: 'mute', target: 'aux', channel: cc - 90, value: val < 64 ? 1 : 0 };
    }
    if (cc === 99) {
      return { type: 'mute', target: 'master', channel: 1, value: val < 64 ? 1 : 0 };
    }
  }

  return null;
}

/**
 * Codifica um comando do frontend em uma mensagem SysEx MIDI para a 01V96.
 * 
 * @param {string} type Tipo: 'fader', 'mute', 'eq'
 * @param {string} target Destino: 'input', 'aux', 'bus', 'master', 'auxsend'
 * @param {number} channel Canal da camada
 * @param {number} value Valor
 * @param {number} [auxIndex] Índice de Auxiliar para 'auxsend' (1..8)
 * @param {number} [band] Banda do equalizador (1..4)
 * @param {string} [param] Parâmetro do equalizador: 'q', 'freq', 'gain', 'on'
 * @returns {Array<number>} Bytes SysEx
 */
function encodeSysExMessage(type, target, channel, value, auxIndex, band, param) {
  let addrHigh = 0;
  let addrMid = 0;
  let addrLow = 0;
  let dataBytes = [];

  if (target === 'input') {
    if (channel < 1 || channel > 32) return [];
    addrHigh = ADDR_HIGH_INPUT;
    addrMid = channel - 1;
  } else if (target === 'bus') {
    if (channel < 1 || channel > 8) return [];
    addrHigh = ADDR_HIGH_MASTER;
    addrMid = channel + 1;
  } else if (target === 'aux') {
    if (channel < 1 || channel > 8) return [];
    addrHigh = ADDR_HIGH_MASTER;
    addrMid = channel + 9;
  } else if (target === 'master') {
    addrHigh = ADDR_HIGH_MASTER;
    addrMid = 0x00;
  } else if (target === 'auxsend') {
    if (channel < 1 || channel > 32) return [];
    if (!auxIndex || auxIndex < 1 || auxIndex > 8) return [];
    addrHigh = ADDR_HIGH_INPUT;
    addrMid = channel - 1;
  } else {
    return [];
  }

  if (type === 'fader') {
    if (target === 'auxsend') {
      addrLow = 0x24 + (auxIndex - 1) * 2;
    } else {
      addrLow = ADDR_LOW_FADER;
    }
    const msb = (value >> 7) & 0x7F;
    const lsb = value & 0x7F;
    dataBytes = [msb, lsb];
  } else if (type === 'mute') {
    if (target === 'auxsend') {
      addrLow = 0x23 + (auxIndex - 1) * 2;
    } else {
      addrLow = ADDR_LOW_ON;
    }
    const onValue = value === 1 ? 0 : 1;
    dataBytes = [onValue];
  } else if (type === 'eq') {
    if (target !== 'input' && target !== 'master') return []; // 01v96 EQ nos canais de entrada e master
    
    if (param === 'on') {
      addrLow = 0x00;
      dataBytes = [value]; // 0 ou 1
    } else {
      if (!band || band < 1 || band > 4) return [];
      
      if (param === 'q') addrLow = 0x01 + (band - 1) * 3;
      else if (param === 'freq') addrLow = 0x02 + (band - 1) * 3;
      else if (param === 'gain') addrLow = 0x03 + (band - 1) * 3;
      else return [];

      dataBytes = [value]; // 0..127
    }
  } else if (type === 'gate') {
    if (target !== 'input' && target !== 'master') return []; // Apenas canais de entrada e master
    
    if (param === 'on') addrLow = 0x10;
    else if (param === 'threshold') addrLow = 0x11;
    else if (param === 'range') addrLow = 0x12;
    else if (param === 'attack') addrLow = 0x13;
    else if (param === 'hold') addrLow = 0x14;
    else if (param === 'decay') addrLow = 0x15;
    else return [];

    dataBytes = [value]; // 0..127
  } else if (type === 'comp') {
    if (target !== 'input' && target !== 'master') return []; // Apenas canais de entrada e master
    
    if (param === 'on') addrLow = 0x16;
    else if (param === 'threshold') addrLow = 0x17;
    else if (param === 'ratio') addrLow = 0x18;
    else if (param === 'attack') addrLow = 0x19;
    else if (param === 'outgain') addrLow = 0x1A;
    else if (param === 'release') addrLow = 0x1B;
    else if (param === 'knee') addrLow = 0x1C;
    else return [];

    dataBytes = [value]; // 0..127
  } else {
    return [];
  }

  return [
    ...SYSEX_HEADER,
    addrHigh,
    addrMid,
    addrLow,
    ...dataBytes,
    SYSEX_END
  ];
}

/**
 * Codifica um comando do frontend em uma mensagem MIDI Control Change (CC).
 */
function encodeCCMessage(type, target, channel, value) {
  const status = 0xB0;
  
  if (type === 'fader') {
    const ccVal = Math.round((value / 1023) * 127);
    if (target === 'input') {
      return [status, channel, ccVal];
    } else if (target === 'bus') {
      return [status, channel + 32, ccVal];
    } else if (target === 'aux') {
      return [status, channel + 40, ccVal];
    } else if (target === 'master') {
      return [status, 49, ccVal];
    }
  } else if (type === 'mute') {
    const ccVal = value === 1 ? 0 : 127;
    if (target === 'input') {
      return [status, channel + 50, ccVal];
    } else if (target === 'bus') {
      return [status, channel + 82, ccVal];
    } else if (target === 'aux') {
      return [status, channel + 90, ccVal];
    } else if (target === 'master') {
      return [status, 99, ccVal];
    }
  }
  
  return [];
}

module.exports = {
  decodeMIDIMessage,
  encodeSysExMessage,
  encodeCCMessage
};

