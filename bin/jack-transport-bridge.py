#!/usr/bin/env python3
"""Poll JACK transport BBT and forward snapshots to ShadowscoreServer."""

from __future__ import annotations

import argparse
import ctypes
import json
import signal
import socket
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any


JACK_POSITION_BBT = 0x10
JACK_DEFAULT_LIBRARY = "libjack.so.0"
JACK_STATE_NAMES = {
    0: "stopped",
    1: "rolling",
    2: "starting",
    3: "net-starting",
}


class JackPosition(ctypes.Structure):
    """ctypes mirror of JACK's jack_position_t.

    This layout follows the JACK2 public ABI and only reads stable primitive
    fields needed for BBT snapshots.
    """

    _fields_ = [
        ("unique_1", ctypes.c_uint64),
        ("usecs", ctypes.c_uint64),
        ("frame_rate", ctypes.c_uint32),
        ("frame", ctypes.c_uint32),
        ("valid", ctypes.c_uint32),
        ("bar", ctypes.c_int32),
        ("beat", ctypes.c_int32),
        ("tick", ctypes.c_int32),
        ("bar_start_tick", ctypes.c_double),
        ("beats_per_bar", ctypes.c_float),
        ("beat_type", ctypes.c_float),
        ("ticks_per_beat", ctypes.c_double),
        ("beats_per_minute", ctypes.c_double),
        ("frame_time", ctypes.c_double),
        ("next_time", ctypes.c_double),
        ("bbt_offset", ctypes.c_uint32),
        ("audio_frames_per_video_frame", ctypes.c_float),
        ("video_offset", ctypes.c_uint32),
        ("padding", ctypes.c_int32 * 7),
        ("unique_2", ctypes.c_uint64),
    ]


@dataclass
class JackSnapshot:
    source: str
    host: str
    state: str
    frame: int
    frameRate: int
    bbtValid: bool
    observedAt: int
    bar: int | None = None
    beat: int | None = None
    tick: float | None = None
    beatsPerBar: float | None = None
    beatType: float | None = None
    ticksPerBeat: float | None = None
    beatsPerMinute: float | None = None
    absoluteBeat: float | None = None

    def payload(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value is not None}


class JackTransportClient:
    def __init__(self, client_name: str, library_name: str = JACK_DEFAULT_LIBRARY) -> None:
        self._jack = ctypes.CDLL(library_name)
        self._jack.jack_client_open.argtypes = [
            ctypes.c_char_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
        ]
        self._jack.jack_client_open.restype = ctypes.c_void_p
        self._jack.jack_client_close.argtypes = [ctypes.c_void_p]
        self._jack.jack_client_close.restype = ctypes.c_int
        self._jack.jack_transport_query.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(JackPosition),
        ]
        self._jack.jack_transport_query.restype = ctypes.c_int

        status = ctypes.c_uint32(0)
        self._client = self._jack.jack_client_open(
            client_name.encode("utf-8"),
            0,
            ctypes.byref(status),
        )
        if not self._client:
            raise RuntimeError(f"could not open JACK client '{client_name}' (status={status.value})")

    def close(self) -> None:
        if self._client:
            self._jack.jack_client_close(self._client)
            self._client = None

    def query(self, host: str, observed_at_ms: int | None = None) -> JackSnapshot:
        position = JackPosition()
        state_code = self._jack.jack_transport_query(self._client, ctypes.byref(position))
        return snapshot_from_position(
            position,
            state_code=state_code,
            host=host,
            observed_at_ms=observed_at_ms,
        )


def snapshot_from_position(
    position: JackPosition,
    *,
    state_code: int,
    host: str,
    observed_at_ms: int | None = None,
) -> JackSnapshot:
    observed_at = observed_at_ms if observed_at_ms is not None else time.time_ns() // 1_000_000
    bbt_valid = bool(position.valid & JACK_POSITION_BBT)
    snapshot = JackSnapshot(
        source="jack",
        host=host,
        state=JACK_STATE_NAMES.get(state_code, f"unknown-{state_code}"),
        frame=int(position.frame),
        frameRate=int(position.frame_rate),
        bbtValid=bbt_valid,
        observedAt=int(observed_at),
    )
    if not bbt_valid:
        return snapshot

    beats_per_bar = float(position.beats_per_bar)
    ticks_per_beat = float(position.ticks_per_beat)
    tick = float(position.tick)
    absolute_beat = None
    if beats_per_bar > 0 and ticks_per_beat > 0:
        absolute_beat = ((int(position.bar) - 1) * beats_per_bar) + (
            int(position.beat) - 1
        ) + (tick / ticks_per_beat)

    snapshot.bar = int(position.bar)
    snapshot.beat = int(position.beat)
    snapshot.tick = tick
    snapshot.beatsPerBar = beats_per_bar
    snapshot.beatType = float(position.beat_type)
    snapshot.ticksPerBeat = ticks_per_beat
    snapshot.beatsPerMinute = float(position.beats_per_minute)
    snapshot.absoluteBeat = absolute_beat
    return snapshot


def post_snapshot(url: str, payload: dict[str, Any], timeout: float) -> None:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status >= 400:
            raise RuntimeError(f"snapshot POST failed with HTTP {response.status}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8790/transport/jack/snapshot",
        help="ShadowscoreServer snapshot endpoint",
    )
    parser.add_argument("--host", default=socket.gethostname(), help="host name to include in snapshots")
    parser.add_argument(
        "--interval",
        type=float,
        default=0.075,
        help="poll interval in seconds; phase 1 target is 0.05-0.10",
    )
    parser.add_argument("--client-name", default="shadowscore-jack-bridge")
    parser.add_argument("--jack-library", default=JACK_DEFAULT_LIBRARY)
    parser.add_argument("--timeout", type=float, default=2.0, help="POST timeout in seconds")
    parser.add_argument("--once", action="store_true", help="send one snapshot and exit")
    parser.add_argument("--print", action="store_true", help="print JSON snapshots to stdout")
    parser.add_argument(
        "--no-post",
        action="store_true",
        help="do not POST snapshots; useful with --print before server routes exist",
    )
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    if args.interval <= 0:
        raise ValueError("--interval must be positive")

    stopping = False

    def handle_stop(signum: int, frame: Any) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    client = JackTransportClient(args.client_name, args.jack_library)
    try:
        while not stopping:
            payload = client.query(args.host).payload()
            if args.print:
                print(json.dumps(payload, sort_keys=True), flush=True)
            if not args.no_post:
                try:
                    post_snapshot(args.url, payload, args.timeout)
                except (urllib.error.URLError, TimeoutError, RuntimeError) as exc:
                    print(f"snapshot post failed: {exc}", file=sys.stderr, flush=True)
            if args.once:
                break
            time.sleep(args.interval)
    finally:
        client.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return run(parse_args(sys.argv[1:] if argv is None else argv))
    except Exception as exc:
        print(f"jack-transport-bridge: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
