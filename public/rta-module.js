const RTAModule = (function () {
  let audioCtx, analyser, source, stream;
  let canvas, ctx;
  let isRunning = false;
  let animId = null;
  let getMixerState, getSelectedTarget, getSelectedChannel;
  let peakHold = [];
  let sampleRate = 44100;

  const BANDS = [
    { freq: 20, label: '20' },
    { freq: 25, label: '25' },
    { freq: 31.5, label: '31' },
    { freq: 40, label: '40' },
    { freq: 50, label: '50' },
    { freq: 63, label: '63' },
    { freq: 80, label: '80' },
    { freq: 100, label: '100' },
    { freq: 125, label: '125' },
    { freq: 160, label: '160' },
    { freq: 200, label: '200' },
    { freq: 250, label: '250' },
    { freq: 315, label: '315' },
    { freq: 400, label: '400' },
    { freq: 500, label: '500' },
    { freq: 630, label: '630' },
    { freq: 800, label: '800' },
    { freq: 1000, label: '1k' },
    { freq: 1250, label: '1.25k' },
    { freq: 1600, label: '1.6k' },
    { freq: 2000, label: '2k' },
    { freq: 2500, label: '2.5k' },
    { freq: 3150, label: '3.15k' },
    { freq: 4000, label: '4k' },
    { freq: 5000, label: '5k' },
    { freq: 6300, label: '6.3k' },
    { freq: 8000, label: '8k' },
    { freq: 10000, label: '10k' },
    { freq: 12500, label: '12.5k' },
    { freq: 16000, label: '16k' },
    { freq: 20000, label: '20k' }
  ];

  let eqValues = {};

  function init(config) {
    getMixerState = config.getMixerState;
    getSelectedTarget = config.getSelectedTarget;
    getSelectedChannel = config.getSelectedChannel;
    canvas = document.getElementById('rta-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    peakHold = new Array(128).fill(0);
    buildEQ();
  }

  function isAllowed(target) {
    return target === 'master' || target === 'aux';
  }

  function buildEQ() {
    const container = document.getElementById('rta-eq-bands');
    if (!container) return;
    container.innerHTML = '';
    BANDS.forEach((band, idx) => {
      eqValues[band.freq] = 0;
      const div = document.createElement('div');
      div.className = 'rta-eq-band';
      div.dataset.freq = band.freq;

      const track = document.createElement('div');
      track.className = 'rta-eq-fader-track';

      const fill = document.createElement('div');
      fill.className = 'rta-eq-fader-fill';
      fill.id = `eq-fill-${idx}`;
      fill.style.height = '0';
      track.appendChild(fill);

      const label = document.createElement('div');
      label.className = 'rta-eq-band-label';
      label.textContent = band.label;

      div.appendChild(track);
      div.appendChild(label);
      container.appendChild(div);

      let dragging = false;
      let startY, startVal;

      function updateFromY(clientY) {
        const rect = track.getBoundingClientRect();
        const pct = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        const val = Math.round((pct * 2 - 1) * 12);
        setBand(idx, val);
      }

      function onMove(e) {
        e.preventDefault();
        updateFromY(e.clientY);
      }

      function onUp(e) {
        e.preventDefault();
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      div.addEventListener('mousedown', function (e) {
        e.preventDefault();
        dragging = true;
        startY = e.clientY;
        startVal = eqValues[band.freq] || 0;
        updateFromY(e.clientY);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  function setBand(idx, val) {
    val = Math.max(-12, Math.min(12, val));
    const band = BANDS[idx];
    if (!band) return;
    eqValues[band.freq] = val;
    const fill = document.getElementById(`eq-fill-${idx}`);
    if (!fill) return;
    const mid = 50;
    const pct = ((val + 12) / 24) * 100;
    if (val >= 0) {
      fill.className = 'rta-eq-fader-fill';
      fill.style.bottom = mid + '%';
      fill.style.top = 'auto';
      fill.style.height = (pct - mid) + '%';
    } else {
      fill.className = 'rta-eq-fader-fill cut';
      fill.style.top = mid + '%';
      fill.style.bottom = 'auto';
      fill.style.height = (mid - pct) + '%';
    }
  }

  function start() {
    if (isRunning) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      document.getElementById('rta-status-text').textContent = 'API de áudio não disponível';
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(s => {
        stream = s;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        sampleRate = audioCtx.sampleRate;
        source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        isRunning = true;
        document.getElementById('rta-led').classList.add('active');
        document.getElementById('rta-status-text').textContent = 'ANALISANDO...';
        document.getElementById('rta-btn-icon').className = 'fa-solid fa-stop';
        document.getElementById('rta-btn-text').textContent = 'PARAR';
        drawLoop();
      })
      .catch(() => {
        document.getElementById('rta-status-text').textContent = 'Microfone não disponível';
      });
  }

  function stop() {
    isRunning = false;
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    analyser = null;
    source = null;
    document.getElementById('rta-led').classList.remove('active');
    document.getElementById('rta-status-text').textContent = 'PARADO';
    document.getElementById('rta-btn-icon').className = 'fa-solid fa-play';
    document.getElementById('rta-btn-text').textContent = 'INICIAR';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    document.getElementById('rta-critical-badges').innerHTML = '';
  }

  function resizeCanvas() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio;
    const wrap = canvas.parentElement;
    const w = Math.min(wrap.clientWidth, 1000);
    const h = Math.min(wrap.clientHeight, 207.667);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }

  function drawLoop() {
    if (!isRunning || !analyser) return;
    draw();
    animId = requestAnimationFrame(drawLoop);
  }

  function draw() {
    if (!ctx || !analyser) return;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const barCount = bufferLength;
    const barWidth = w / barCount;

    let sum = 0;
    for (let i = 0; i < barCount; i++) sum += dataArray[i];
    const avg = sum / barCount;
    const threshold = avg * 1.5;

    for (let i = 0; i < barCount; i++) {
      if (dataArray[i] > peakHold[i]) peakHold[i] = dataArray[i];
      else peakHold[i] = Math.max(0, peakHold[i] - 2);
    }

    const peaks = [];
    for (let i = 0; i < barCount; i++) {
      const val = dataArray[i] / 255;
      const barH = val * h * 0.9;
      const x = i * barWidth;
      const isPeak = dataArray[i] > threshold && dataArray[i] > 100;

      let color;
      if (isPeak) {
        color = `hsl(${Math.max(0, 30 - (dataArray[i] - threshold) * 0.5)}, 90%, 55%)`;
        const freq = i * (sampleRate / 2) / bufferLength;
        if (freq >= 20 && freq <= 20000) {
          peaks.push({ freq: Math.round(freq), level: dataArray[i] });
        }
      } else {
        const hue = 240 - (val * 120);
        color = `hsl(${hue}, 70%, ${40 + val * 30}%)`;
      }

      ctx.fillStyle = color;
      ctx.fillRect(x, h - barH, Math.max(1, barWidth - 0.5), barH);

      const holdH = (peakHold[i] / 255) * h * 0.9;
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(x, h - holdH, Math.max(1, barWidth - 0.5), 2);
    }

    updateCriticalBadges(peaks);
  }

  function updateCriticalBadges(peaks) {
    const container = document.getElementById('rta-critical-badges');
    if (!container) return;

    const bandLevels = BANDS.map(band => {
      const matching = peaks.filter(p => p.freq <= band.freq * 1.3 && p.freq >= band.freq * 0.7);
      const maxLevel = matching.length ? Math.max(...matching.map(p => p.level)) : 0;
      return { ...band, level: maxLevel };
    });

    const significant = bandLevels.filter(b => b.level > 140);

    if (!significant.length) {
      container.innerHTML = '<span style="font-size:0.5rem;color:#475569;font-style:italic">—</span>';
      return;
    }

    container.innerHTML = significant.map(b => {
      const excess = Math.round((b.level - 140) / 2);
      const cls = excess > 20 ? 'status-critical' : 'status-warning';
      return `<span class="rta-critical-badge ${cls}">${b.label} +${excess}</span>`;
    }).join('');
  }

  function openPanel() {
    if (!canvas) return;
    resizeCanvas();
    if (!isRunning) start();
  }

  if (typeof ResizeObserver !== 'undefined') {
    let ro = null;
    const origInit = init;
    init = function(config) {
      origInit(config);
      if (ro) ro.disconnect();
      const wrap = canvas.parentElement;
      ro = new ResizeObserver(() => {
        if (wrap.clientHeight > 0) resizeCanvas();
      });
      ro.observe(wrap);
    };
  }

  return { init, isAllowed, start, stop, resizeCanvas, openPanel };
})();
