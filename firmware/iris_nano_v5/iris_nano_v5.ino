//
//  iris_nano_v5.ino
//  v5-protocol BLE motor controller for Arduino Nano 33 IoT
//
//  Latching protocol: each command sets motor state until next command.
//  Motors only auto-stop if BLE link drops (safety timeout).
//
//  *** PIN MAP NOT YET VERIFIED AGAINST YOUR WIRING ***
//  Default assumes "Motor Carrier"-style wiring on:
//     Motor A direction: D2   enable/PWM: D3
//     Motor B direction: D4   enable/PWM: D5
//
//  Behavior:
//    - Pin 13 LED: ON solid = BLE connected, OFF = disconnected
//    - Serial @ 115200 baud for debug output
//    - Latching commands: F/B/l/L/r/R hold state until next command
//    - Safety: motors auto-stop 1s after BLE disconnect
//    - '?' status command returns current motor state via notify
//
//  Built with ArduinoBLE (built-in for Nano 33 IoT via SAMD core).

#include <ArduinoBLE.h>

// --- Pin map (Nano Motor Carrier, verified by Noah 2026-09-06) ---
// M1 = Motor A, M2 = Motor B (Nano Motor Carrier conventions)
const int PIN_MOTOR_A_DIR = 6;    // M1 direction
const int PIN_MOTOR_A_EN  = 7;    // M1 enable/PWM
const int PIN_MOTOR_B_DIR = 8;    // M2 direction
const int PIN_MOTOR_B_EN  = 9;    // M2 enable/PWM
const int PIN_HEARTBEAT_LED = 13; // onboard

// --- Servo (first servo channel) ---
// T0..T180 commands drive this. Default to a PWM-capable pin; Nano
// Motor Carrier's first servo header is on D3 (PWM-capable on SAMD).
const int PIN_SERVO_1 = 3;
const int SERVO_MIN_US = 544;   // ~0° for SG90 / similar
const int SERVO_MAX_US = 2400;  // ~180°
const int SERVO_DEFAULT_DEG = 90;

// --- Motor speed (0..255 PWM) ---
const int MOTOR_SPEED_FAST = 200;
const int MOTOR_SPEED_SLOW = 120;

// --- Safety: auto-stop motors this long after BLE disconnect ---
const unsigned long BLE_DROP_TIMEOUT_MS = 1000;

