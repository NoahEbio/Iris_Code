"""IRIS WebSocket bridge for ATLAS and server-side openWakeWord."""

from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np
from openwakeword.model import Model
from websockets.asyncio.server import ServerConnection, serve


HOST = os.getenv("IRIS_HOST", "127.0.0.1")
PORT = int(os.getenv("IRIS_PORT", "8765"))

MODEL_PATH = Path(
    os.getenv(
        "OPENWAKEWORD_MODEL",
        "models/hey_atlas.onnx",
    )
)

DEFAULT_THRESHOLD = float(
    os.getenv(
        "OPENWAKEWORD_THRESHOLD",
        "0.50",
    )
)

ATLAS_HTTP_URL = os.getenv(
    "ATLAS_HTTP_URL",
    "",
).strip()

ATLAS_TOKEN = os.getenv(
    "ATLAS_TOKEN",
    "",
).strip()

# 80 milliseconds of mono 16 kHz PCM16 audio.
FRAME_SAMPLES = 1280


def make_model() -> Model:
    """Load the Hey Atlas openWakeWord model."""

    if not MODEL_PATH.is_file():
        raise FileNotFoundError(
            f"Wake-word model not found: {MODEL_PATH}. "
            "Set OPENWAKEWORD_MODEL to your "
            "Hey Atlas .onnx or .tflite file."
        )

    return Model(
        wakeword_models=[
            str(MODEL_PATH)
        ]
    )


def atlas_request(
    text: str,
) -> dict[str, Any]:
    """Forward a spoken request to ATLAS."""

    if not ATLAS_HTTP_URL:
        return {
            "type": "error",
            "code": "atlas_not_configured",
            "message": (
                "Set ATLAS_HTTP_URL on the bridge "
                "to route questions to ATLAS."
            ),
        }

    body = json.dumps(
        {
            "text": text,
            "source": "iris",
            "client": "IRIS-web-v5",
        }
    ).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
    }

    if ATLAS_TOKEN:
        headers["Authorization"] = (
            f"Bearer {ATLAS_TOKEN}"
        )

    request = urllib.request.Request(
        ATLAS_HTTP_URL,
        data=body,
        headers=headers,
        method="POST",
    )

    with urllib.request.urlopen(
        request,
        timeout=90,
    ) as response:
        payload = json.loads(
            response
            .read()
            .decode("utf-8")
        )

    reply = (
        payload.get("text")
        or payload.get("reply")
        or payload.get("response")
    )

    if not reply:
        raise ValueError(
            "ATLAS response must contain "
            "text, reply, or response."
        )

    return {
        "type": "tts",
        "text": str(reply),
        "panel": payload.get("panel"),
    }


async def send_json(
    socket: ServerConnection,
    payload: dict[str, Any],
) -> None:
    """Send compact JSON to the phone."""

    await socket.send(
        json.dumps(
            payload,
            separators=(",", ":"),
        )
    )


async def handle_client(
    socket: ServerConnection,
) -> None:
    """Handle one connected Iris phone."""

    model = make_model()

    audio_buffer = np.empty(
        0,
        dtype=np.int16,
    )

    threshold = DEFAULT_THRESHOLD
    audio_enabled = False
    cooldown_until = 0.0

    await send_json(
        socket,
        {
            "type": "bridge_ready",
            "wakeWord": "Hey Atlas",
        },
    )

    async for message in socket:
        if isinstance(message, bytes):
            if not audio_enabled:
                continue

            samples = np.frombuffer(
                message,
                dtype="<i2",
            )

            audio_buffer = np.concatenate(
                (
                    audio_buffer,
                    samples,
                )
            )

            while (
                audio_buffer.size
                >= FRAME_SAMPLES
            ):
                frame = audio_buffer[
                    :FRAME_SAMPLES
                ]

                audio_buffer = audio_buffer[
                    FRAME_SAMPLES:
                ]

                prediction = await asyncio.to_thread(
                    model.predict,
                    frame,
                )

                if (
                    time.monotonic()
                    < cooldown_until
                ):
                    continue

                label, score = max(
                    prediction.items(),
                    key=lambda item: float(
                        item[1]
                    ),
                )

                if float(score) >= threshold:
                    cooldown_until = (
                        time.monotonic()
                        + 2.0
                    )

                    await send_json(
                        socket,
                        {
                            "type": (
                                "wake_word_detected"
                            ),
                            "label": "Hey Atlas",
                            "model": label,
                            "score": round(
                                float(score),
                                4,
                            ),
                        },
                    )

            continue

        try:
            event = json.loads(message)
        except json.JSONDecodeError:
            await send_json(
                socket,
                {
                    "type": "error",
                    "code": "invalid_json",
                },
            )
            continue

        event_type = event.get("type")

        if event_type == "hello":
            await send_json(
                socket,
                {
                    "type": "hello_ack",
                    "server": (
                        "iris-atlas-bridge"
                    ),
                    "version": 1,
                },
            )

        elif event_type == "audio_start":
            correct_format = (
                event.get("format")
                == "pcm_s16le"
            )

            correct_sample_rate = (
                event.get("sampleRate")
                == 16000
            )

            if not (
                correct_format
                and correct_sample_rate
            ):
                await send_json(
                    socket,
                    {
                        "type": "error",
                        "code": (
                            "unsupported_audio_format"
                        ),
                    },
                )
                continue

            threshold = min(
                0.95,
                max(
                    0.1,
                    float(
                        event.get(
                            "threshold",
                            DEFAULT_THRESHOLD,
                        )
                    ),
                ),
            )

            audio_enabled = True

            await send_json(
                socket,
                {
                    "type": "wake_word_online",
                    "threshold": threshold,
                },
            )

        elif event_type == "audio_stop":
            audio_enabled = False

            audio_buffer = np.empty(
                0,
                dtype=np.int16,
            )

        elif (
            event_type == "utterance"
            and event.get("text")
        ):
            await send_json(
                socket,
                {
                    "type": "panel_state",
                    "state": {
                        "mode": "thinking",
                        "message": "THINKING",
                    },
                },
            )

            try:
                reply = await asyncio.to_thread(
                    atlas_request,
                    str(event["text"]),
                )

                await send_json(
                    socket,
                    reply,
                )

            except Exception as error:
                # Keep the bridge running if
                # ATLAS temporarily fails.
                await send_json(
                    socket,
                    {
                        "type": "error",
                        "code": (
                            "atlas_request_failed"
                        ),
                        "message": str(error),
                    },
                )


async def main() -> None:
    """Start the Iris WebSocket server."""

    print(
        f"IRIS bridge listening on "
        f"ws://{HOST}:{PORT}"
    )

    async with serve(
        handle_client,
        HOST,
        PORT,
        max_size=2**20,
    ):
        await asyncio
        .get_running_loop()
        .create_future()


if __name__ == "__main__":
    asyncio.run(main())
