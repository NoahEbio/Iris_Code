(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const qsa = (selector) => [...document.querySelectorAll(selector)];

  const BLE = {
    service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    tx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    rx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e'
  };

  const COMMAND = Object.freeze({
    FORWARD: 'F',
    REVERSE: 'B',
    LEFT_SLOW: 'l',
    LEFT_FAST: 'L',
    RIGHT_SLOW: 'r',
    RIGHT_FAST: 'R',
    STOP: 'S'
  });

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

    micStream: null,
    audioContext: null,
    audioSource: null,
    audioProcessor: null,
    audioMute: null,
    micEnabled: false,
    wakeStreamEnabled: false,

    recognition: null,
    recognitionBusy: false,
    tiltAngle: 90,

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
    reverseWidth: $('reverseWidth'),
    reverseWidthOut: $('reverseWidthOut'),
    fastTurnEdge: $('fastTurnEdge'),
    fastTurnEdgeOut: $('fastTurnEdgeOut'),

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

    wakeThreshold: $('wakeThreshold'),
    wakeThresholdOut: $('wakeThresholdOut'),
    tiltAngle: $('tiltAngle'),
    tiltAngleOut: $('tiltAngleOut'),

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
    const time = new Date().toLocaleTimeString([], {
      hour12: false
    });

    let line = `[${time}] ${message}`;

    if (data !== undefined) {
      try {
        line += ` ${
          typeof data === 'string'
            ? data
            : JSON.stringify(data)
        }`;
      } catch {
        line += ' [data]';
      }
    }

    console.log(line);

    el.eventLog.textContent =
      `${line}\n${el.eventLog.textContent}`.slice(0, 12000);
  }

  function status(node, text, kind = '') {
    node.textContent = text;
    node.classList.remove('good', 'bad');

    if (kind) {
      node.classList.add(kind);
    }
  }

  function clamp(number, minimum = 0, maximum = 1) {
    return Math.max(
      minimum,
      Math.min(maximum, Number(number) || 0)
    );
  }

  // Tabs

  function openTab(name) {
    el.tabs.forEach((button) => {
      button.classList.toggle(
        'active',
        button.dataset.tab === name
      );
    });

    el.debugView.classList.toggle(
      'active',
      name === 'debug'
    );

    el.panelView.classList.toggle(
      'active',
      name === 'panel'
    );
  }

  el.tabs.forEach((button) => {
    button.addEventListener('click', () => {
      openTab(button.dataset.tab);
    });
  });

  // Camera and target tracking

  async function startCamera() {
    if (state.cameraOn) {
      return;
    }

    try {
      state.cameraStream =
        await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: {
              exact: 'user'
            },
            width: {
              ideal: 640
            },
            height: {
              ideal: 480
            }
          },
          audio: false
        });
    } catch (exactError) {
      log(
        'Exact selfie camera failed; retrying preferred user camera',
        String(exactError)
      );

      state.cameraStream =
        await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: {
              ideal: 640
            },
            height: {
              ideal: 480
            }
          },
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

    sendAtlas({
      type: 'event',
      event: 'camera_ready'
    });

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

  function trackingLoop(timestamp) {
    if (!state.cameraOn) {
      return;
    }

    if (
      timestamp - state.lastTrackAt >=
      TRACK_INTERVAL_MS
    ) {
      state.lastTrackAt = timestamp;
      processTrackingFrame();
    }

    requestAnimationFrame(trackingLoop);
  }

  function processTrackingFrame() {
    const video = el.video;

    if (video.readyState < 2) {
      return;
    }

    const processCanvas = el.process;

    const context = processCanvas.getContext('2d', {
      willReadFrequently: true
    });

    context.drawImage(
      video,
      0,
      0,
      processCanvas.width,
      processCanvas.height
    );

    const frame = context.getImageData(
      0,
      0,
      processCanvas.width,
      processCanvas.height
    );

    const pixels = frame.data;
    const targetColor = parseHexColor(el.targetColor.value);
    const tolerance = Number(el.tolerance.value);
    const toleranceSquared = tolerance * tolerance;

    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minimumX = processCanvas.width;
    let maximumX = -1;
    let minimumY = processCanvas.height;
    let maximumY = -1;

    for (let y = 0; y < processCanvas.height; y++) {
      for (let x = 0; x < processCanvas.width; x++) {
        const index =
          (y * processCanvas.width + x) * 4;

        const redDifference =
          pixels[index] - targetColor.r;

        const greenDifference =
          pixels[index + 1] - targetColor.g;

        const blueDifference =
          pixels[index + 2] - targetColor.b;

        const colorDistance =
          redDifference * redDifference +
          greenDifference * greenDifference +
          blueDifference * blueDifference;

        if (colorDistance <= toleranceSquared) {
          count++;
          sumX += x;
          sumY += y;

          if (x < minimumX) {
            minimumX = x;
          }

          if (x > maximumX) {
            maximumX = x;
          }

          if (y < minimumY) {
            minimumY = y;
          }

          if (y > maximumY) {
            maximumY = y;
          }
        }
      }
    }

    const area =
      count /
      (processCanvas.width * processCanvas.height);

    if (!count || area < MIN_TARGET_AREA) {
      state.target = null;

      el.centroidStatus.textContent = '0.50';
      el.areaStatus.textContent = area.toFixed(3);
      el.widthStatus.textContent = '0%';

      if (state.tracking) {
        commandRobot(
          COMMAND.STOP,
          'no target'
        );
      }

      drawOverlay(null);
      sendTelemetryMaybe(null, area);
      return;
    }

    const centerX =
      (sumX / count) / processCanvas.width;

    const centerY =
      (sumY / count) / processCanvas.height;

    const targetWidth =
      (maximumX - minimumX + 1) /
      processCanvas.width;

    const targetHeight =
      (maximumY - minimumY + 1) /
      processCanvas.height;

    const reverseWidth =
      Number(el.reverseWidth.value) / 100;

    const fastTurnEdge =
      Number(el.fastTurnEdge.value) / 100;

    let command = COMMAND.FORWARD;

    if (targetWidth >= reverseWidth) {
      command = COMMAND.REVERSE;
    } else if (centerX < fastTurnEdge) {
      command = COMMAND.LEFT_FAST;
    } else if (centerX < LEFT_EDGE) {
      command = COMMAND.LEFT_SLOW;
    } else if (centerX > 1 - fastTurnEdge) {
      command = COMMAND.RIGHT_FAST;
    } else if (centerX > RIGHT_EDGE) {
      command = COMMAND.RIGHT_SLOW;
    }

    state.target = {
      cx: centerX,
      cy: centerY,
      area,
      width: targetWidth,
      height: targetHeight,
      minX: minimumX,
      maxX: maximumX,
      minY: minimumY,
      maxY: maximumY,
      cmd: command
    };

    el.centroidStatus.textContent =
      centerX.toFixed(2);

    el.areaStatus.textContent =
      area.toFixed(3);

    el.widthStatus.textContent =
      `${Math.round(targetWidth * 100)}%`;

    if (state.tracking) {
      commandRobot(command, 'tracker');
    }

    drawOverlay(state.target);
    sendTelemetryMaybe(state.target, area);
  }

  let lastTelemetryAt = 0;

  function sendTelemetryMaybe(target, area) {
    const now = performance.now();

    if (now - lastTelemetryAt < 500) {
      return;
    }

    lastTelemetryAt = now;

    sendAtlas({
      type: 'telemetry',
      tracking: state.tracking,
      command: state.lastCommand,

      target: target
        ? {
            x: +target.cx.toFixed(3),
            y: +target.cy.toFixed(3),
            area: +target.area.toFixed(4),
            width: +target.width.toFixed(3)
          }
        : null,

      area: +area.toFixed(4)
    });
  }

  function drawOverlay(target) {
    const canvas = el.overlay;
    const rectangle = canvas.getBoundingClientRect();

    const pixelRatio = Math.max(
      1,
      window.devicePixelRatio || 1
    );

    const width = Math.max(
      1,
      Math.round(rectangle.width * pixelRatio)
    );

    const height = Math.max(
      1,
      Math.round(rectangle.height * pixelRatio)
    );

    if (
      canvas.width !== width ||
      canvas.height !== height
    ) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext('2d');

    context.clearRect(
      0,
      0,
      width,
      height
    );

    if (!target) {
      return;
    }

    // Mirror the overlay so it matches the selfie preview.

    const left =
      (
        1 -
        (
          (target.maxX + 1) /
          el.process.width
        )
      ) * width;

    const right =
      (
        1 -
        (
          target.minX /
          el.process.width
        )
      ) * width;

    const top =
      (
        target.minY /
        el.process.height
      ) * height;

    const bottom =
      (
        (target.maxY + 1) /
        el.process.height
      ) * height;

    const centerX =
      (1 - target.cx) * width;

    const centerY =
      target.cy * height;

    context.strokeStyle = '#57d6ff';
    context.lineWidth = 2 * pixelRatio;

    context.setLineDash([
      6 * pixelRatio,
      4 * pixelRatio
    ]);

    context.beginPath();

    context.ellipse(
      (left + right) / 2,
      (top + bottom) / 2,
      (right - left) / 2,
      (bottom - top) / 2,
      0,
      0,
      Math.PI * 2
    );

    context.stroke();
    context.setLineDash([]);

    context.beginPath();

    context.moveTo(
      centerX - 8 * pixelRatio,
      centerY
    );

    context.lineTo(
      centerX + 8 * pixelRatio,
      centerY
    );

    context.moveTo(
      centerX,
      centerY - 8 * pixelRatio
    );

    context.lineTo(
      centerX,
      centerY + 8 * pixelRatio
    );

    context.stroke();

    const label =
      `TARGET ${
        Math.round(target.width * 100)
      }% ${target.cmd}`;

    context.font =
      `${11 * pixelRatio}px ui-monospace, monospace`;

    const textWidth =
      context.measureText(label).width;

    const textX = Math.max(
      6 * pixelRatio,
      Math.min(
        width - textWidth - 14 * pixelRatio,
        left
      )
    );

    const textY = Math.max(
      18 * pixelRatio,
      top - 7 * pixelRatio
    );

    context.fillStyle =
      'rgba(0,0,0,.74)';

    context.fillRect(
      textX - 5 * pixelRatio,
      textY - 13 * pixelRatio,
      textWidth + 10 * pixelRatio,
      18 * pixelRatio
    );

    context.fillStyle = '#e7f8ff';

    context.fillText(
      label,
      textX,
      textY
    );
  }

  function setTracking(on, source = 'ui') {
    state.tracking = Boolean(on);

    status(
      el.trackingStatus,
      on ? 'active' : 'paused',
      on ? 'good' : ''
    );

    el.trackingBtn.textContent =
      on
        ? 'Stop Tracking'
        : 'Start Tracking';

    if (!on) {
      commandRobot(
        COMMAND.STOP,
        'tracking off'
      );
    }

    sendAtlas({
      type: 'event',
      event: on
        ? 'tracking_started'
        : 'tracking_stopped',
      source
    });

    if (!state.panelLockedByAtlas) {
      setPanelState({
        mode: on ? 'following' : 'idle',
        message: on
          ? 'FOLLOWING'
          : 'SYSTEM READY'
      });
    }
  }

  // Bluetooth

  async function connectBle() {
    if (!navigator.bluetooth) {
      status(
        el.bleStatus,
        'Web Bluetooth unavailable',
        'bad'
      );

      log(
        'Web Bluetooth API not available in this browser'
      );

      return;
    }

    try {
      status(
        el.bleStatus,
        'select device...'
      );

      state.bleDevice =
        await navigator.bluetooth.requestDevice({
          filters: [
            {
              services: [BLE.service]
            }
          ],

          optionalServices: [
            BLE.service
          ]
        });

      state.bleDevice.addEventListener(
        'gattserverdisconnected',
        onBleDisconnected
      );

      status(
        el.bleStatus,
        'connecting...'
      );

      state.bleServer =
        await state.bleDevice.gatt.connect();

      const service =
        await state.bleServer.getPrimaryService(
          BLE.service
        );

      state.txChar =
        await service.getCharacteristic(
          BLE.tx
        );

      try {
        state.rxChar =
          await service.getCharacteristic(
            BLE.rx
          );

        await state.rxChar.startNotifications();

        state.rxChar.addEventListener(
          'characteristicvaluechanged',
          (event) => {
            const value =
              new TextDecoder()
                .decode(event.target.value)
                .trim();

            status(
              el.ackStatus,
              value || 'ACK',
              'good'
            );
          }
        );
      } catch (receiveError) {
        log(
          'RX notifications unavailable; TX still usable',
          String(receiveError)
        );
      }

      status(
        el.bleStatus,
        state.bleDevice.name || 'connected',
        'good'
      );

      el.connectBleBtn.textContent =
        'BLE Connected';

      el.panelBleInfo.textContent =
        'BLE OK';

      log(
        'BLE connected',
        state.bleDevice.name || 'device'
      );

      sendAtlas({
        type: 'event',
        event: 'ble_connected',
        name: state.bleDevice.name || null
      });
    } catch (error) {
      status(
        el.bleStatus,
        'connection failed',
        'bad'
      );

      el.panelBleInfo.textContent =
        'BLE --';

      log(
        'BLE connection error',
        String(error)
      );
    }
  }

  function onBleDisconnected() {
    state.txChar = null;
    state.rxChar = null;

    status(
      el.bleStatus,
      'disconnected',
      'bad'
    );

    el.connectBleBtn.textContent =
      'Connect BLE';

    el.panelBleInfo.textContent =
      'BLE --';

    log('BLE disconnected');

    sendAtlas({
      type: 'event',
      event: 'ble_disconnected'
    });
  }

  async function writeBle(command) {
    if (!state.txChar) {
      return false;
    }

    const bytes =
      new TextEncoder().encode(command);

    try {
      if (
        state.txChar.properties.writeWithoutResponse &&
        state.txChar.writeValueWithoutResponse
      ) {
        await state.txChar.writeValueWithoutResponse(
          bytes
        );
      } else if (
        state.txChar.writeValueWithResponse
      ) {
        await state.txChar.writeValueWithResponse(
          bytes
        );
      } else {
        await state.txChar.writeValue(
          bytes
        );
      }

      return true;
    } catch (error) {
      log(
        'BLE write failed',
        String(error)
      );

      return false;
    }
  }

  async function commandRobot(
    command,
    reason = ''
  ) {
    if (
      !Object.values(COMMAND).includes(command)
    ) {
      return;
    }

    const now = performance.now();

    const changed =
      command !== state.lastCommand;

    if (
      !changed &&
      now - state.lastBleSendAt <
        BLE_HEARTBEAT_MS
    ) {
      return;
    }

    state.lastCommand = command;
    state.lastBleSendAt = now;

    el.commandStatus.textContent =
      command;

    await writeBle(command);

    if (changed) {
      log(
        `CMD ${command}${
          reason
            ? ` (${reason})`
            : ''
        }`
      );

      sendAtlas({
        type: 'event',
        event: 'robot_command',
        command,
        reason
      });
    }
  }

  // Servo tilt

  let tiltTimer = null;

  function setTiltAngle(
    value,
    source = 'ui'
  ) {
    const angle = Math.round(
      clamp(value, 0, 180)
    );

    state.tiltAngle = angle;

    el.tiltAngle.value =
      String(angle);

    el.tiltAngleOut.textContent =
      `${angle}°`;

    localStorage.setItem(
      'iris_tilt_angle',
      String(angle)
    );

    clearTimeout(tiltTimer);

    tiltTimer = setTimeout(
      async () => {
        // Reserved Arduino command:
        // T followed by an angle from 0 to 180.
        await writeBle(`T${angle}`);

        log(
          `TILT ${angle}° (${source})`
        );

        sendAtlas({
          type: 'event',
          event: 'servo_tilt',
          angle,
          source
        });
      },
      source === 'ui' ? 90 : 0
    );
  }

  // Microphone streaming

  function updateMicLevel(level) {
    const percentage =
      Math.round(clamp(level) * 100);

    el.micMeter.style.width =
      `${Math.max(2, percentage)}%`;

    if (
      !state.panelLockedByAtlas &&
      state.currentPanelState.mode ===
        'listening'
    ) {
      document.documentElement.style.setProperty(
        '--speech-level',
        String(clamp(level))
      );
    }
  }

  async function enableAudio() {
    if (state.micEnabled) {
      return true;
    }

    try {
      state.micStream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },

          video: false
        });

      const AudioContextClass =
        window.AudioContext ||
        window.webkitAudioContext;

      state.audioContext =
        new AudioContextClass();

      await state.audioContext.resume();

      state.audioSource =
        state.audioContext.createMediaStreamSource(
          state.micStream
        );

      state.audioProcessor =
        state.audioContext.createScriptProcessor(
          4096,
          1,
          1
        );

      state.audioMute =
        state.audioContext.createGain();

      state.audioMute.gain.value = 0;

      state.audioProcessor.onaudioprocess =
        (event) => {
          const data =
            event.inputBuffer.getChannelData(0);

          let sum = 0;

          for (const sample of data) {
            sum += sample * sample;
          }

          updateMicLevel(
            clamp(
              Math.sqrt(
                sum / data.length
              ) * 4.5
            )
          );

          if (
            state.wakeStreamEnabled &&
            state.atlasSocket?.readyState ===
              WebSocket.OPEN
          ) {
            const resampled =
              resampleTo16k(
                data,
                state.audioContext.sampleRate
              );

            state.atlasSocket.send(
              floatToPcm16(resampled)
            );
          }
        };

      state.audioSource.connect(
        state.audioProcessor
      );

      state.audioProcessor
        .connect(state.audioMute)
        .connect(
          state.audioContext.destination
        );

      state.micEnabled = true;

      status(
        el.micStatus,
        'live',
        'good'
      );

      el.panelMicInfo.textContent =
        'MIC OK';

      el.audioBtn.textContent =
        'Audio Enabled';

      el.audioBtn.disabled = true;

      log(
        `Microphone enabled at ${
          state.audioContext.sampleRate
        } Hz`
      );

      return true;
    } catch (error) {
      status(
        el.micStatus,
        'permission/error',
        'bad'
      );

      el.panelMicInfo.textContent =
        'MIC --';

      log(
        'Microphone error',
        String(error)
      );

      return false;
    }
  }

  function resampleTo16k(
    input,
    inputRate
  ) {
    if (inputRate === 16000) {
      return input;
    }

    const ratio =
      inputRate / 16000;

    const length = Math.max(
      1,
      Math.round(input.length / ratio)
    );

    const output =
      new Float32Array(length);

    for (let index = 0; index < length; index++) {
      const start = Math.floor(
        index * ratio
      );

      const end = Math.min(
        input.length,
        Math.floor(
          (index + 1) * ratio
        )
      );

      let sum = 0;

      for (
        let sampleIndex = start;
        sampleIndex < end;
        sampleIndex++
      ) {
        sum += input[sampleIndex];
      }

      output[index] =
        sum / Math.max(1, end - start);
    }

    return output;
  }

  function floatToPcm16(input) {
    const pcm =
      new Int16Array(input.length);

    for (
      let index = 0;
      index < input.length;
      index++
    ) {
      const sample = Math.max(
        -1,
        Math.min(1, input[index])
      );

      pcm[index] =
        sample < 0
          ? sample * 32768
          : sample * 32767;
    }

    return pcm.buffer;
  }

  // Two-tone sound

  let toneContext = null;

  async function playAckTone() {
    try {
      const AudioContextClass =
        window.AudioContext ||
        window.webkitAudioContext;

      toneContext =
        toneContext ||
        new AudioContextClass();

      if (
        toneContext.state === 'suspended'
      ) {
        await toneContext.resume();
      }

      const now =
        toneContext.currentTime;

      const notes = [
        659.25,
        880
      ];

      notes.forEach(
        (frequency, index) => {
          const oscillator =
            toneContext.createOscillator();

          const gain =
            toneContext.createGain();

          oscillator.type = 'sine';
          oscillator.frequency.value =
            frequency;

          const start =
            now + index * 0.115;

          const stop =
            start + 0.12;

          gain.gain.setValueAtTime(
            0.0001,
            start
          );

          gain.gain.exponentialRampToValueAtTime(
            0.16,
            start + 0.012
          );

          gain.gain.exponentialRampToValueAtTime(
            0.0001,
            stop
          );

          oscillator
            .connect(gain)
            .connect(
              toneContext.destination
            );

          oscillator.start(start);
          oscillator.stop(stop + 0.02);
        }
      );
    } catch (error) {
      log(
        'Tone error',
        String(error)
      );
    }
  }

  // Speech output

  function speakText(
    text,
    options = {}
  ) {
    const clean =
      String(text || '').trim();

    if (!clean) {
      return;
    }

    el.lastReply.textContent =
      clean;

    if (
      !('speechSynthesis' in window)
    ) {
      log(
        'Speech synthesis unavailable'
      );

      return;
    }

    window.speechSynthesis.cancel();

    const utterance =
      new SpeechSynthesisUtterance(
        clean
      );

    utterance.rate =
      options.rate || 0.96;

    utterance.pitch =
      options.pitch || 0.96;

    utterance.volume =
      options.volume || 1;

    utterance.onstart = () => {
      status(
        el.voiceStatus,
        'speaking',
        'good'
      );

      if (!state.panelLockedByAtlas) {
        setPanelState({
          mode: 'speaking',
          message: clean.slice(0, 46),
          speechLevel: 0.72
        });
      }
    };

    utterance.onend = () => {
      status(
        el.voiceStatus,
        'idle'
      );

      if (!state.panelLockedByAtlas) {
        setPanelState({
          mode: state.tracking
            ? 'following'
            : 'idle',

          message: state.tracking
            ? 'FOLLOWING'
            : 'SYSTEM READY',

          speechLevel: 0.08
        });
      }
    };

    utterance.onerror = (event) => {
      log(
        'Speech output error',
        event.error || 'unknown'
      );
    };

    window.speechSynthesis.speak(
      utterance
    );
  }

  // Server-side openWakeWord

  async function startWakeWord() {
    if (state.wakeStreamEnabled) {
      return;
    }

    if (
      !state.atlasSocket ||
      state.atlasSocket.readyState !==
        WebSocket.OPEN
    ) {
      status(
        el.wakeStatus,
        'connect ATLAS first',
        'bad'
      );

      log(
        'openWakeWord requires the ATLAS WebSocket'
      );

      return;
    }

    if (!(await enableAudio())) {
      return;
    }

    const threshold =
      Number(el.wakeThreshold.value);

    localStorage.setItem(
      'iris_wake_threshold',
      String(threshold)
    );

    state.wakeStreamEnabled = true;

    sendAtlas({
      type: 'audio_start',
      format: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      threshold
    });

    status(
      el.wakeStatus,
      'listening on ATLAS',
      'good'
    );

    el.wakeBtn.textContent =
      '“Hey Atlas” Listening';

    el.wakeBtn.disabled = true;

    log(
      'Streaming 16 kHz PCM audio to ATLAS openWakeWord'
    );
  }

  async function onWakeWordDetected(
    label = 'Hey Atlas'
  ) {
    log(
      'Wake word detected',
      label
    );

    status(
      el.wakeStatus,
      'detected',
      'good'
    );

    el.panelLastHeard.textContent =
      'HEY ATLAS';

    if (!state.panelLockedByAtlas) {
      setPanelState({
        mode: 'listening',
        mood: 'focused',
        attention: 1,
        message: 'LISTENING'
      });
    }

    await playAckTone();

    if (getSpeechRecognitionConstructor()) {
      setTimeout(
        () => listenForSpeechAfterWake(),
        120
      );
    }
  }

  function getSpeechRecognitionConstructor() {
    return (
      window.SpeechRecognition ||
      window.webkitSpeechRecognition ||
      null
    );
  }

  async function listenForSpeechAfterWake() {
    return listenOnce(true);
  }

  async function listenOnce(
    fromWake = false
  ) {
    if (state.recognitionBusy) {
      return;
    }

    const Recognition =
      getSpeechRecognitionConstructor();

    if (!Recognition) {
      status(
        el.voiceStatus,
        'speech recognition unavailable',
        'bad'
      );

      speakText(
        'Speech recognition is not available in this browser.'
      );

      return;
    }

    state.recognitionBusy = true;

    const recognition =
      new Recognition();

    state.recognition =
      recognition;

    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      status(
        el.voiceStatus,
        'listening',
        'good'
      );

      if (!state.panelLockedByAtlas) {
        setPanelState({
          mode: 'listening',
          message: 'LISTENING',
          attention: 1
        });
      }
    };

    recognition.onresult = (event) => {
      const text =
        event.results?.[0]?.[0]
          ?.transcript?.trim() || '';

      if (text) {
        handleTranscript(
          text,
          fromWake
        );
      }
    };

    recognition.onerror = (event) => {
      if (
        event.error !== 'no-speech' &&
        event.error !== 'aborted'
      ) {
        log(
          'Speech recognition error',
          event.error
        );
      }

      status(
        el.voiceStatus,
        event.error ||
          'recognition error',
        'bad'
      );
    };

    recognition.onend = () => {
      state.recognitionBusy = false;
      state.recognition = null;

      if (
        el.voiceStatus.textContent ===
        'listening'
      ) {
        status(
          el.voiceStatus,
          'idle'
        );
      }
    };

    try {
      recognition.start();
    } catch (error) {
      state.recognitionBusy = false;

      log(
        'Could not start speech recognition',
        String(error)
      );
    }
  }

  function handleTranscript(
    rawText,
    fromWake
  ) {
    let text =
      rawText.trim();

    text =
      text
        .replace(
          /^hey\s+atlas[,.!?\s-]*/i,
          ''
        )
        .trim() ||
      rawText.trim();

    el.lastTranscript.textContent =
      text;

    el.panelLastHeard.textContent =
      text.toUpperCase().slice(0, 48);

    status(
      el.voiceStatus,
      'understood',
      'good'
    );

    log(
      'Voice transcript',
      text
    );

    sendAtlas({
      type: 'event',
      event: 'transcript',
      text,
      fromWake: Boolean(fromWake)
    });

    routeVoiceIntent(text);
  }

  function routeVoiceIntent(text) {
    const normalized =
      text
        .toLowerCase()
        .replace(
          /[^a-z0-9\s']/g,
          ' '
        )
        .replace(
          /\s+/g,
          ' '
        )
        .trim();

    if (
      /\b(stop|halt|freeze|emergency stop)\b/.test(
        normalized
      )
    ) {
      setTracking(
        false,
        'voice'
      );

      commandRobot(
        COMMAND.STOP,
        'voice stop'
      );

      speakText('Stopped.');
      return;
    }

    if (
      /\b(follow me|start following|follow)\b/.test(
        normalized
      )
    ) {
      setTracking(
        true,
        'voice'
      );

      speakText('Following.');
      return;
    }

    if (
      /\b(go forward|move forward|forward)\b/.test(
        normalized
      )
    ) {
      commandRobot(
        COMMAND.FORWARD,
        'voice manual'
      );

      return;
    }

    if (
      /\b(go backward|move backward|back up|reverse)\b/.test(
        normalized
      )
    ) {
      commandRobot(
        COMMAND.REVERSE,
        'voice manual'
      );

      return;
    }

    if (
      /\b(turn left|go left|left)\b/.test(
        normalized
      )
    ) {
      const command =
        /\b(fast|sharp|pivot)\b/.test(
          normalized
        )
          ? COMMAND.LEFT_FAST
          : COMMAND.LEFT_SLOW;

      commandRobot(
        command,
        'voice manual'
      );

      return;
    }

    if (
      /\b(turn right|go right|right)\b/.test(
        normalized
      )
    ) {
      const command =
        /\b(fast|sharp|pivot)\b/.test(
          normalized
        )
          ? COMMAND.RIGHT_FAST
          : COMMAND.RIGHT_SLOW;

      commandRobot(
        command,
        'voice manual'
      );

      return;
    }

    if (
      sendAtlas({
        type: 'utterance',
        text,
        source: 'voice'
      })
    ) {
      status(
        el.voiceStatus,
        'sent to ATLAS',
        'good'
      );

      if (!state.panelLockedByAtlas) {
        setPanelState({
          mode: 'thinking',
          message: 'THINKING'
        });
      }
    } else {
      speakText(
        'Atlas link is not connected.'
      );
    }
  }

  // ATLAS WebSocket

  function connectAtlas() {
    const url =
      el.atlasWsUrl.value.trim();

    if (!url) {
      status(
        el.atlasStatus,
        'URL needed',
        'bad'
      );

      return;
    }

    localStorage.setItem(
      'iris_atlas_ws',
      url
    );

    try {
      if (state.atlasSocket) {
        state.atlasSocket.close();
      }

      status(
        el.atlasStatus,
        'connecting...'
      );

      const socket =
        new WebSocket(url);

      socket.binaryType =
        'arraybuffer';

      state.atlasSocket =
        socket;

      socket.onopen = () => {
        status(
          el.atlasStatus,
          'online',
          'good'
        );

        el.panelAtlasInfo.textContent =
          'LINK OK';

        log(
          'ATLAS WebSocket connected'
        );

        sendAtlas({
          type: 'hello',
          client: 'IRIS-web-v5',

          capabilities: [
            'panel',
            'tts',
            'voice',
            'ble',
            'tracking',
            'camera-telemetry',
            'pcm16-audio',
            'openwakeword',
            'servo-tilt'
          ]
        });
      };

      socket.onmessage = (event) => {
        let message;

        try {
          message =
            JSON.parse(event.data);
        } catch {
          message = {
            type: 'tts',
            text: String(event.data)
          };
        }

        handleAtlasMessage(message);
      };

      socket.onerror = () => {
        status(
          el.atlasStatus,
          'socket error',
          'bad'
        );
      };

      socket.onclose = () => {
        if (
          state.atlasSocket === socket
        ) {
          state.atlasSocket = null;
        }

        status(
          el.atlasStatus,
          'offline',
          'bad'
        );

        el.panelAtlasInfo.textContent =
          'LINK --';

        state.panelLockedByAtlas =
          false;

        state.wakeStreamEnabled =
          false;

        status(
          el.wakeStatus,
          'off',
          'bad'
        );

        el.wakeBtn.textContent =
          'Start “Hey Atlas”';

        el.wakeBtn.disabled = false;

        log(
          'ATLAS WebSocket disconnected'
        );
      };
    } catch (error) {
      status(
        el.atlasStatus,
        'connection failed',
        'bad'
      );

      log(
        'ATLAS connection error',
        String(error)
      );
    }
  }

  function disconnectAtlas() {
    if (state.atlasSocket) {
      state.atlasSocket.close(
        1000,
        'user disconnect'
      );
    }

    state.atlasSocket = null;
    state.panelLockedByAtlas = false;
    state.wakeStreamEnabled = false;

    status(
      el.atlasStatus,
      'offline',
      'bad'
    );

    status(
      el.wakeStatus,
      'off',
      'bad'
    );

    el.wakeBtn.textContent =
      'Start “Hey Atlas”';

    el.wakeBtn.disabled =
      false;

    el.panelAtlasInfo.textContent =
      'LINK --';
  }

  function sendAtlas(message) {
    const socket =
      state.atlasSocket;

    if (
      !socket ||
      socket.readyState !==
        WebSocket.OPEN
    ) {
      return false;
    }

    socket.send(
      JSON.stringify({
        ...message,
        ts: Date.now()
      })
    );

    return true;
  }

  function handleAtlasMessage(message) {
    if (
      !message ||
      typeof message !== 'object'
    ) {
      return;
    }

    log(
      'ATLAS -> IRIS',
      message
    );

    switch (message.type) {
      case 'panel_state':
      case 'panel':
        setPanelState(
          message.state || message,
          'atlas'
        );
        break;

      case 'response':
      case 'reply':
      case 'tts': {
        const text =
          message.text ||
          message.reply ||
          '';

        if (text) {
          speakText(
            text,
            message.voice || {}
          );
        }

        if (message.panel) {
          setPanelState(
            message.panel,
            'atlas'
          );
        }

        break;
      }

      case 'command': {
        const command =
          String(
            message.command || ''
          );

        if (
          Object.values(COMMAND).includes(
            command
          )
        ) {
          commandRobot(
            command,
            'ATLAS'
          );
        }

        break;
      }

      case 'wake_word_detected':
        onWakeWordDetected(
          message.label ||
            'Hey Atlas'
        );
        break;

      case 'wake_word_online':
        status(
          el.wakeStatus,
          'listening on ATLAS',
          'good'
        );
        break;

      case 'transcript':
        if (message.text) {
          handleTranscript(
            String(message.text),
            true
          );
        }
        break;

      case 'tilt':
      case 'servo_tilt':
        setTiltAngle(
          message.angle,
          'ATLAS'
        );
        break;

      case 'error':
        status(
          el.atlasStatus,
          message.code ||
            'bridge error',
          'bad'
        );

        if (message.message) {
          el.lastReply.textContent =
            message.message;
        }
        break;

      case 'tracking':
        setTracking(
          Boolean(message.enabled),
          'atlas'
        );
        break;

      case 'tone':
        playAckTone();
        break;

      default:
        break;
    }
  }

  // Droid panel

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
    idle: {
      energy: 0.30,
      attention: 0.38,
      speechLevel: 0.06,
      message: 'SYSTEM READY'
    },

    listening: {
      energy: 0.48,
      attention: 0.95,
      speechLevel: 0.28,
      message: 'LISTENING'
    },

    thinking: {
      energy: 0.58,
      attention: 0.82,
      speechLevel: 0.08,
      message: 'THINKING'
    },

    speaking: {
      energy: 0.78,
      attention: 0.72,
      speechLevel: 0.75,
      message: 'RESPONDING'
    },

    following: {
      energy: 0.74,
      attention: 0.92,
      speechLevel: 0.05,
      message: 'FOLLOWING'
    },

    searching: {
      energy: 0.54,
      attention: 0.78,
      speechLevel: 0.04,
      message: 'SEARCHING'
    },

    success: {
      energy: 0.82,
      attention: 0.65,
      speechLevel: 0.10,
      message: 'COMPLETE'
    },

    warning: {
      energy: 0.90,
      attention: 1,
      speechLevel: 0.04,
      message: 'WARNING'
    },

    error: {
      energy: 0.35,
      attention: 1,
      speechLevel: 0.02,
      message: 'FAULT'
    },

    sleeping: {
      energy: 0.05,
      attention: 0.05,
      speechLevel: 0.01,
      message: 'STANDBY'
    }
  };

  function setPanelState(
    patch,
    source = 'local'
  ) {
    if (
      source === 'local' &&
      state.panelLockedByAtlas
    ) {
      return;
    }

    if (source === 'atlas') {
      state.panelLockedByAtlas =
        true;
    }

    const requestedMode =
      String(
        patch.mode ||
        state.currentPanelState.mode ||
        'idle'
      ).toLowerCase();

    const mode =
      MODE_DEFAULTS[requestedMode]
        ? requestedMode
        : 'idle';

    const defaults =
      MODE_DEFAULTS[mode];

    const next = {
      ...state.currentPanelState,
      ...defaults,
      ...patch,
      mode,

      mood: String(
        patch.mood ||
        state.currentPanelState.mood ||
        'calm'
      ).toLowerCase()
    };

    state.currentPanelState =
      next;

    [
      ...el.droidShell.classList
    ].forEach((className) => {
      if (
        className.startsWith('state-') ||
        className.startsWith('mood-')
      ) {
        el.droidShell.classList.remove(
          className
        );
      }
    });

    el.droidShell.classList.add(
      `state-${mode}`,
      `mood-${next.mood}`
    );

    const root =
      document.documentElement;

    root.style.setProperty(
      '--panel-brightness',
      String(
        clamp(
          next.brightness ?? 1,
          0.15,
          1.6
        )
      )
    );

    root.style.setProperty(
      '--speech-level',
      String(clamp(next.speechLevel))
    );

    root.style.setProperty(
      '--energy-level',
      String(clamp(next.energy))
    );

    root.style.setProperty(
      '--attention-level',
      String(clamp(next.attention))
    );

    if (next.color) {
      root.style.setProperty(
        '--zone-color',
        next.color
      );

      root.style.setProperty(
        '--zone-glow',
        next.glowColor ||
          hexToGlow(
            next.color,
            0.72
          )
      );
    } else {
      root.style.removeProperty(
        '--zone-color'
      );

      root.style.removeProperty(
        '--zone-glow'
      );
    }

    el.panelModeLabel.textContent =
      mode.toUpperCase();

    el.panelMessage.textContent =
      String(
        next.message ||
        defaults.message ||
        ''
      )
        .toUpperCase()
        .slice(0, 64);

    el.centerGlyph.textContent =
      patch.glyph ||
      MODE_GLYPH[mode] ||
      '•••';

    el.bar1Fill.style.width =
      `${Math.round(
        clamp(next.energy) * 100
      )}%`;

    const secondBarValue =
      mode === 'speaking'
        ? next.speechLevel
        : next.attention;

    el.bar2Fill.style.width =
      `${Math.round(
        clamp(secondBarValue) * 100
      )}%`;

    if (
      patch.zones &&
      typeof patch.zones === 'object'
    ) {
      applyZoneOverrides(
        patch.zones
      );
    } else {
      clearZoneOverrides();
    }
  }

  function hexToGlow(
    hex,
    alpha = 0.7
  ) {
    const color =
      parseHexColor(hex);

    return (
      `rgba(` +
      `${color.r},` +
      `${color.g},` +
      `${color.b},` +
      `${alpha})`
    );
  }

  function clearZoneOverrides() {
    qsa('[data-zone]').forEach(
      (zone) => {
        zone.style.removeProperty(
          'background'
        );

        zone.style.removeProperty(
          'border-color'
        );

        zone.style.removeProperty(
          'box-shadow'
        );

        zone.style.removeProperty(
          'opacity'
        );

        zone.style.removeProperty(
          'filter'
        );
      }
    );
  }

  function applyZoneOverrides(zones) {
    clearZoneOverrides();

    qsa('[data-zone]').forEach(
      (zone) => {
        const configuration =
          zones[zone.dataset.zone];

        if (!configuration) {
          return;
        }

        if (configuration.color) {
          zone.style.background =
            configuration.color;

          zone.style.borderColor =
            configuration.color;

          zone.style.boxShadow =
            `0 0 16px ${
              configuration.color
            }`;
        }

        if (
          configuration.opacity !==
          undefined
        ) {
          zone.style.opacity =
            String(
              clamp(
                configuration.opacity
              )
            );
        }

        if (
          configuration.brightness !==
          undefined
        ) {
          zone.style.filter =
            `brightness(${
              clamp(
                configuration.brightness,
                0,
                2.5
              )
            })`;
        }
      }
    );
  }

  // Button events

  el.connectBleBtn.addEventListener(
    'click',
    connectBle
  );

  el.cameraBtn.addEventListener(
    'click',
    startCamera
  );

  el.trackingBtn.addEventListener(
    'click',
    () => {
      setTracking(
        !state.tracking
      );
    }
  );

  el.audioBtn.addEventListener(
    'click',
    enableAudio
  );

  el.wakeBtn.addEventListener(
    'click',
    startWakeWord
  );

  el.listenOnceBtn.addEventListener(
    'click',
    () => listenOnce(false)
  );

  el.testToneBtn.addEventListener(
    'click',
    playAckTone
  );

  el.speakBtn.addEventListener(
    'click',
    () => {
      speakText(
        el.ttsInput.value
      );
    }
  );

  el.ttsInput.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') {
        speakText(
          el.ttsInput.value
        );
      }
    }
  );

  el.atlasConnectBtn.addEventListener(
    'click',
    connectAtlas
  );

  el.atlasDisconnectBtn.addEventListener(
    'click',
    disconnectAtlas
  );

  qsa('[data-manual]').forEach(
    (button) => {
      button.addEventListener(
        'click',
        () => {
          commandRobot(
            button.dataset.manual,
            'manual button'
          );
        }
      );
    }
  );

  qsa('[data-demo-state]').forEach(
    (button) => {
      button.addEventListener(
        'click',
        () => {
          state.panelLockedByAtlas =
            false;

          setPanelState(
            {
              mode:
                button.dataset.demoState
            },
            'demo'
          );

          openTab('panel');
        }
      );
    }
  );

  el.tolerance.addEventListener(
    'input',
    () => {
      el.toleranceOut.textContent =
        el.tolerance.value;

      localStorage.setItem(
        'iris_tolerance',
        el.tolerance.value
      );
    }
  );

  el.reverseWidth.addEventListener(
    'input',
    () => {
      el.reverseWidthOut.textContent =
        `${el.reverseWidth.value}%`;

      localStorage.setItem(
        'iris_reverse_width',
        el.reverseWidth.value
      );
    }
  );

  el.fastTurnEdge.addEventListener(
    'input',
    () => {
      el.fastTurnEdgeOut.textContent =
        `${el.fastTurnEdge.value}%`;

      localStorage.setItem(
        'iris_fast_turn_edge',
        el.fastTurnEdge.value
      );
    }
  );

  el.targetColor.addEventListener(
    'input',
    () => {
      localStorage.setItem(
        'iris_target_color',
        el.targetColor.value
      );
    }
  );

  el.wakeThreshold.addEventListener(
    'input',
    () => {
      el.wakeThresholdOut.textContent =
        Number(
          el.wakeThreshold.value
        ).toFixed(2);

      localStorage.setItem(
        'iris_wake_threshold',
        el.wakeThreshold.value
      );
    }
  );

  el.tiltAngle.addEventListener(
    'input',
    () => {
      setTiltAngle(
        el.tiltAngle.value
      );
    }
  );

  window.addEventListener(
    'resize',
    () => drawOverlay(state.target)
  );

  // Saved settings

  function restoreSettings() {
    const saved = {
      color:
        localStorage.getItem(
          'iris_target_color'
        ),

      tolerance:
        localStorage.getItem(
          'iris_tolerance'
        ),

      reverseWidth:
        localStorage.getItem(
          'iris_reverse_width'
        ) ||
        localStorage.getItem(
          'iris_stop_width'
        ),

      fastTurnEdge:
        localStorage.getItem(
          'iris_fast_turn_edge'
        ),

      threshold:
        localStorage.getItem(
          'iris_wake_threshold'
        ),

      tiltAngle:
        localStorage.getItem(
          'iris_tilt_angle'
        ),

      webSocket:
        localStorage.getItem(
          'iris_atlas_ws'
        )
    };

    if (saved.color) {
      el.targetColor.value =
        saved.color;
    }

    if (saved.tolerance) {
      el.tolerance.value =
        saved.tolerance;
    }

    if (saved.reverseWidth) {
      el.reverseWidth.value =
        saved.reverseWidth;
    }

    if (saved.fastTurnEdge) {
      el.fastTurnEdge.value =
        saved.fastTurnEdge;
    }

    if (saved.threshold) {
      el.wakeThreshold.value =
        saved.threshold;
    }

    if (saved.tiltAngle) {
      state.tiltAngle =
        Number(saved.tiltAngle);
    }

    if (saved.webSocket) {
      el.atlasWsUrl.value =
        saved.webSocket;
    }

    el.toleranceOut.textContent =
      el.tolerance.value;

    el.reverseWidthOut.textContent =
      `${el.reverseWidth.value}%`;

    el.fastTurnEdgeOut.textContent =
      `${el.fastTurnEdge.value}%`;

    el.wakeThresholdOut.textContent =
      Number(
        el.wakeThreshold.value
      ).toFixed(2);

    el.tiltAngle.value =
      String(state.tiltAngle);

    el.tiltAngleOut.textContent =
      `${state.tiltAngle}°`;
  }

  restoreSettings();

  setPanelState(
    state.currentPanelState,
    'local'
  );

  log('IRIS v5 loaded');
  log(
    'Commands: F / B / l / L / r / R / S'
  );

  window.IRIS = {
    setPanelState: (panelState) => {
      setPanelState(
        panelState,
        'atlas'
      );
    },

    speak: speakText,

    sendCommand: (command) => {
      commandRobot(
        String(command),
        'window.IRIS'
      );
    },

    setTilt: (angle) => {
      setTiltAngle(
        angle,
        'window.IRIS'
      );
    },

    startTracking: () => {
      setTracking(
        true,
        'window.IRIS'
      );
    },

    stopTracking: () => {
      setTracking(
        false,
        'window.IRIS'
      );
    },

    state
  };
})();