// --- BLE: Nordic UART service ---
BLEService        irisService("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
BLECharacteristic irisRxChar("6E400002-B5A3-F393-E0A9-E50E24DCCA9E", BLEWrite, 20);
BLECharacteristic irisTxChar("6E400003-B5A3-F393-E0A9-E50E24DCCA9E", BLENotify, 20);

// --- Latched motor state ---
//   'S' = stopped (initial state)
//   'F' = both forward (fast)
//   'B' = both reverse (fast)
//   'l' = slow-left (right wheel only, forward)
//   'L' = fast-left (left reverse, right forward)
//   'r' = slow-right (left wheel only, forward)
//   'R' = fast-right (left forward, right reverse)
volatile char motorState = 'S';

// --- Latched servo state ---
volatile int servoAngle = 90;

void onRxWritten(BLEDevice central, BLECharacteristic characteristic) {
  if (characteristic.valueLength() > 0) {
    char c = (char)characteristic.value()[0];

    switch (c) {
      case 'F':
        motorForward(MOTOR_SPEED_FAST);
        motorState = 'F';
        Serial.println(F("[CMD] F forward (latched)"));
        break;
      case 'B':
        motorReverse(MOTOR_SPEED_FAST);
        motorState = 'B';
        Serial.println(F("[CMD] B reverse (latched)"));
        break;
      case 'l':
        motorLeftSlow(MOTOR_SPEED_SLOW);
        motorState = 'l';
        Serial.println(F("[CMD] l slow-left (latched)"));
        break;
      case 'L':
        motorLeftFast(MOTOR_SPEED_FAST);
        motorState = 'L';
        Serial.println(F("[CMD] L fast-left (latched)"));
        break;
      case 'r':
        motorRightSlow(MOTOR_SPEED_SLOW);
        motorState = 'r';
        Serial.println(F("[CMD] r slow-right (latched)"));
        break;
      case 'R':
        motorRightFast(MOTOR_SPEED_FAST);
        motorState = 'R';
        Serial.println(F("[CMD] R fast-right (latched)"));
        break;
      case 'S':
        motorStop();
        motorState = 'S';
        Serial.println(F("[CMD] S stop"));
        break;
      case '?':
        sendStatus();
        Serial.println(F("[CMD] ? status"));
        break;
      case 'T': {
        // T<angle> — set servo angle, 0..180. Multi-character payload.
        // BLEWrite characteristic is 20 bytes, so we accept up to "T180" + null.
        char buf[8] = {0};
        int n = characteristic.valueLength();
        if (n > 7) n = 7;
        for (int i = 0; i < n; i++) buf[i] = (char)characteristic.value()[i];
        // skip the 'T', parse the rest as an int
        int angle = atoi(buf + 1);
        if (angle < 0) angle = 0;
        if (angle > 180) angle = 180;
        setServoAngle(angle);
        Serial.print(F("[CMD] T"));
        Serial.print(angle);
        Serial.println(F(" servo"));
        break;
      }
      default:
        Serial.print(F("[CMD] ? unknown: "));
        Serial.println(c);
        break;
    }
  }
}

// --- Motor primitives ---
void motorStop() {
  analogWrite(PIN_MOTOR_A_EN, 0);
  analogWrite(PIN_MOTOR_B_EN, 0);
  digitalWrite(PIN_MOTOR_A_DIR, LOW);
  digitalWrite(PIN_MOTOR_B_DIR, LOW);
}

void motorForward(int speed) {
  digitalWrite(PIN_MOTOR_A_DIR, HIGH);
  digitalWrite(PIN_MOTOR_B_DIR, HIGH);
  analogWrite(PIN_MOTOR_A_EN, speed);
  analogWrite(PIN_MOTOR_B_EN, speed);
}

void motorReverse(int speed) {
  digitalWrite(PIN_MOTOR_A_DIR, LOW);
  digitalWrite(PIN_MOTOR_B_DIR, LOW);
  analogWrite(PIN_MOTOR_A_EN, speed);
  analogWrite(PIN_MOTOR_B_EN, speed);
}

void motorLeftSlow(int speed) {
  // left stopped, right forward (pivot around left wheel)
  digitalWrite(PIN_MOTOR_A_DIR, LOW);
  digitalWrite(PIN_MOTOR_B_DIR, HIGH);
  analogWrite(PIN_MOTOR_A_EN, 0);
  analogWrite(PIN_MOTOR_B_EN, speed);
}

void motorLeftFast(int speed) {
  // left reverse, right forward (counter-steer)
  digitalWrite(PIN_MOTOR_A_DIR, LOW);
  digitalWrite(PIN_MOTOR_B_DIR, HIGH);
  analogWrite(PIN_MOTOR_A_EN, speed);
  analogWrite(PIN_MOTOR_B_EN, speed);
}

void motorRightSlow(int speed) {
  // left forward, right stopped (pivot around right wheel)
  digitalWrite(PIN_MOTOR_A_DIR, HIGH);
  digitalWrite(PIN_MOTOR_B_DIR, LOW);
  analogWrite(PIN_MOTOR_A_EN, speed);
  analogWrite(PIN_MOTOR_B_EN, 0);
}

void motorRightFast(int speed) {
  // left forward, right reverse (counter-steer)
  digitalWrite(PIN_MOTOR_A_DIR, HIGH);
  digitalWrite(PIN_MOTOR_B_DIR, LOW);
  analogWrite(PIN_MOTOR_A_EN, speed);
  analogWrite(PIN_MOTOR_B_EN, speed);
}

// --- Servo: angle-to-microsecond pulse ---
// SAMD21 analogWrite can do 8/10/12-bit resolution at any PWM-capable pin.
// 50 Hz (20 ms period) is standard for hobby servos; we approximate with
// analogWrite at the default ~490 Hz and use the duty cycle to encode
// pulse width. For a real servo signal you'd want a dedicated 50 Hz timer;
// this is a functional stopgap for testing.
void setServoAngle(int angle) {
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  servoAngle = angle;
  // Map 0..180 -> SERVO_MIN_US..SERVO_MAX_US, scaled to 0..65535
  // (16-bit duty cycle on SAMD21 analogWriteResolution(16)).
  long us = SERVO_MIN_US + ((long)(SERVO_MAX_US - SERVO_MIN_US) * angle) / 180;
  int duty = (int)((us * 65535L) / 20000L); // 50 Hz -> 20000us period
  analogWriteResolution(16);
  analogWrite(PIN_SERVO_1, duty);
}

// --- Status reply over notify channel ---
void sendStatus() {
  char buf[40];
  snprintf(buf, sizeof(buf), "STATE=%c SRV=%d BLE=%d", motorState, servoAngle, (int)BLE.connected());
  irisTxChar.writeValue((uint8_t*)buf, strlen(buf));
}

void setup() {
  Serial.begin(115200);
  while (!Serial) { /* wait for native USB serial */ }
  delay(200);
  Serial.println(F("Iris Nano v5 (latching) starting..."));

  pinMode(PIN_MOTOR_A_DIR, OUTPUT);
  pinMode(PIN_MOTOR_A_EN, OUTPUT);
  pinMode(PIN_MOTOR_B_DIR, OUTPUT);
  pinMode(PIN_MOTOR_B_EN, OUTPUT);
  pinMode(PIN_HEARTBEAT_LED, OUTPUT);
  pinMode(PIN_SERVO_1, OUTPUT);
  motorStop();
  digitalWrite(PIN_HEARTBEAT_LED, LOW);
  setServoAngle(SERVO_DEFAULT_DEG);

  if (!BLE.begin()) {
    Serial.println(F("[ERR] BLE.begin failed"));
    while (1) {
      digitalWrite(PIN_HEARTBEAT_LED, HIGH); delay(100);
      digitalWrite(PIN_HEARTBEAT_LED, LOW);  delay(100);
    }
  }
  BLE.setLocalName("Iris");
  BLE.setAdvertisedServiceUuid(irisService.uuid());

  irisService.addCharacteristic(irisRxChar);
  irisService.addCharacteristic(irisTxChar);

  BLE.addService(irisService);
  irisRxChar.setEventHandler(BLEWritten, onRxWritten);
  irisTxChar.setEventHandler(BLESubscribed, [](BLEDevice central, BLECharacteristic c) {
    Serial.print(F("[BLE] subscribed by "));
    Serial.println(central.address());
  });
  irisTxChar.setEventHandler(BLEUnsubscribed, [](BLEDevice central, BLECharacteristic c) {
    Serial.print(F("[BLE] unsubscribed by "));
    Serial.println(central.address());
  });

  BLE.advertise();
  Serial.println(F("[BLE] advertising as Iris"));
}

void loop() {
  BLEDevice central = BLE.central();
  bool connected = central && central.connected();

  // LED: solid on when connected, off otherwise
  digitalWrite(PIN_HEARTBEAT_LED, connected ? HIGH : LOW);

  // Safety: if BLE has been disconnected for >BLE_DROP_TIMEOUT_MS,
  // force-stop motors. (Re-applies each loop iteration so a re-flashed
  // board that boots up with no central present stays safe.)
  if (!connected) {
    if (motorState != 'S') {
      motorStop();
      motorState = 'S';
      Serial.println(F("[SAFE] BLE disconnected, motors stopped"));
    }
  }

  delay(10);
}
