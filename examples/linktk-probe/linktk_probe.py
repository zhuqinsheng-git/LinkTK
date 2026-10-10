#!/usr/bin/env python3
"""Small dependency-free Linux board health probe for LinkTK experiments."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import time
from pathlib import Path


def read_text(path: str | Path, default: str = "") -> str:
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return default


def parse_meminfo(text: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        fields = rest.split()
        if not fields:
            continue
        try:
            values[key] = int(fields[0])
        except ValueError:
            continue
    return values


def parse_loadavg(text: str) -> list[float]:
    values = []
    for item in text.split()[:3]:
        try:
            values.append(float(item))
        except ValueError:
            values.append(0.0)
    return values


def parse_uptime(text: str) -> float:
    try:
        return float(text.split()[0])
    except (IndexError, ValueError):
        return 0.0


def parse_net_dev(text: str) -> dict[str, dict[str, int]]:
    interfaces: dict[str, dict[str, int]] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        fields = rest.split()
        if len(fields) < 16:
            continue
        try:
            interfaces[name.strip()] = {
                "rx_bytes": int(fields[0]),
                "rx_packets": int(fields[1]),
                "tx_bytes": int(fields[8]),
                "tx_packets": int(fields[9]),
            }
        except ValueError:
            continue
    return interfaces


def parse_cpu_times(text: str) -> dict[str, int]:
    for line in text.splitlines():
        if not line.startswith("cpu "):
            continue
        fields = line.split()
        try:
            values = [int(value) for value in fields[1:9]]
        except ValueError:
            return {"total": 0, "idle": 0}
        total = sum(values)
        idle = values[3] + values[4]
        return {"total": total, "idle": idle}
    return {"total": 0, "idle": 0}


def read_cpu_times() -> dict[str, int]:
    return parse_cpu_times(read_text("/proc/stat"))


def sample_cpu_usage(interval: float) -> float:
    before = read_cpu_times()
    time.sleep(max(0.0, min(2.0, interval)))
    after = read_cpu_times()
    total_delta = after["total"] - before["total"]
    idle_delta = after["idle"] - before["idle"]
    if total_delta <= 0:
        return 0.0
    return round(max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0)), 1)


def read_thermal_zones(root: str | Path = "/sys/class/thermal") -> list[dict[str, object]]:
    zones = []
    base = Path(root)
    if not base.exists():
        return zones

    for zone in sorted(base.glob("thermal_zone*")):
        raw_temp = read_text(zone / "temp")
        if not raw_temp:
            continue
        try:
            temperature = float(raw_temp) / 1000.0
        except ValueError:
            continue
        zones.append(
            {
                "name": read_text(zone / "type", zone.name),
                "celsius": round(temperature, 1),
            }
        )
    return zones


def read_disk(path: str = "/") -> dict[str, object]:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return {"path": path, "total_bytes": 0, "used_bytes": 0, "used_percent": 0.0}

    total = usage.total
    used = usage.used
    available = usage.free
    percent = round((used / total) * 100.0, 1) if total else 0.0
    return {
        "path": path,
        "total_bytes": total,
        "used_bytes": used,
        "available_bytes": available,
        "used_percent": percent,
    }


def collect_report(interval: float = 0.2) -> dict[str, object]:
    meminfo = parse_meminfo(read_text("/proc/meminfo"))
    total_kb = meminfo.get("MemTotal", 0)
    available_kb = meminfo.get("MemAvailable", meminfo.get("MemFree", 0))
    used_kb = max(0, total_kb - available_kb)
    memory_percent = round((used_kb / total_kb) * 100.0, 1) if total_kb else 0.0
    load_values = parse_loadavg(read_text("/proc/loadavg", "0 0 0"))

    return {
        "host": platform.node() or "unknown",
        "kernel": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "uptime_seconds": round(parse_uptime(read_text("/proc/uptime", "0")), 1),
        "cpu": {
            "count": os.cpu_count() or 1,
            "usage_percent": sample_cpu_usage(interval),
        },
        "load": {
            "1min": load_values[0] if len(load_values) > 0 else 0.0,
            "5min": load_values[1] if len(load_values) > 1 else 0.0,
            "15min": load_values[2] if len(load_values) > 2 else 0.0,
        },
        "memory": {
            "total_bytes": total_kb * 1024,
            "used_bytes": used_kb * 1024,
            "available_bytes": available_kb * 1024,
            "used_percent": memory_percent,
        },
        "disk": read_disk("/"),
        "thermal": read_thermal_zones(),
        "network": parse_net_dev(read_text("/proc/net/dev")),
    }


def evaluate_warnings(report: dict[str, object], args: argparse.Namespace) -> list[str]:
    warnings: list[str] = []
    load = report["load"]
    memory = report["memory"]
    disk = report["disk"]
    cpu_count = max(1, int(report["cpu"].get("count", 1)))
    load_limit = float(args.load_threshold) * cpu_count

    if float(load["1min"]) > load_limit:
        warnings.append(
            f"load 1min {load['1min']:.2f} exceeds {load_limit:.2f}"
        )
    if float(memory["used_percent"]) > float(args.memory_threshold):
        warnings.append(
            f"memory {memory['used_percent']:.1f}% exceeds {args.memory_threshold:.1f}%"
        )
    if float(disk["used_percent"]) > float(args.disk_threshold):
        warnings.append(
            f"disk {disk['used_percent']:.1f}% exceeds {args.disk_threshold:.1f}%"
        )
    for zone in report["thermal"]:
        if float(zone["celsius"]) > float(args.temperature_threshold):
            warnings.append(
                f"thermal {zone['name']} {zone['celsius']:.1f}C exceeds "
                f"{args.temperature_threshold:.1f}C"
            )
    return warnings


def human_bytes(value: int) -> str:
    size = float(value)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if size < 1024.0 or unit == "TiB":
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} TiB"


def human_duration(seconds: float) -> str:
    total = max(0, int(seconds))
    days, remainder = divmod(total, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, seconds = divmod(remainder, 60)
    if days:
        return f"{days}d {hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def print_human(report: dict[str, object], warnings: list[str]) -> None:
    cpu = report["cpu"]
    load = report["load"]
    memory = report["memory"]
    disk = report["disk"]

    print("LinkTK Probe")
    print(f"Host:    {report['host']} ({report['machine']})")
    print(f"Kernel:  {report['kernel']}")
    print(f"Python:  {report['python']}")
    print(f"Uptime:  {human_duration(float(report['uptime_seconds']))}")
    print(f"CPU:     {cpu['count']} cores, {cpu['usage_percent']:.1f}% usage")
    print(
        "Load:    "
        f"{load['1min']:.2f} {load['5min']:.2f} {load['15min']:.2f}"
    )
    print(
        "Memory:  "
        f"{human_bytes(int(memory['used_bytes']))} / "
        f"{human_bytes(int(memory['total_bytes']))} "
        f"({memory['used_percent']:.1f}%)"
    )
    print(
        "Disk /:  "
        f"{human_bytes(int(disk['used_bytes']))} / "
        f"{human_bytes(int(disk['total_bytes']))} "
        f"({disk['used_percent']:.1f}%)"
    )

    thermal = report["thermal"]
    if thermal:
        temperatures = ", ".join(
            f"{zone['name']}={zone['celsius']:.1f}C" for zone in thermal
        )
        print(f"Thermal: {temperatures}")

    network = report["network"]
    if network:
        interfaces = ", ".join(
            f"{name}=rx {human_bytes(values['rx_bytes'])} / "
            f"tx {human_bytes(values['tx_bytes'])}"
            for name, values in sorted(network.items())
        )
        print(f"Network: {interfaces}")

    print(f"Status:  {'WARN' if warnings else 'OK'}")
    for warning in warnings:
        print(f"Warning: {warning}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Collect a small LinkTK board health report.")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    parser.add_argument("--interval", type=float, default=0.2, help="CPU sample interval in seconds")
    parser.add_argument("--load-threshold", type=float, default=1.0, help="load per CPU threshold")
    parser.add_argument("--memory-threshold", type=float, default=85.0, help="memory percent threshold")
    parser.add_argument("--temperature-threshold", type=float, default=80.0, help="temperature threshold in Celsius")
    parser.add_argument("--disk-threshold", type=float, default=90.0, help="disk percent threshold")
    parser.add_argument(
        "--fail-on-warn",
        action="store_true",
        help="return exit code 1 when a threshold is exceeded",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = collect_report(args.interval)
    warnings = evaluate_warnings(report, args)
    report["warnings"] = warnings
    report["status"] = "WARN" if warnings else "OK"

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print_human(report, warnings)

    return 1 if warnings and args.fail_on_warn else 0


if __name__ == "__main__":
    sys.exit(main())
