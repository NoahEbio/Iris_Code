(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const qsa = (sel) => [...document.querySelectorAll(sel)];

  // -------- Hardware / tracking constants --------
  const BLE = {
    service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    tx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    rx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e'
  };

  const COMMAND = Object.freeze({ FORWARD: 'F', LEFT: 'L', RIGHT: 'R', STOP: 'S' });
  const MIN_TARGET_AREA = 0.02;
  const LEFT_EDGE = 0.33;
  const RIGHT_EDGE = 0.67;
  const BLE_HEARTBEAT_MS = 350;
  const TRACK_INTERVAL_MS = 85;

  const state = {
    cameraStream: null,
    cameraOn: false,
    tracking: false,
    lastTrackAt: 0,
    target: null,

    bleDevice: null,
    bleServer: null,
    txChar: null,
    rxChar: null,
    lastCommand: COMMAND.STOP,
    lastBleSendAt: 0,

    atlasSocket: null,
    panelLockedByAtlas: false,

    voiceProcessor: null,
    meterEngine: null,
    meterSubscribed: false,
    fallbackMicStream: null,
    fallbackAudioContext: null,
    fallbackAnalyser: null,
    fallbackMeterFrame: null,
    micEnabled: false,

    porcupine: null,
    porcupineRunning: false,
    recognition: null,
    recognitionBusy: false,
    resumeWakeAfterRecognition: false,

    currentPanelState: {
      mode: 'idle',
      mood: 'calm',
      energy: 0.35,
      attention: 0.45,
      speechLevel: 0.08,
      brightness: 1,
      message: 'SYSTEM READY'
    }
  };

  const el = {
    tabs: qsa('.tab'),
    debugView: $('debugView'),
    panelView: $('panelView'),
    video: $('cameraVideo'),
    overlay: $('overlayCanvas'),
    process: $('processCanvas'),
    cameraBadge: $('cameraBadge'),

    bleStatus: $('bleStatus'),
    cameraStatus: $('cameraStatus'),
    commandStatus: $('commandStatus'),
    centroidStatus: $('centroidStatus'),
    areaStatus: $('areaStatus'),
    widthStatus: $('widthStatus'),
    ackStatus: $('ackStatus'),
    trackingStatus: $('trackingStatus'),
    micStatus: $('micStatus'),
    wakeStatus: $('wakeStatus'),
    atlasStatus: $('atlasStatus'),
    voiceStatus: $('voiceStatus'),

    connectBleBtn: $('connectBleBtn'),
    cameraBtn: $('cameraBtn'),
    trackingBtn: $('trackingBtn'),
    audioBtn: $('audioBtn'),
    wakeBtn: $('wakeBtn'),

    targetColor: $('targetColor'),
    tolerance: $('tolerance'),
    toleranceOut: $('toleranceOut'),
    stopWidth: $('stopWidth'),
    stopWidthOut: $('stopWidthOut'),

    micMeter: $('micMeter'),
    lastTranscript: $('lastTranscript'),
    lastReply: $('lastReply'),
    listenOnceBtn: $('listenOnceBtn'),
    testToneBtn: $('testToneBtn'),
    ttsInput: $('ttsInput'),
    speakBtn: $('speakBtn'),

    atlasWsUrl: $('atlasWsUrl'),
    atlasConnectBtn: $('atlasConnectBtn'),
    atlasDisconnectBtn: $('atlasDisconnectBtn'),

    picovoiceKey: $('picovoiceKey'),
    wakeSensitivity: $('wakeSensitivity'),
    wakeSensitivityOut: $('wakeSensitivityOut'),

    eventLog: $('eventLog'),

    droidShell: $('droidShell'),
    panelModeLabel: $('panelModeLabel'),
    panelMessage: $('panelMessage'),
    panelBleInfo: $('panelBleInfo'),
    panelAtlasInfo: $('panelAtlasInfo'),
    panelMicInfo: $('panelMicInfo'),
    panelLastHeard: $('panelLastHeard'),
    centerGlyph: $('centerGlyph'),
    bar1Fill: $('bar1Fill'),
    bar2Fill: $('bar2Fill')
  };

  function log(message, data) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    let line = `[${time}] ${message}`;
    if (data !== undefined) {
      try { line += ` ${typeof data === 'string' ? data : JSON.stringify(data)}`; }
      catch { line += ' [data]'; }
    }
    console.log(line);
    el.eventLog.textContent = `${line}\n${el.eventLog.textContent}`.slice(0, 12000);
  }

  function status(node, text, kind = '') {
    node.textContent = text;
    node.classList.remove('good', 'bad');
    if (kind) node.classList.add(kind);
  }

  function clamp(n, min = 0, max = 1) {
    return Math.max(min, Math.min(max, Number(n) || 0));
  }

  // -------- Tabs --------
  function openTab(name) {
    el.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    el.debugView.classList.toggle('active', name === 'debug');
    el.panelView.classList.toggle('active', name === 'panel');
  }
  el.tabs.forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));

  // -------- Camera + target tracking --------
  async function startCamera() {
    if (state.cameraOn) return;
    try {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { exact: 'user' },
          width: { ideal: 640 },
          height: { ideal: 480 }
        },
        audio: false
      });
    } catch (exactError) {
      log('Exact selfie camera failed; retrying preferred user camera', String(exactError));
      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      });
    }

    el.video.srcObject = state.cameraStream;
    await el.video.play();
    state.cameraOn = true;
    status(el.cameraStatus, 'ready', 'good');
    el.cameraBadge.textContent = 'SELFIE CAMERA';
    el.cameraBtn.textContent = 'Camera Running';
    el.cameraBtn.disabled = true;
    log('Selfie camera started');
    sendAtlas({ type: 'event', event: 'camera_ready' });
    requestAnimationFrame(trackingLoop);
  }

  function parseHexColor(hex) {
    const value = hex.replace('#', '');
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  }

  function trackingLoop(ts) {
    if (!state.cameraOn) return;
    if (ts - state.lastTrackAt >= TRACK_INTERVAL_MS) {
      state.lastTrackAt = ts;
      processTrackingFrame();
    }
    requestAnimationFrame(trackingLoop);
  }

  function processTrackingFrame() {
    const video = el.video;
    if (video.readyState < 2) return;

    const pc = el.process;
    const ctx = pc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, pc.width, pc.height);
    const frame = ctx.getImageData(0, 0, pc.width, pc.height);
    const px = frame.data;

    const target = parseHexColor(el.targetColor.value);
    const tolerance = Number(el.tolerance.value);
    const toleranceSq = tolerance * tolerance;

    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = pc.width;
    let maxX = -1;
    let minY = pc.height;
    let maxY = -1;

    for (let y = 0; y < pc.height; y++) {
      for (let x = 0; x < pc.width; x++) {
        const i = (y * pc.width + x) * 4;
        const dr = px[i] - target.r;
        const dg = px[i + 1] - target.g;
        const db = px[i + 2] - target.b;
        if ((dr * dr + dg * dg + db * db) <= toleranceSq) {
          count++;
          sumX += x;
          sumY += y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const area = count / (pc.width * pc.height);
    if (!count || area < MIN_TARGET_AREA) {
      state.target = null;
      el.centroidStatus.textContent = '0.50';
      el.areaStatus.textContent = area.toFixed(3);
      el.widthStatus.textContent = '0%';
      if (state.tracking) commandRobot(COMMAND.STOP, 'no target');
      drawOverlay(null);
      sendTelemetryMaybe(null, area);
      return;
    }

    const cx = (sumX / count) / pc.width;
    const cy = (sumY / count) / pc.height;
    const width = (maxX - minX + 1) / pc.width;
    const height = (maxY - minY + 1) / pc.height;
    const stopWidth = Number(el.stopWidth.value) / 100;

    let cmd = COMMAND.FORWARD;
    if (width >= stopWidth) cmd = COMMAND.STOP;
    else if (cx < LEFT_EDGE) cmd = COMMAND.LEFT;
    else if (cx > RIGHT_EDGE) cmd = COMMAND.RIGHT;

    state.target = { cx, cy, area, width, height, minX, maxX, minY, maxY, cmd };
    el.centroidStatus.textContent = cx.toFixed(2);
    el.areaStatus.textContent = area.toFixed(3);
    el.widthStatus.textContent = `${Math.round(width * 100)}%`;

    if (state.tracking) commandRobot(cmd, 'tracker');
    drawOverlay(state.target);
    sendTelemetryMaybe(state.target, area);
  }

  let lastTelemetryAt = 0;
  function sendTelemetryMaybe(target, area) {
    const now = performance.now();
    if (now - lastTelemetryAt < 500) return;
    lastTelemetryAt = now;
    sendAtlas({
      type: 'telemetry',
      tracking: state.tracking,
      command: state.lastCommand,
      target: target ? {
        x: +target.cx.toFixed(3),
        y: +target.cy.toFixed(3),
        area: +target.area.toFixed(4),
        width: +target.width.toFixed(3)
      } : null,
      area: +area.toFixed(4)
    });
  }

  function drawOverlay(target) {
    const canvas = el.overlay;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!target) return;

    // Preview is mirrored with CSS. Mirror overlay coordinates to match what the user sees.
    const x1 = (1 - ((target.maxX + 1) / el.process.width)) * w;
    const x2 = (1 - (target.minX / el.process.width)) * w;
    const y1 = (target.minY / el.process.height) * h;
    const y2 = ((target.maxY + 1) / el.process.height) * h;
    const cx = (1 - target.cx) * w;
    const cy = target.cy * h;

    ctx.strokeStyle = '#57d6ff';
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx - 8 * dpr, cy); ctx.lineTo(cx + 8 * dpr, cy);
    ctx.moveTo(cx, cy - 8 * dpr); ctx.lineTo(cx, cy + 8 * dpr);
    ctx.stroke();

    const label = `TARGET ${Math.round(target.width * 100)}% ${target.cmd}`;
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    const tw = ctx.measureText(label).width;
    const tx = Math.max(6 * dpr, Math.min(w - tw - 14 * dpr, x1));
    const ty = Math.max(18 * dpr, y1 - 7 * dpr);
    ctx.fillStyle = 'rgba(0,0,0,.74)';
    ctx.fillRect(tx - 5 * dpr, ty - 13 * dpr, tw + 10 * dpr, 18 * dpr);
    ctx.fillStyle = '#e7f8ff';
    ctx.fillText(label, tx, ty);
  }

  function setTracking(on, source = 'ui') {
    state.tracking = !!on;
    status(el.trackingStatus, on ? 'active' : 'paused', on ? 'good' : '');
    el.trackingBtn.textContent = on ? 'Stop Tracking' : 'Start Tracking';
    if (!on) commandRobot(COMMAND.STOP, 'tracking off');
    sendAtlas({ type: 'event', event: on ? 'tracking_started' : 'tracking_stopped', source });
    if (!state.panelLockedByAtlas) setPanelState({ mode: on ? 'following' : 'idle', message: on ? 'FOLLOWING' : 'SYSTEM READY' }, 'local');
  }

  // -------- BLE --------
  async function connectBle() {
    if (!navigator.bluetooth) {
      status(el.bleStatus, 'Web Bluetooth unavailable', 'bad');
      log('Web Bluetooth API not available in this browser');
      return;
    }

    try {
      status(el.bleStatus, 'select device...');
      state.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE.service] }],
        optionalServices: [BLE.service]
      });
      state.bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);
      status(el.bleStatus, 'connecting...');
      state.bleServer = await state.bleDevice.gatt.connect();
      const service = await state.bleServer.getPrimaryService(BLE.service);
      state.txChar = await service.getCharacteristic(BLE.tx);

      try {
        state.rxChar = await service.getCharacteristic(BLE.rx);
        await state.rxChar.startNotifications();
        state.rxChar.addEventListener('characteristicvaluechanged', (event) => {
          const value = new TextDecoder().decode(event.target.value).trim();
          status(el.ackStatus, value || 'ACK', 'good');
        });
      } catch (rxErr) {
        log('RX notifications unavailable; TX still usable', String(rxErr));
      }

      status(el.bleStatus, state.bleDevice.name || 'connected', 'good');
      el.connectBleBtn.textContent = 'BLE Connected';
      el.panelBleInfo.textContent = 'BLE OK';
      log('BLE connected', state.bleDevice.name || 'device');
      sendAtlas({ type: 'event', event: 'ble_connected', name: state.bleDevice.name || null });
    } catch (err) {
      status(el.bleStatus, 'connection failed', 'bad');
      el.panelBleInfo.textContent = 'BLE --';
      log('BLE connection error', String(err));
    }
  }

  function onBleDisconnected() {
    state.txChar = null;
    state.rxChar = null;
    status(el.bleStatus, 'disconnected', 'bad');
    el.connectBleBtn.textContent = 'Connect BLE';
    el.panelBleInfo.textContent = 'BLE --';
    log('BLE disconnected');
    sendAtlas({ type: 'event', event: 'ble_disconnected' });
  }

  async function writeBle(command) {
    if (!state.txChar) return false;
    const bytes = new TextEncoder().encode(command);
    try {
      if (state.txChar.properties.writeWithoutResponse && state.txChar.writeValueWithoutResponse) {
        await state.txChar.writeValueWithoutResponse(bytes);
      } else if (state.txChar.writeValueWithResponse) {
        await state.txChar.writeValueWithResponse(bytes);
      } else {
        await state.txChar.writeValue(bytes);
      }
      return true;
    } catch (err) {
      log('BLE write failed', String(err));
      return false;
    }
  }

  async function commandRobot(command, reason = '') {
    if (!Object.values(COMMAND).includes(command)) return;
    const now = performance.now();
    const changed = command !== state.lastCommand;
    if (!changed && now - state.lastBleSendAt < BLE_HEARTBEAT_MS) return;

    state.lastCommand = command;
    state.lastBleSendAt = now;
    el.commandStatus.textContent = command;
    await writeBle(command);
    if (changed) {
      log(`CMD ${command}${reason ? ` (${reason})` : ''}`);
      sendAtlas({ type: 'event', event: 'robot_command', command, reason });
    }
  }

  // -------- Audio input meter --------
  function getVoiceProcessor() {
    return window.WebVoiceProcessor && window.WebVoiceProcessor.WebVoiceProcessor;
  }

  function makeMeterEngine() {
    return {
      postMessage(message) {
        const frame = message && message.inputFrame;
        if (!frame || !frame.length) return;
        let sum = 0;
        for (let i = 0; i < frame.length; i++) {
          const v = frame[i] / 32768;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / frame.length);
        updateMicLevel(clamp(rms * 5.2));
      }
    };
  }

  function updateMicLevel(level) {
    const pct = Math.round(clamp(level) * 100);
    el.micMeter.style.width = `${Math.max(2, pct)}%`;
    if (!state.panelLockedByAtlas && state.currentPanelState.mode === 'listening') {
      document.documentElement.style.setProperty('--speech-level', String(clamp(level)));
    }
  }

  async function enableAudio() {
    if (state.micEnabled) return true;

    try {
      const VP = getVoiceProcessor();
      if (VP) {
        state.voiceProcessor = VP;
        state.meterEngine = makeMeterEngine();
        await VP.subscribe(state.meterEngine);
        state.meterSubscribed = true;
        state.micEnabled = true;
        status(el.micStatus, 'live', 'good');
        el.panelMicInfo.textContent = 'MIC OK';
        el.audioBtn.textContent = 'Audio Enabled';
        el.audioBtn.disabled = true;
        log('Microphone enabled through WebVoiceProcessor');
        return true;
      }

      // Fallback if Picovoice CDN is blocked: plain Web Audio meter.
      state.fallbackMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      state.fallbackAudioContext = new AC();
      const source = state.fallbackAudioContext.createMediaStreamSource(state.fallbackMicStream);
      state.fallbackAnalyser = state.fallbackAudioContext.createAnalyser();
      state.fallbackAnalyser.fftSize = 512;
      source.connect(state.fallbackAnalyser);
      const data = new Uint8Array(state.fallbackAnalyser.fftSize);
      const tick = () => {
        if (!state.fallbackAnalyser) return;
        state.fallbackAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const sample of data) {
          const v = (sample - 128) / 128;
          sum += v * v;
        }
        updateMicLevel(clamp(Math.sqrt(sum / data.length) * 3.5));
        state.fallbackMeterFrame = requestAnimationFrame(tick);
      };
      tick();
      state.micEnabled = true;
      status(el.micStatus, 'live', 'good');
      el.panelMicInfo.textContent = 'MIC OK';
      el.audioBtn.textContent = 'Audio Enabled';
      el.audioBtn.disabled = true;
      log('Microphone enabled through Web Audio fallback');
      return true;
    } catch (err) {
      status(el.micStatus, 'permission/error', 'bad');
      el.panelMicInfo.textContent = 'MIC --';
      log('Microphone error', String(err));
      return false;
    }
  }

  // -------- Two-tone acknowledgement + speech output --------
  let toneContext = null;
  async function playAckTone() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      toneContext = toneContext || new AC();
      if (toneContext.state === 'suspended') await toneContext.resume();
      const now = toneContext.currentTime;
      const notes = [659.25, 880];
      notes.forEach((freq, index) => {
        const osc = toneContext.createOscillator();
        const gain = toneContext.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = now + index * 0.115;
        const stop = start + 0.12;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, stop);
        osc.connect(gain).connect(toneContext.destination);
        osc.start(start);
        osc.stop(stop + 0.02);
      });
    } catch (err) {
      log('Tone error', String(err));
    }
  }

  function speakText(text, options = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    el.lastReply.textContent = clean;
    if (!('speechSynthesis' in window)) {
      log('Speech synthesis unavailable');
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = options.rate || 0.96;
    utterance.pitch = options.pitch || 0.96;
    utterance.volume = options.volume || 1;
    utterance.onstart = () => {
      status(el.voiceStatus, 'speaking', 'good');
      if (!state.panelLockedByAtlas) setPanelState({ mode: 'speaking', message: clean.slice(0, 46), speechLevel: 0.72 }, 'local');
    };
    utterance.onend = () => {
      status(el.voiceStatus, 'idle');
      if (!state.panelLockedByAtlas) setPanelState({ mode: state.tracking ? 'following' : 'idle', message: state.tracking ? 'FOLLOWING' : 'SYSTEM READY', speechLevel: 0.08 }, 'local');
    };
    utterance.onerror = (e) => log('Speech output error', e.error || 'unknown');
    window.speechSynthesis.speak(utterance);
  }

  // -------- Porcupine wake word --------
  async function localModelFileExists() {
    try {
      const res = await fetch('./models/porcupine_params.pv', { method: 'HEAD', cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function localKeywordFileExists() {
    try {
      const res = await fetch('./models/hey_atlas_wasm.ppn', { method: 'HEAD', cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function buildHeyAtlasKeyword(accessKey, sensitivity) {
    if (await localKeywordFileExists()) {
      log('Using local Hey Atlas Porcupine model');
      return {
        publicPath: './models/hey_atlas_wasm.ppn',
        label: 'Hey Atlas',
        sensitivity
      };
    }

    if (!window.PorcupineWeb || !PorcupineWeb.Porcupine || !PorcupineWeb.Porcupine.trainWakeWordFromPhrase) {
      throw new Error('Porcupine training API is unavailable. Add models/hey_atlas_wasm.ppn manually.');
    }

    status(el.wakeStatus, 'training phrase...');
    log('Training Hey Atlas wake word through Picovoice Model API (first setup/fallback)');
    const keyword = await PorcupineWeb.Porcupine.trainWakeWordFromPhrase(
      accessKey,
      'iris_hey_atlas_v1.ppn',
      'en',
      'Hey Atlas'
    );
    keyword.label = 'Hey Atlas';
    keyword.sensitivity = sensitivity;
    return keyword;
  }

  async function startWakeWord() {
    if (state.porcupineRunning) return;
    const accessKey = el.picovoiceKey.value.trim();
    if (!accessKey) {
      status(el.wakeStatus, 'AccessKey needed', 'bad');
      log('Paste a Picovoice AccessKey first');
      return;
    }
    localStorage.setItem('iris_picovoice_key', accessKey);
    const sensitivity = Number(el.wakeSensitivity.value);
    localStorage.setItem('iris_wake_sensitivity', String(sensitivity));

    if (!window.PorcupineWeb || !PorcupineWeb.PorcupineWorker) {
      status(el.wakeStatus, 'Porcupine CDN failed', 'bad');
      log('PorcupineWeb global not found');
      return;
    }

    const audioOkay = await enableAudio();
    if (!audioOkay) return;

    try {
      status(el.wakeStatus, 'loading...');
      const keyword = await buildHeyAtlasKeyword(accessKey, sensitivity);
      const localModel = await localModelFileExists();
      const model = {
        publicPath: localModel
          ? './models/porcupine_params.pv'
          : 'https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common/porcupine_params.pv',
        customWritePath: 'iris_porcupine_params_v1',
        version: 1
      };
      log(localModel ? 'Using local Porcupine parameter model' : 'Using official Picovoice model from GitHub');

      state.porcupine = await PorcupineWeb.PorcupineWorker.create(
        accessKey,
        [keyword],
        onWakeWordDetected,
        model
      );

      await state.voiceProcessor.subscribe(state.porcupine);
      state.porcupineRunning = true;
      status(el.wakeStatus, 'listening', 'good');
      el.wakeBtn.textContent = '“Hey Atlas” Listening';
      el.wakeBtn.disabled = true;
      log('Porcupine is listening for “Hey Atlas”');
      sendAtlas({ type: 'event', event: 'wake_word_online', phrase: 'Hey Atlas' });
    } catch (err) {
      status(el.wakeStatus, 'start failed', 'bad');
      log('Porcupine start error', String(err));
    }
  }

  async function onWakeWordDetected(detection) {
    log('Wake word detected', detection && detection.label ? detection.label : 'Hey Atlas');
    status(el.wakeStatus, 'detected', 'good');
    el.panelLastHeard.textContent = 'HEY ATLAS';
    sendAtlas({ type: 'event', event: 'wake_word_detected', label: detection && detection.label ? detection.label : 'Hey Atlas' });
    if (!state.panelLockedByAtlas) setPanelState({ mode: 'listening', mood: 'focused', attention: 1, message: 'LISTENING' }, 'local');
    await playAckTone();
    setTimeout(() => listenForSpeechAfterWake(), 120);
  }

  async function pausePicovoiceForRecognition() {
    if (!state.voiceProcessor) return;
    const engines = [];
    if (state.porcupineRunning && state.porcupine) engines.push(state.porcupine);
    if (state.meterSubscribed && state.meterEngine) engines.push(state.meterEngine);
    for (const engine of engines) {
      try { await state.voiceProcessor.unsubscribe(engine); } catch { /* no-op */ }
    }
  }

  async function resumePicovoiceAfterRecognition() {
    if (!state.voiceProcessor) return;
    if (state.meterSubscribed && state.meterEngine) {
      try { await state.voiceProcessor.subscribe(state.meterEngine); } catch { /* no-op */ }
    }
    if (state.porcupineRunning && state.porcupine) {
      try {
        await state.voiceProcessor.subscribe(state.porcupine);
        status(el.wakeStatus, 'listening', 'good');
      } catch (err) {
        log('Could not resume Porcupine', String(err));
      }
    }
  }

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  async function listenForSpeechAfterWake() {
    return listenOnce(true);
  }

  async function listenOnce(fromWake = false) {
    if (state.recognitionBusy) return;
    const Recognition = getSpeechRecognitionCtor();
    if (!Recognition) {
      status(el.voiceStatus, 'speech recognition unavailable', 'bad');
      speakText('Speech recognition is not available in this browser.');
      return;
    }

    state.recognitionBusy = true;
    state.resumeWakeAfterRecognition = state.porcupineRunning;
    if (state.resumeWakeAfterRecognition) await pausePicovoiceForRecognition();

    const recognition = new Recognition();
    state.recognition = recognition;
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      status(el.voiceStatus, 'listening', 'good');
      if (!state.panelLockedByAtlas) setPanelState({ mode: 'listening', message: 'LISTENING', attention: 1 }, 'local');
    };

    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript?.trim() || '';
      if (text) handleTranscript(text, fromWake);
    };

    recognition.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') log('Speech recognition error', event.error);
      status(el.voiceStatus, event.error || 'recognition error', 'bad');
    };

    recognition.onend = async () => {
      state.recognitionBusy = false;
      state.recognition = null;
      if (state.resumeWakeAfterRecognition) await resumePicovoiceAfterRecognition();
      if (el.voiceStatus.textContent === 'listening') status(el.voiceStatus, 'idle');
    };

    try { recognition.start(); }
    catch (err) {
      state.recognitionBusy = false;
      log('Could not start speech recognition', String(err));
      if (state.resumeWakeAfterRecognition) await resumePicovoiceAfterRecognition();
    }
  }

  function handleTranscript(rawText, fromWake) {
    let text = rawText.trim();
    text = text.replace(/^hey\s+atlas[,.!?\s-]*/i, '').trim() || rawText.trim();
    el.lastTranscript.textContent = text;
    el.panelLastHeard.textContent = text.toUpperCase().slice(0, 48);
    status(el.voiceStatus, 'understood', 'good');
    log('Voice transcript', text);
    sendAtlas({ type: 'event', event: 'transcript', text, fromWake: !!fromWake });
    routeVoiceIntent(text);
  }

  function routeVoiceIntent(text) {
    const t = text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();

    // Safety-critical/local robot commands bypass the LLM.
    if (/\b(stop|halt|freeze|emergency stop)\b/.test(t)) {
      setTracking(false, 'voice');
      commandRobot(COMMAND.STOP, 'voice stop');
      speakText('Stopped.');
      return;
    }

    if (/\b(follow me|start following|follow)\b/.test(t)) {
      setTracking(true, 'voice');
      speakText('Following.');
      return;
    }

    if (/\b(go forward|move forward|forward)\b/.test(t)) {
      commandRobot(COMMAND.FORWARD, 'voice manual');
      return;
    }
    if (/\b(turn left|go left|left)\b/.test(t)) {
      commandRobot(COMMAND.LEFT, 'voice manual');
      return;
    }
    if (/\b(turn right|go right|right)\b/.test(t)) {
      commandRobot(COMMAND.RIGHT, 'voice manual');
      return;
    }

    // Everything else goes to ATLAS on the PC.
    if (sendAtlas({ type: 'utterance', text, source: 'voice' })) {
      status(el.voiceStatus, 'sent to ATLAS', 'good');
      if (!state.panelLockedByAtlas) setPanelState({ mode: 'thinking', message: 'THINKING' }, 'local');
    } else {
      speakText('Atlas link is not connected.');
    }
  }

  // -------- ATLAS WebSocket --------
  function connectAtlas() {
    const url = el.atlasWsUrl.value.trim();
    if (!url) {
      status(el.atlasStatus, 'URL needed', 'bad');
      return;
    }
    localStorage.setItem('iris_atlas_ws', url);

    try {
      if (state.atlasSocket) state.atlasSocket.close();
      status(el.atlasStatus, 'connecting...');
      const ws = new WebSocket(url);
      state.atlasSocket = ws;

      ws.onopen = () => {
        status(el.atlasStatus, 'online', 'good');
        el.panelAtlasInfo.textContent = 'LINK OK';
        log('ATLAS WebSocket connected');
        sendAtlas({
          type: 'hello',
          client: 'IRIS-web-v4',
          capabilities: ['panel', 'tts', 'voice', 'ble', 'tracking', 'camera-telemetry']
        });
      };

      ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); }
        catch {
          message = { type: 'tts', text: String(event.data) };
        }
        handleAtlasMessage(message);
      };

      ws.onerror = () => status(el.atlasStatus, 'socket error', 'bad');
      ws.onclose = () => {
        if (state.atlasSocket === ws) state.atlasSocket = null;
        status(el.atlasStatus, 'offline', 'bad');
        el.panelAtlasInfo.textContent = 'LINK --';
        state.panelLockedByAtlas = false;
        log('ATLAS WebSocket disconnected');
      };
    } catch (err) {
      status(el.atlasStatus, 'connection failed', 'bad');
      log('ATLAS connection error', String(err));
    }
  }

  function disconnectAtlas() {
    if (state.atlasSocket) state.atlasSocket.close(1000, 'user disconnect');
    state.atlasSocket = null;
    state.panelLockedByAtlas = false;
    status(el.atlasStatus, 'offline', 'bad');
    el.panelAtlasInfo.textContent = 'LINK --';
  }

  function sendAtlas(message) {
    const ws = state.atlasSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ ...message, ts: Date.now() }));
    return true;
  }

  function handleAtlasMessage(message) {
    if (!message || typeof message !== 'object') return;
    log('ATLAS -> IRIS', message);

    switch (message.type) {
      case 'panel_state':
      case 'panel':
        setPanelState(message.state || message, 'atlas');
        break;

      case 'response':
      case 'reply':
      case 'tts': {
        const text = message.text || message.reply || '';
        if (text) speakText(text, message.voice || {});
        if (message.panel) setPanelState(message.panel, 'atlas');
        break;
      }

      case 'command': {
        const cmd = String(message.command || '').toUpperCase();
        if (Object.values(COMMAND).includes(cmd)) commandRobot(cmd, 'ATLAS');
        break;
      }

      case 'tracking':
        setTracking(!!message.enabled, 'atlas');
        break;

      case 'tone':
        playAckTone();
        break;

      default:
        break;
    }
  }

  // -------- Droid panel rendering --------
  const MODE_GLYPH = {
    idle: '•••',
    listening: '⌁',
    thinking: '···',
    speaking: '≋',
    following: '▶',
    searching: '◇',
    success: '✓',
    warning: '!',
    error: '×',
    sleeping: '—'
  };

  const MODE_DEFAULTS = {
    idle: { energy: .30, attention: .38, speechLevel: .06, message: 'SYSTEM READY' },
    listening: { energy: .48, attention: .95, speechLevel: .28, message: 'LISTENING' },
    thinking: { energy: .58, attention: .82, speechLevel: .08, message: 'THINKING' },
    speaking: { energy: .78, attention: .72, speechLevel: .75, message: 'RESPONDING' },
    following: { energy: .74, attention: .92, speechLevel: .05, message: 'FOLLOWING' },
    searching: { energy: .54, attention: .78, speechLevel: .04, message: 'SEARCHING' },
    success: { energy: .82, attention: .65, speechLevel: .10, message: 'COMPLETE' },
    warning: { energy: .90, attention: 1, speechLevel: .04, message: 'WARNING' },
    error: { energy: .35, attention: 1, speechLevel: .02, message: 'FAULT' },
    sleeping: { energy: .05, attention: .05, speechLevel: .01, message: 'STANDBY' }
  };

  function setPanelState(patch, source = 'local') {
    if (source === 'local' && state.panelLockedByAtlas) return;
    if (source === 'atlas') state.panelLockedByAtlas = true;

    const requestedMode = String(patch.mode || state.currentPanelState.mode || 'idle').toLowerCase();
    const mode = MODE_DEFAULTS[requestedMode] ? requestedMode : 'idle';
    const defaults = MODE_DEFAULTS[mode];
    const next = {
      ...state.currentPanelState,
      ...defaults,
      ...patch,
      mode,
      mood: String(patch.mood || state.currentPanelState.mood || 'calm').toLowerCase()
    };
    state.currentPanelState = next;

    [...el.droidShell.classList].forEach((c) => {
      if (c.startsWith('state-') || c.startsWith('mood-')) el.droidShell.classList.remove(c);
    });
    el.droidShell.classList.add(`state-${mode}`, `mood-${next.mood}`);

    const root = document.documentElement;
    root.style.setProperty('--panel-brightness', String(clamp(next.brightness ?? 1, .15, 1.6)));
    root.style.setProperty('--speech-level', String(clamp(next.speechLevel)));
    root.style.setProperty('--energy-level', String(clamp(next.energy)));
    root.style.setProperty('--attention-level', String(clamp(next.attention)));

    if (next.color) {
      root.style.setProperty('--zone-color', next.color);
      root.style.setProperty('--zone-glow', next.glowColor || hexToGlow(next.color, .72));
    } else {
      root.style.removeProperty('--zone-color');
      root.style.removeProperty('--zone-glow');
    }

    el.panelModeLabel.textContent = mode.toUpperCase();
    el.panelMessage.textContent = String(next.message || defaults.message || '').toUpperCase().slice(0, 64);
    el.centerGlyph.textContent = patch.glyph || MODE_GLYPH[mode] || '•••';
    el.bar1Fill.style.width = `${Math.round(clamp(next.energy) * 100)}%`;
    const second = mode === 'speaking' ? next.speechLevel : next.attention;
    el.bar2Fill.style.width = `${Math.round(clamp(second) * 100)}%`;

    // Optional per-zone ATLAS control. Example: { zones:{ orb1:{color:'#fff',brightness:.2} } }
    if (patch.zones && typeof patch.zones === 'object') applyZoneOverrides(patch.zones);
    else clearZoneOverrides();
  }

  function hexToGlow(hex, alpha = .7) {
    const c = parseHexColor(hex);
    return `rgba(${c.r},${c.g},${c.b},${alpha})`;
  }

  function clearZoneOverrides() {
    qsa('[data-zone]').forEach((zone) => {
      zone.style.removeProperty('background');
      zone.style.removeProperty('border-color');
      zone.style.removeProperty('box-shadow');
      zone.style.removeProperty('opacity');
      zone.style.removeProperty('filter');
    });
  }

  function applyZoneOverrides(zones) {
    clearZoneOverrides();
    qsa('[data-zone]').forEach((zone) => {
      const cfg = zones[zone.dataset.zone];
      if (!cfg) return;
      if (cfg.color) {
        zone.style.background = cfg.color;
        zone.style.borderColor = cfg.color;
        zone.style.boxShadow = `0 0 16px ${cfg.color}`;
      }
      if (cfg.opacity !== undefined) zone.style.opacity = String(clamp(cfg.opacity));
      if (cfg.brightness !== undefined) zone.style.filter = `brightness(${clamp(cfg.brightness, 0, 2.5)})`;
    });
  }

  // -------- Events / controls --------
  el.connectBleBtn.addEventListener('click', connectBle);
  el.cameraBtn.addEventListener('click', startCamera);
  el.trackingBtn.addEventListener('click', () => setTracking(!state.tracking));
  el.audioBtn.addEventListener('click', enableAudio);
  el.wakeBtn.addEventListener('click', startWakeWord);
  el.listenOnceBtn.addEventListener('click', () => listenOnce(false));
  el.testToneBtn.addEventListener('click', playAckTone);
  el.speakBtn.addEventListener('click', () => speakText(el.ttsInput.value));
  el.ttsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') speakText(el.ttsInput.value); });
  el.atlasConnectBtn.addEventListener('click', connectAtlas);
  el.atlasDisconnectBtn.addEventListener('click', disconnectAtlas);

  qsa('[data-manual]').forEach((btn) => {
    btn.addEventListener('click', () => commandRobot(btn.dataset.manual, 'manual button'));
  });

  qsa('[data-demo-state]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.panelLockedByAtlas = false; // explicit user preview intentionally overrides lock
      setPanelState({ mode: btn.dataset.demoState }, 'demo');
      openTab('panel');
    });
  });

  el.tolerance.addEventListener('input', () => {
    el.toleranceOut.textContent = el.tolerance.value;
    localStorage.setItem('iris_tolerance', el.tolerance.value);
  });
  el.stopWidth.addEventListener('input', () => {
    el.stopWidthOut.textContent = `${el.stopWidth.value}%`;
    localStorage.setItem('iris_stop_width', el.stopWidth.value);
  });
  el.targetColor.addEventListener('input', () => localStorage.setItem('iris_target_color', el.targetColor.value));
  el.wakeSensitivity.addEventListener('input', () => {
    el.wakeSensitivityOut.textContent = Number(el.wakeSensitivity.value).toFixed(2);
  });

  window.addEventListener('resize', () => drawOverlay(state.target));

  // -------- Startup --------
  function restoreSettings() {
    const saved = {
      color: localStorage.getItem('iris_target_color'),
      tolerance: localStorage.getItem('iris_tolerance'),
      stopWidth: localStorage.getItem('iris_stop_width'),
      pv: localStorage.getItem('iris_picovoice_key'),
      sensitivity: localStorage.getItem('iris_wake_sensitivity'),
      ws: localStorage.getItem('iris_atlas_ws')
    };
    if (saved.color) el.targetColor.value = saved.color;
    if (saved.tolerance) el.tolerance.value = saved.tolerance;
    if (saved.stopWidth) el.stopWidth.value = saved.stopWidth;
    if (saved.pv) el.picovoiceKey.value = saved.pv;
    if (saved.sensitivity) el.wakeSensitivity.value = saved.sensitivity;
    if (saved.ws) el.atlasWsUrl.value = saved.ws;
    el.toleranceOut.textContent = el.tolerance.value;
    el.stopWidthOut.textContent = `${el.stopWidth.value}%`;
    el.wakeSensitivityOut.textContent = Number(el.wakeSensitivity.value).toFixed(2);
  }

  restoreSettings();
  setPanelState(state.currentPanelState, 'local');
  log('IRIS v4 loaded');
  log('Commands preserved: F / L / R / S');

  // Public hook so ATLAS/debug tools can drive the panel from the console too.
  window.IRIS = {
    setPanelState: (panelState) => setPanelState(panelState, 'atlas'),
    speak: speakText,
    sendCommand: (cmd) => commandRobot(String(cmd).toUpperCase(), 'window.IRIS'),
    startTracking: () => setTracking(true, 'window.IRIS'),
    stopTracking: () => setTracking(false, 'window.IRIS'),
    state
  };
})();
