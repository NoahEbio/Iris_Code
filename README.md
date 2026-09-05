# IRIS / ATLAS Web v5

IRIS is a web-only iPhone/Bluefy controller for the Iris rover.

The phone performs fast local camera tracking and sends motor commands over BLE. ATLAS handles wake-word detection, higher-level voice requests, speech replies, and the animated panel over WebSocket.

## Included

- DEBUG and PANEL tabs
- Mirrored front/selfie camera
- Target outline and tracking information
- Selectable target color and tolerance
- Forward, reverse, slow-turn, fast-turn, and stop commands
- Two-tone wake acknowledgement
- Server-side openWakeWord audio processing
- No Picovoice key required
- Configurable ATLAS WebSocket
- ATLAS-controlled panel, speech, tracking, and motor commands
- Future camera-tilt servo support
- Python openWakeWord bridge

## Repository structure

```text
Iris_Code/
├── index.html
├── style.css
├── iris.js
├── README.md
├── .gitignore
└── atlas_bridge/
    ├── server.py
    ├── requirements.txt
    └── .env.example
```

## Phone setup

1. Open the GitHub Pages URL in Bluefy.
2. Open the DEBUG tab.
3. Tap **Start Camera**.
4. Approve camera access.
5. Tap **Connect BLE**.
6. Select the Iris Arduino.
7. Enter the ATLAS WebSocket URL.
8. Tap **Connect ATLAS**.
9. Tap **Enable Audio**.
10. Tap **Start “Hey Atlas.”**

## Secure WebSocket requirement

GitHub Pages uses HTTPS. Therefore, the phone must connect to ATLAS using:

```text
wss://
```

An insecure connection beginning with `ws://` will normally be blocked.

The ATLAS bridge can later be placed behind Tailscale Serve, Caddy, Cloudflare Tunnel, or another secure reverse proxy.

Do not expose the bridge directly to the public internet without authentication.

## ATLAS bridge setup

Run the bridge on PODIUM.

```bash
cd atlas_bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

The `.env` file is intentionally excluded from GitHub.

## openWakeWord model

Download or train an openWakeWord model for:

```text
Hey Atlas
```

Set `OPENWAKEWORD_MODEL` in `.env` to the model’s location.

Example:

```env
OPENWAKEWORD_MODEL=models/hey_atlas.onnx
```

openWakeWord does not currently include a stock “Hey Atlas” model, so a custom `.onnx` or `.tflite` model is required.

## Starting the bridge

Load the environment variables:

```bash
set -a
source .env
set +a
```

Start the server:

```bash
python server.py
```

The default local address is:

```text
ws://127.0.0.1:8765
```

The phone will eventually use a secure `wss://` address provided through the Tailscale or reverse-proxy configuration.

## ATLAS connection

`ATLAS_HTTP_URL` is the address where the bridge sends spoken questions.

Example:

```env
ATLAS_HTTP_URL=http://127.0.0.1:8000/iris
```

The bridge sends:

```json
{
  "text": "What is the circumference of Earth?",
  "source": "iris",
  "client": "IRIS-web-v5"
}
```

The ATLAS endpoint should return JSON containing one of these:

```json
{
  "text": "Response from ATLAS"
}
```

```json
{
  "reply": "Response from ATLAS"
}
```

```json
{
  "response": "Response from ATLAS"
}
```

It may also include panel instructions:

```json
{
  "text": "I found the answer.",
  "panel": {
    "mode": "speaking",
    "message": "RESPONDING"
  }
}
```

## BLE motor protocol

| Command | Motion | Motor behavior |
|---|---|---|
| `F` | Forward | Both motors forward |
| `B` | Reverse | Both motors reverse |
| `l` | Left slow | Left stopped, right forward |
| `L` | Left fast | Left reverse, right forward |
| `r` | Right slow | Left forward, right stopped |
| `R` | Right fast | Left forward, right reverse |
| `S` | Stop | Both motors stopped |

The web application sends this extended protocol.

The Arduino firmware must be updated to recognize:

```text
B
l
L
r
R
```

The original `F/L/R/S` firmware cannot provide all the new motion behaviors.

## Tracking behavior

- Target centered: `F`
- Target moderately left: `l`
- Target near the far-left edge: `L`
- Target moderately right: `r`
- Target near the far-right edge: `R`
- Target larger than the Reverse Width setting: `B`
- Target missing: `S`
- Tracking disabled: `S`

## Servo tilt protocol

Servo tilt uses:

```text
T0
```

through:

```text
T180
```

Examples:

```text
T45
T90
T135
```

The web interface and ATLAS protocol are prepared for this command.

The Arduino firmware must clamp the angle between 0 and 180 degrees and control the selected servo channel.

## Phone-to-ATLAS WebSocket messages

Connection message:

```json
{
  "type": "hello",
  "client": "IRIS-web-v5",
  "capabilities": [
    "panel",
    "tts",
    "voice",
    "ble",
    "tracking",
    "camera-telemetry",
    "pcm16-audio",
    "openwakeword",
    "servo-tilt"
  ]
}
```

Start audio:

```json
{
  "type": "audio_start",
  "format": "pcm_s16le",
  "sampleRate": 16000,
  "channels": 1,
  "threshold": 0.5
}
```

Spoken request:

```json
{
  "type": "utterance",
  "text": "Follow me",
  "source": "voice"
}
```

Tracking telemetry:

```json
{
  "type": "telemetry",
  "tracking": true,
  "command": "F",
  "target": {
    "x": 0.51,
    "y": 0.48,
    "area": 0.08,
    "width": 0.27
  }
}
```

After `audio_start`, binary WebSocket messages contain mono, 16-bit, little-endian PCM audio at 16 kHz.

## ATLAS-to-phone messages

Wake word detected:

```json
{
  "type": "wake_word_detected",
  "label": "Hey Atlas",
  "score": 0.82
}
```

Speak through the phone:

```json
{
  "type": "tts",
  "text": "I am ready."
}
```

Start tracking:

```json
{
  "type": "tracking",
  "enabled": true
}
```

Send a motor command:

```json
{
  "type": "command",
  "command": "B"
}
```

Move the future tilt servo:

```json
{
  "type": "servo_tilt",
  "angle": 105
}
```

Control the panel:

```json
{
  "type": "panel_state",
  "state": {
    "mode": "thinking",
    "message": "CALCULATING",
    "energy": 0.62,
    "attention": 0.91,
    "brightness": 1
  }
}
```

## Panel zones

ATLAS can control these display zones:

```text
wedgeLeft
wedgeRight
pillar
orb1
orb2
orb3
square1
square2
center
bar1
bar2
```

## Local voice commands

These commands bypass the language model for lower latency:

- Follow me
- Stop
- Halt
- Freeze
- Emergency stop
- Forward
- Reverse
- Back up
- Turn left
- Turn right
- Turn left fast
- Turn right fast

Other recognized speech is sent to ATLAS.