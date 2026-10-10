import argparse
import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "examples" / "linktk-probe" / "linktk_probe.py"
SPEC = importlib.util.spec_from_file_location("linktk_probe", MODULE_PATH)
probe = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = probe
SPEC.loader.exec_module(probe)


class ProbeParserTests(unittest.TestCase):
    def test_parse_meminfo(self):
        parsed = probe.parse_meminfo(
            "MemTotal:        8192000 kB\nMemAvailable:    2048000 kB\nBadLine\n"
        )
        self.assertEqual(parsed["MemTotal"], 8192000)
        self.assertEqual(parsed["MemAvailable"], 2048000)

    def test_parse_loadavg(self):
        self.assertEqual(probe.parse_loadavg("1.25 0.50 0.10 1/200 42"), [1.25, 0.5, 0.1])

    def test_parse_uptime(self):
        self.assertEqual(probe.parse_uptime("1234.50 99.00"), 1234.5)

    def test_parse_net_dev(self):
        parsed = probe.parse_net_dev(
            "Inter-|   Receive                                                |  Transmit\n"
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
            "  eth0:  1000  10  0  0  0 0 0 0  2000  20 0 0 0 0 0 0\n"
        )
        self.assertEqual(parsed["eth0"]["rx_bytes"], 1000)
        self.assertEqual(parsed["eth0"]["tx_bytes"], 2000)

    def test_parse_cpu_times(self):
        parsed = probe.parse_cpu_times("cpu  10 20 30 40 50 60 70 80 90\n")
        self.assertEqual(parsed["total"], 360)
        self.assertEqual(parsed["idle"], 90)

    def test_read_disk_is_cross_platform(self):
        disk = probe.read_disk(str(ROOT))
        self.assertGreater(disk["total_bytes"], 0)
        self.assertGreaterEqual(disk["used_percent"], 0.0)

    def test_warning_evaluation(self):
        args = argparse.Namespace(
            load_threshold=1.0,
            memory_threshold=80.0,
            temperature_threshold=70.0,
            disk_threshold=85.0,
        )
        report = {
            "load": {"1min": 8.0, "5min": 0.0, "15min": 0.0},
            "memory": {"used_percent": 90.0},
            "disk": {"used_percent": 95.0},
            "cpu": {"count": 4},
            "thermal": [{"name": "soc", "celsius": 75.0}],
        }
        warnings = probe.evaluate_warnings(report, args)
        self.assertEqual(len(warnings), 4)


if __name__ == "__main__":
    unittest.main()
