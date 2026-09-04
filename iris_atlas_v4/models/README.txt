OPTIONAL PICOVOICE MODEL FILES

For the most reliable wake-word setup, place both files in this folder:

1) porcupine_params.pv
   Official Porcupine English parameter model.

2) hey_atlas_wasm.ppn
   A custom Porcupine wake-word model trained for the phrase "Hey Atlas"
   with target platform: Web (WASM).

The web app can operate without these local files:
- If porcupine_params.pv is missing, it loads the official model from Picovoice's GitHub.
- If hey_atlas_wasm.ppn is missing, it attempts to train "Hey Atlas" using the AccessKey entered in DEBUG.
