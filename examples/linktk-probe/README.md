# linktk-probe

`linktk-probe.py` is a small dependency-free Linux health probe used to demonstrate AI-driven development through LinkTK.

It reports:

- host, kernel, architecture, and Python version
- uptime and CPU usage sampled from `/proc/stat`
- load average from `/proc/loadavg`
- memory usage from `/proc/meminfo`
- root filesystem usage
- thermal zones from `/sys/class/thermal`
- RX/TX byte counters from `/proc/net/dev`

It also supports threshold warnings, machine-readable JSON, and a non-zero exit code for monitoring.

## Local verification

```powershell
npm run test:probe
python examples/linktk-probe/linktk_probe.py --interval 0.2
python examples/linktk-probe/linktk_probe.py --json --interval 0
```

Force a warning and verify the exit code:

```powershell
python examples/linktk-probe/linktk_probe.py --temperature-threshold -1 --fail-on-warn
```

## Run through LinkTK

After the user has authorized and opened the target COM port in the LinkTK page:

```powershell
npm run agent -- exec --data 'python3 /tmp/linktk-probe.py --interval 0.5; printf "LINKTK_%s\n" PROBE_DONE' --expect "LINKTK_PROBE_DONE" --timeout 10000
```

The command and its output remain visible in the LinkTK log or terminal view. Use the deployment procedure in `docs/AI_AGENT.md` when transferring a newer revision to the board.
