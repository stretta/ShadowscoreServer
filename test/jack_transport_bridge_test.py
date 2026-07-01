#!/usr/bin/env python3

import importlib.util
import pathlib
import sys
import unittest


BRIDGE_PATH = pathlib.Path(__file__).resolve().parents[1] / "bin" / "jack-transport-bridge.py"
SPEC = importlib.util.spec_from_file_location("jack_transport_bridge", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)


class JackTransportBridgeTest(unittest.TestCase):
    def test_snapshot_includes_bbt_and_absolute_beat_when_valid(self):
        position = bridge.JackPosition()
        position.valid = bridge.JACK_POSITION_BBT
        position.frame = 767223806
        position.frame_rate = 48000
        position.bar = 7991
        position.beat = 4
        position.tick = 730
        position.beats_per_bar = 4
        position.beat_type = 4
        position.ticks_per_beat = 1920
        position.beats_per_minute = 120

        snapshot = bridge.snapshot_from_position(
            position,
            state_code=1,
            host="wren",
            observed_at_ms=1782580000000,
        ).payload()

        self.assertEqual(snapshot["source"], "jack")
        self.assertEqual(snapshot["host"], "wren")
        self.assertEqual(snapshot["state"], "rolling")
        self.assertEqual(snapshot["frame"], 767223806)
        self.assertEqual(snapshot["frameRate"], 48000)
        self.assertEqual(snapshot["bbtValid"], True)
        self.assertEqual(snapshot["bar"], 7991)
        self.assertEqual(snapshot["beat"], 4)
        self.assertEqual(snapshot["tick"], 730)
        self.assertEqual(snapshot["ticksPerBeat"], 1920)
        self.assertEqual(snapshot["beatsPerMinute"], 120)
        self.assertAlmostEqual(snapshot["absoluteBeat"], 31963.380208333332)
        self.assertEqual(snapshot["observedAt"], 1782580000000)

    def test_snapshot_omits_bbt_fields_when_invalid(self):
        position = bridge.JackPosition()
        position.frame = 1024
        position.frame_rate = 48000
        position.bar = 10
        position.beat = 2
        position.tick = 960
        position.ticks_per_beat = 1920

        snapshot = bridge.snapshot_from_position(
            position,
            state_code=0,
            host="wren",
            observed_at_ms=1782580000000,
        ).payload()

        self.assertEqual(snapshot["state"], "stopped")
        self.assertEqual(snapshot["bbtValid"], False)
        self.assertNotIn("bar", snapshot)
        self.assertNotIn("absoluteBeat", snapshot)

    def test_control_mode_calls_jack_transport_actions(self):
        calls = []
        original_client = bridge.JackTransportClient

        class FakeClient:
            def __init__(self, client_name, library_name):
                calls.append(("open", client_name, library_name))

            def start(self):
                calls.append(("start",))

            def stop(self):
                calls.append(("stop",))

            def locate(self, frame):
                calls.append(("locate", frame))

            def close(self):
                calls.append(("close",))

        try:
            bridge.JackTransportClient = FakeClient
            self.assertEqual(bridge.main(["--control", "start"]), 0)
            self.assertEqual(bridge.main(["--control", "stop"]), 0)
            self.assertEqual(bridge.main(["--control", "locate", "--frame", "48000"]), 0)
        finally:
            bridge.JackTransportClient = original_client

        self.assertEqual(
            calls,
            [
                ("open", "shadowscore-jack-bridge", bridge.JACK_DEFAULT_LIBRARY),
                ("start",),
                ("close",),
                ("open", "shadowscore-jack-bridge", bridge.JACK_DEFAULT_LIBRARY),
                ("stop",),
                ("close",),
                ("open", "shadowscore-jack-bridge", bridge.JACK_DEFAULT_LIBRARY),
                ("locate", 48000),
                ("close",),
            ],
        )

    def test_poller_reconnects_stale_frame_zero_snapshot(self):
        calls = []

        stale = bridge.JackSnapshot(
            source="jack",
            host="wren",
            state="stopped",
            frame=0,
            frameRate=48000,
            bbtValid=True,
            observedAt=1000,
            bar=1,
            beat=1,
            tick=0,
            beatsPerBar=4,
            beatType=4,
            ticksPerBeat=1920,
            beatsPerMinute=100,
            absoluteBeat=0,
        )
        rolling = bridge.JackSnapshot(
            source="jack",
            host="wren",
            state="rolling",
            frame=43707904,
            frameRate=48000,
            bbtValid=True,
            observedAt=2000,
            bar=349,
            beat=4,
            tick=1183,
            beatsPerBar=4,
            beatType=4,
            ticksPerBeat=1920,
            beatsPerMinute=92,
            absoluteBeat=1395.6161458333333,
        )

        class FakeClient:
            def __init__(self, label, snapshot):
                self.label = label
                self.snapshot = snapshot

            def query(self, host):
                calls.append(("query", self.label, host))
                return self.snapshot

            def close(self):
                calls.append(("close", self.label))

        clients = [FakeClient("rolling", rolling)]

        def make_client(client_name, library_name):
            calls.append(("open", client_name, library_name))
            return clients.pop(0)

        poller = bridge.JackTransportPoller(
            "bridge",
            "libjack.so.0",
            reconnect_interval=2,
            now=lambda: 10,
            client_factory=make_client,
        )
        poller.client = FakeClient("stale", stale)
        poller.last_reconnect = 0

        try:
            snapshot = poller.query("wren")
        finally:
            poller.close()

        self.assertEqual(snapshot.state, "rolling")
        self.assertEqual(snapshot.frame, 43707904)
        self.assertEqual(
            calls,
            [
                ("query", "stale", "wren"),
                ("close", "stale"),
                ("open", "bridge", "libjack.so.0"),
                ("query", "rolling", "wren"),
                ("close", "rolling"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
