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


if __name__ == "__main__":
    unittest.main()
