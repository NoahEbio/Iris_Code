# Iris Nano Firmware (v5 — latching protocol)

Arduino sketch for the **Arduino Nano 33 IoT** that speaks the BLE motor
protocol expected by the Iris web app (`../iris.js`).

## Hardware

- Arduino Nano 33 IoT (SAMD21 + u-blox NINA-W102 BLE)
- Nano Motor Carrier (or any dual H-bridge driver — verify pin map below
  if you wire a different board)

## Pin map (Nano Motor Carrier)

| Function              | Pin |
|-----------------------|-----|
| Motor A direction     | D6  |
| Motor A enable / PWM  | D7  |
| Motor B direction     | D8  |
| Motor B enable / PWM  | D9  |
| Servo 1 (PWM)         | D3  |
| Heartbeat LED         | D13 (onboard) |

## BLE service (Nordic UART)

| Role                           | UUID                                   |
|--------------------------------|----------------------------------------|
| Service                        | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| Phone → Nano (write)           | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |
| Nano → Phone (notify/optional) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |

Device advertises as **`Iris`**.

## Protocol

| Cmd | Motion                  |
|-----|-------------------------|
| `F` | Forward (both)          |
| `B` | Reverse (both)          |
| `l` | Left slow (right only)  |
| `L` | Left fast (counter)     |
| `r` | Right slow (left only)  |
| `R` | Right fast (counter)    |
| `S` | Stop                    |
| `T<n>` | Set servo to `n` degrees (0-180) |
| `?` | Send status over notify channel |

Latching: each command holds motor state until the next command.
Motors auto-stop 1 s after BLE disconnect (safety timeout).

## Build

Open `iris_nano_v5.ino` in Arduino IDE 2.x. Select board:
**Arduino Nano 33 IoT**. No external libraries — `ArduinoBLE` is bundled
with the Nano 33 IoT board package.

## Flash + test

1. Flash the sketch. Open Serial Monitor at **115200 baud**.
2. Verify `[BLE] advertising as Iris` appears.
3. Open the Iris web app in Bluefy on the iPhone, tap **Connect BLE**.
4. The Nano should appear in the picker (the web app uses
   `acceptAllDevices: true`, so it shows up even without strict filtering).
5. The onboard LED (D13) stays solid while connected, off when not.
6. Point the camera at a red target — the motors should respond to
   `F`/`B`/`l`/`L`/`r`/`R`/`S`.
