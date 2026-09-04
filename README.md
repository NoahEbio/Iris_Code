IRIS / ATLAS Web v4

This is the web-only version for the iPhone/Bluefy + GitHub Pages setup. No Swift is used.

What changed

Two views: DEBUG and PANEL.

DEBUG preserves the Iris v3 dark mobile layout and the existing target-tracking controls.

PANEL is the astromech-style faceplate display based on the sketch, with separate light zones, meters, animations, status text, and ATLAS-controlled panel state.

Selfie/front camera tracking is preserved.

BLE protocol is preserved as single-character F / L / R / S commands.

Audio input is integrated.

Picovoice Porcupine wake-word support for “Hey Atlas” is integrated.

The two-tone wake acknowledgement is integrated.

Browser speech recognition is used after the wake word.

Browser speech synthesis is used for ATLAS voice output.

Optional WebSocket connection lets the PC-side ATLAS process control the panel, send spoken replies, send robot commands, and start/stop tracking.

Upload to the existing GitHub Pages repository

Upload/replace these files at the repository root:

index.html

style.css

iris.js

models/README.txt

You can also add the optional Picovoice model files under models/ as described below.

First run on the iPhone

Open the GitHub Pages URL in Bluefy.

Open DEBUG.

Tap Start Camera and approve camera permission.

Tap Connect BLE and select the Iris Arduino.

Tap Enable Audio and approve microphone permission.

Paste a Picovoice AccessKey in the Porcupine setup box.

Tap Start “Hey Atlas”.

Say: Hey Atlas, follow me.

The key is stored only in that browser's local storage by this code; it is not written into the repository.

Porcupine models

The app first looks for:

models/porcupine_params.pv

models/hey_atlas_wasm.ppn

If porcupine_params.pv is not in the repo, it uses Picovoice's official parameter model directly from their GitHub repository.

If hey_atlas_wasm.ppn is not in the repo, the app uses Picovoice's model API to train “Hey Atlas” at startup using the AccessKey. For the most reliable long-term setup, generate a custom Web (WASM) Hey Atlas keyword in Picovoice Console and upload it as models/hey_atlas_wasm.ppn.

ATLAS WebSocket protocol

Enter a WebSocket URL in DEBUG and tap Connect ATLAS. If the phone page is served over HTTPS (GitHub Pages), use a wss:// endpoint. Most browsers block an insecure ws:// endpoint from an HTTPS page.

Phone -> ATLAS

Wake word:

{"type":"event","event":"wake_word_detected","label":"Hey Atlas"}

User speech:

{"type":"utterance","text":"What is the circumference of Earth?","source":"voice"}

Tracking telemetry:

{
  "type":"telemetry",
  "tracking":true,
  "command":"F",
  "target":{"x":0.51,"y":0.48,"area":0.08,"width":0.27}
}

ATLAS -> Phone

Make the phone speak:

{"type":"tts","text":"Earth's equatorial circumference is about 40,075 kilometers."}

Control the whole droid panel:

{
  "type":"panel_state",
  "state":{
    "mode":"thinking",
    "mood":"curious",
    "message":"CALCULATING",
    "energy":0.62,
    "attention":0.91,
    "brightness":1.0
  }
}

Use a custom color:

{
  "type":"panel_state",
  "state":{
    "mode":"speaking",
    "color":"#47ffd1",
    "message":"RESPONDING",
    "speechLevel":0.8
  }
}

Control individual zones:

{
  "type":"panel_state",
  "state":{
    "mode":"idle",
    "zones":{
      "orb1":{"color":"#ffffff","brightness":1.5},
      "orb2":{"color":"#ffb52e","brightness":0.6},
      "square1":{"color":"#63d8ff","brightness":1.2}
    }
  }
}

Available zone names:

wedgeLeft, wedgeRight, pillar, orb1, orb2, orb3, square1, square2, center, bar1, bar2.

ATLAS can also send an existing robot command:

{"type":"command","command":"S"}

or control follow mode:

{"type":"tracking","enabled":true}

Built-in voice command routing

These bypass the LLM for low latency:

follow me -> starts target tracking

stop, halt, freeze, emergency stop -> stops tracking and sends S

forward, turn left, turn right -> direct F/L/R command

Anything else is sent to ATLAS over the configured WebSocket.

Important compatibility note

This version intentionally keeps the current Arduino-facing protocol at F / L / R / S. It does not invent a new reverse byte or motor-speed protocol, so it should not require an Arduino change just to test the new screen/audio system.
