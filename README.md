# LinkTK

[![CI](https://github.com/zhuqinsheng-git/LinkTK/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuqinsheng-git/LinkTK/actions/workflows/ci.yml)

[简体中文](README.zh-CN.md) | English

LinkTK is a browser-based serial and network debugging console built on the Web Serial API. It picks a COM port through the Edge/Chrome system chooser and provides text/HEX send and receive, timestamps, follow mode, log saving, and timed send. The interface is English by default and can be switched to Simplified Chinese from the top bar.

New to the project? The [illustrated tutorial](docs/tutorial.md) walks through serial, network, YMODEM, terminal and the AI control channel with screenshots of the real UI.

## Features

- **Serial workspace**: pick a COM port in the browser's system chooser; text/HEX send and receive, timestamps, RX/TX block merging with per-direction toggles, ANSI color rendering, keyword highlight and filter, log auto-save with size/time rotation.
- **Network workspace**: real TCP server/client and UDP server/client bridged through the local Vite dev server, multi-client broadcast, stable per-peer colors, and a bidirectional serial ↔ network link bridge.
- **SSH terminal & SFTP panel**: password login, host fingerprint display, on-demand SFTP, chunked upload/download, absolute-path browsing, saved quick paths, and file operations.
- **YMODEM transfer**: CRC16-XMODEM, 1 KB and 128 B blocks, timeout retransmission, send and receive.
- **Terminal mode**: xterm.js interactive shell with local echo, search and jump.
- **Everyday tooling**: template variables, quick-send list, send history, response tests, timed send, macro record/playback, connection presets.
- **Bilingual UI**: English by default; Simplified Chinese is one click away in the top bar, and the choice is persisted.
- **AI control channel**: Agent CLI and a stdio MCP server exposing 23 business tools by default, with protocol-level tools behind `LINKTK_MCP_ADVANCED=1`.
- **AI safety gates**: approval policies (read-only / confirm writes / trusted), pause and cancel, approval timeout withdrawal, serialized AI writes, exclusive session leases, evidence bundles, task templates, and rollback-capable transactions.

## Serial and network workspaces

The "Serial / Network" switch in the top bar selects the workspace, and the right side shows the current connection status; a TCP server also shows how many clients are connected. The network workspace runs real TCP/UDP servers and clients through a local bridge inside the same Vite dev server — open the page in two browser windows to stand up a server and a client and verify traffic — and it can also connect to an SSH device for an interactive shell.

The receive area uses a fixed-height internal scroll container, so growing logs never stretch the page. In text mode ANSI color rendering can be toggled: when enabled it parses common terminal colors and styles, and when disabled it strips ANSI control codes.

Consecutive receive or send data in the same direction merges into a single `RX` / `TX` block, so serial fragmentation is not interrupted by repeated direction labels. Scrolling up to inspect history does not cancel "Follow" — a "Back to latest" button appears instead, and scrolling back to the bottom or clicking the button resumes following.

Consecutive same-direction log entries also merge into one RX/TX color block with a single direction label at the start. Inside the block data is grouped by time: the same timestamp is shown once, and a new timestamp appears in the same block when time moves on.

The log toolbar has RX, TX and SYS direction toggles to hide the directions you do not need. Timestamps, follow, ANSI colors, HEX dual-column and the time format live in the Display dialog; the time format supports absolute time, connection uptime and relative time. With dual-column enabled, text data shows UTF-8 text next to HEX, and HEX data shows HEX next to an ASCII preview.

Serial and network logs support quick copy: clicking a log block's content copies the block's full text, clicking a visible timestamp copies the time value, and an active text selection is preserved instead of triggering a copy.

The "Log / Terminal" switch flips between the workbench and an interactive shell. Terminal mode uses xterm.js; keystrokes go straight to the serial port and support arrow keys, backspace, Tab, Ctrl+C, Ctrl+D, ANSI cursor control and history. When the RTOS does not echo by itself, turn on "Local echo".

The "YMODEM File Transfer" panel on the left can send a local file to the device and receive a single file sent by the device. Sending uses 1 KB blocks by default and can switch to 128 B; the protocol uses CRC16-XMODEM with file headers, timeout retransmission, EOT and batch-end handling. A received file is saved by the browser.

The YMODEM panel collapses like the quick-send list, and the collapsed state is kept in the browser.

The network workspace supports:

- TCP server: listens on a port, accepts multiple clients, and broadcasts sends to every connected client
- TCP client: connects to a host and port
- UDP server: listens on a port, remembers the most recent sender, and replies to that address
- UDP client: connects to a host and port
- SSH terminal: connect with host, port and username, log in with a password, and get an xterm.js interactive shell
- SSH file panel: starts SFTP over the current SSH connection on demand, browses absolute paths, saves per-preset quick paths, and uploads, downloads, creates folders, renames and deletes
- Text/HEX display and send, timestamps, TX logs, log saving
- Timed send, collapsing the send area, pausing the receive display, and "Back to latest" after scrolling into history

SSH mode uses the `ssh2` bridge inside the local Vite service; the browser only renders the terminal and file panel and forwards keystrokes. Once connected, the plain network monitor, send area and quick-send list are hidden to avoid mixing with the SSH terminal. The file panel starts SFTP on first use, and uploads/downloads are chunked, which suits larger files such as firmware and logs. An SSH password is only used for the current connection's protocol requests by default and is never written to browser localStorage; it is saved in local browser storage with a preset only when "Save password" is checked and you save the preset. The host's SHA-256 fingerprint is shown after connecting. The current version accepts the host key automatically and shows the fingerprint for manual comparison, but there is no `known_hosts` persistence or checking yet. SSH sessions do not take part in the serial ↔ network bridge.

Network logs do not repeat the peer address in front of every entry. Each remote `IP:port` gets a stable color above the monitor, and log blocks start with the matching color marker; consecutive data from the same peer in the same direction still merges by the RX/TX rules.

Both serial and network monitors support keyword highlighting and filtering. Separate multiple keywords with commas (Chinese or English); typing a keyword highlights matches immediately, turning on "Filter" keeps only matching logs, and clearing the keywords restores everything. "Filter settings" switches case sensitivity and whole-word matching, and is shared between serial logs, network logs and terminal search. Terminal mode keeps the full shell state, so it provides keyword search, highlight and jump instead of hiding non-matching lines.

When both the serial and network workspaces are connected, the Bridge button in the top bar forwards data between them in both directions. The two directions serial → network and network → serial are controlled separately and show cumulative forwarded byte counts; the bridge stops automatically when serial disconnects, the network disconnects, or a YMODEM transfer starts.

The send area is collapsed by default to leave the space to the receive area and terminal; click the collapse button on the right of its title bar to expand it.

Both workspaces have a collapsible quick-send list. Each entry is directly editable and can be sent on its own or with Enter, added and removed; the list holds up to 20 entries and always keeps at least one. Content and collapsed state are stored in the browser separately.

The send area, quick-send and timed send support `{{name}}` template variables. Built-in variables cover time, date, Unix time, send count, random number, random HEX and UUID; custom variables are maintained in the Template variables dialog. Variables resolve before every actual send, so time, random values and counters update on each timed-send tick; serial and network share one variable table but keep independent send counters. Custom variable names are case-sensitive when displayed and case-insensitive when matched, and a leading `\` sends a literal `{{name}}`.

The serial and network send boxes browse recent sends with `↑` / `↓`; history keeps up to 50 entries in the browser. Browsing keeps the current draft, and pressing `↓` after returning to the newest entry restores it.

Timed send can be limited to a number of sends: `0` means unlimited, and a positive number sends that many times and stops. Common shortcuts include `Ctrl+Enter` to send, `Ctrl+K` to clear, `Ctrl+L` to focus the log and `Esc` to stop timed send.

Log auto-save is enabled from the toolbar's settings button. Serial and network can write to separate files and rotate by file size or time interval. It uses the browser File System Access API, so it needs desktop Chrome or Edge and a local folder chosen when enabled.

The serial and network send areas both offer a response test. It sends the current send-area content, waits across receive fragments for the expected text within the timeout, then shows the round-trip latency and matched snippet; it ends automatically on timeout or disconnect, and matching can be made case-sensitive. The expected content and timeout are stored in the browser.

Serial, plain network and SSH all have connection presets. A serial preset records port, baud rate, data bits, stop bits, parity, flow control, DTR and RTS; a network preset records TCP/UDP, server/client, host and port; an SSH preset records alias, host, port, username and an optional password. Pick a preset from the drop-down to apply it; saving the same endpoint again updates the existing preset, and up to 20 are kept. Preset controls are locked while connected so running parameters cannot be swapped.

The serial workspace records Macro commands. In terminal mode keystrokes are split into commands at Enter; in log mode every send click becomes one command. After recording, replay the Macro and configure the interval between commands and between characters.

## AI control channel

LinkTK has an AI control channel that listens only on the local dev server. AI agents or automation scripts can operate the already-open LinkTK page through the Agent CLI or MCP; serial, TCP/UDP, YMODEM, Macro, the link bridge, the SSH terminal, and SFTP directories and file transfers all show up in the page, and AI operations are marked with `AI` badges or terminal hints.

The control channel generates a random token at startup and writes it to `~/.linktk/agent-token`. The Agent CLI and MCP server read and use it automatically, and the page control channel also validates Origin so external web pages cannot impersonate an AI controller. To customize, set `LINKTK_AGENT_TOKEN` in both the service and client processes; the token file location can be overridden with `LINKTK_AGENT_TOKEN_FILE`.

An AI can call `linktk_launch` first to start the local service and open the browser page automatically. The default MCP surface exposes only the business capabilities an AI actually needs, such as `linktk_targets`, `linktk_connect`, `linktk_execute`, `linktk_observe`, `linktk_transfer_file`, `linktk_macro` and `linktk_bridge`. For ports the user has already authorized, the AI can read targets and reopen the port through `linktk_connect`; authorizing a physical serial port for the first time still requires the user in the browser.

Every browser tab has its own `sessionId` and device alias. With multiple pages running, the AI must first look at `linktk_sessions` and then pick a session with `linktk_select_session`; `linktk_snapshot` returns the full state of connections, UI, bridge, AI control and recent operations. Long tasks can be tracked and canceled independently with `linktk_operation_start`, `linktk_operation_status` and `linktk_operation_cancel`.

The "AI activity" button in the top bar badges unread operations and pending approvals. The panel has two tabs: Operation records shows the last 80 operations in one scrollable area, and Control settings shows the current session, target, approval policy, device Profiles and task templates. Users can switch between "Read-only", "Writes require confirmation" and "Fully trust this session", and can pause the AI or cancel the current operation. The default policy requires human confirmation of writes; while paused, read-only queries still work but serial sends, command execution and SFTP modifications are blocked. Pending approvals show a countdown; a timeout or controller disconnect withdraws the dialog and the write lock immediately — the device never executes, and a late click is not replayed.

Device Profiles store the board, shell type, prompt regex, login/boot hints, default line ending, common commands and dangerous patterns. After the AI selects a Profile, sends inherit its default line ending, and the Profile travels with the snapshot so the AI does not have to guess the target device every time. Profiles are maintained from the Configuration button in the AI activity panel or with `linktk_device_profile` for listing, selecting, saving and deleting.

The AI operation evidence bundle records session, connections, UI, Profile, request parameters and results before and after each operation, and automatically hides passwords, keys and large base64 content. Export JSON with the file button next to an operation in the AI activity panel, or read it with `linktk_evidence`. Completed operations or transactions can be saved as task templates and replayed step by step from the page or with `linktk_task`.

Transactions run multiple steps in order through `linktk_transaction` and support recovery-style rollback for SFTP files: uploads try to restore the old file, deletes try to restore a backup, renames try to move back, and empty-directory creation tries to remove the directory. Serial, SSH and network commands are treated as irreversible by default, and an atomic transaction refuses steps that cannot be rolled back; when that is really needed, explicitly allow irreversible steps or turn atomic mode off. A failing step itself is rolled back too, so earlier successful steps are not the only ones restored.

Multiple AI controllers get distinct controller identities. Before writing to the same page, `linktk_session_claim` can claim an `exclusive` session lease: other controllers' writes are rejected while read-only queries such as state and logs keep working. `linktk_session_release` releases the lease and `linktk_leases` shows the current holders. A lease is released automatically when it expires or the controller disconnects, and the user can still pause, cancel or take over the AI from the page.

The full operator manual for AI agents — command parameters, cursor handling and troubleshooting — is in [`docs/AI_AGENT.md`](docs/AI_AGENT.md). The root `AGENTS.md` asks AI agents to read that document before operating LinkTK.

The browser security model does not allow a page or an AI to acquire serial permission automatically. On first use, click "Choose COM port" in the LinkTK page and authorize the target device before opening the port. Once the port is open, another terminal can run:

```powershell
npm run agent -- status
npm run agent -- serial-ports
npm run agent -- serial-connect --name "COM12 debug"
npm run agent -- send --text "help" --ending lf
npm run agent -- exec --text "uname -a" --expect "Linux" --timeout 5000
npm run agent -- exec --data 'printf "LINKTK_%s\n" AGENT_OK' --expect "LINKTK_AGENT_OK" --timeout 5000
npm run agent -- read --wait 1000
npm run agent -- wait --expect "login:" --timeout 10000
npm run agent -- network-connect --protocol tcp --role client --host 127.0.0.1 --port 9000
npm run agent -- network-exec --text "PING" --expect "PONG" --timeout 5000
npm run agent -- ymodem-send --file .\firmware.bin
npm run agent -- macro-list
npm run agent -- bridge-status
npm run agent -- device-profiles
npm run agent -- device-profile-select --name "EVB-A1 Linux"
npm run agent -- transactions
npm run agent -- tasks
```

`exec` sends the text first and then waits for the text to appear in the receive area; matching is contains-based by default. Results are JSON with sent byte count, match status, timeout status and received content. You can also run `node tools/linktk-agent.mjs status` directly. The control URL defaults to `ws://127.0.0.1:5173/__agent-control` and can be overridden with `LINKTK_AGENT_URL`.

Besides the CLI, LinkTK ships a stdio MCP server:

```powershell
npm run mcp
```

Add the following to Codex's `mcp_servers` and the AI gets 23 business tools by default: lifecycle and sessions, long operations, `linktk_targets`, `linktk_connect`, `linktk_disconnect`, `linktk_execute`, `linktk_observe`, `linktk_transfer_file`, `linktk_bridge`, `linktk_macro`, `linktk_device_profile`, `linktk_transaction`, `linktk_task` and `linktk_evidence`. MCP still operates the target device through the running LinkTK page and never opens a second serial, TCP/UDP or SSH connection.

```toml
[mcp_servers.linktk]
command = "node"
args = ["C:\\path\\to\\LinkTK\\tools\\linktk-mcp.mjs"]
env = { LINKTK_AGENT_URL = "ws://127.0.0.1:5173/__agent-control" }
```

The "AI activity" panel in the top bar also has a "Copy config" button that generates a ready-to-paste MCP JSON config for the current project location and page address, so moving the project directory does not require editing the `linktk-mcp.mjs` path by hand.

The protocol-level tools `linktk_serial_*`, `linktk_network_*`, `linktk_ssh_*`, `linktk_sftp_*` and `linktk_ymodem_*` are hidden by default so the AI is not led into button-style interfaces. For compatibility with older scripts, set `LINKTK_MCP_ADVANCED=1` in the MCP process to use them.

MCP tools carry `readOnlyHint`, `destructiveHint` and `idempotentHint` annotations. Clients that honor them can warn "reading state", "modifying the device" or "may break remote state" before a call, and the page-side approval policy remains the final gate.

`linktk_transfer_file` picks between SFTP and YMODEM automatically and handles chunking internally. A single SFTP business transfer is limited to 16 MiB and a single YMODEM upload to 1 MiB.

Only one AI write operation runs at a time, so multiple commands cannot interleave on the serial port; read-only observation, status queries and response waits run in parallel with writes. When the browser page closes or reloads, unfinished AI requests fail immediately.

## Run

On Windows, double-click `start.bat` in the project root. The script enters the project directory, checks Node.js, installs dependencies when needed, and starts Vite in a separate window; the launcher window then closes itself. To stop the service, press `Ctrl+C` in the server window — it exits immediately — or simply close that window.

Or start from the command line:

```powershell
npm install
npm run dev
```

Then open this in desktop Chrome or Edge:

```text
http://127.0.0.1:5173
```

Web Serial requires a secure context. `localhost` and HTTPS work; a plain `http://` LAN address usually does not.

Requirements: Node.js 20 or later, and desktop Chrome or Edge.

## Usage

1. Click "Choose COM port" and pick the serial device in the browser's system chooser.
2. Set baud rate, data bits, stop bits, parity and flow control.
3. Click "Open serial port".
4. Send data in text or HEX mode; the receive area shows traffic according to the RX/TX toggles.

The browser's Web Serial API does not expose system serial port names (such as `COM3`) to the page. The tool reads Windows port names in the local Vite service and matches them against browser-authorized ports by VID/PID, so it can usually show names like `XR21V1410 USB UART (COM12)` from Device Manager; when no match is found it falls back to the USB VID/PID.

## Build and test

```powershell
npm run build
npm run test:coordination
npm run test:ssh
npm run test:mcp
npm run test:ymodem
npm run test:smoke
```

`test:coordination` starts the local AI control bridge and verifies exclusive leases between controllers, concurrent write rejection, read-only queries, release and forced takeover. `test:ssh` starts a local SSH/SFTP server and a browser to check dialog connection, terminal output, keyboard input, the file browser layout, SFTP upload/download and the disconnect flow. `test:mcp` starts the default and advanced stdio MCP servers, checks that the default surface exposes only the 23 business tools and that advanced mode keeps the legacy protocol tools, and verifies that connection, execution, observation, Profile and task parameters are forwarded. `test:ymodem` runs a sender/receiver loopback covering CRC16, 1 KB, 128 B and zero-byte transfers. `test:smoke` launches a mock Web Serial port in local Edge and checks Agent CLI serial connect and round-trip, network round-trip, YMODEM, Macro, the link bridge, sessions and the activity panel, device Profiles, read-only atomic transactions, task templates, evidence bundles, write approval and denial, AI pause, background operation cancellation, port connection, sending and receiving, shortcuts and log state.

The smoke test also opens two pages running TCP and UDP server/client pairs and sends data both ways to verify the real network bridge, and uses the mock serial port to verify the bidirectional serial ↔ network link bridge.

`test:ssh` and `test:smoke` drive a real browser session and expect Edge/Chrome to be installed. `test:coordination`, `test:mcp`, `test:ymodem` and `test:probe` are browser-free and run in CI (`.github/workflows/ci.yml`).

## Project structure

- `src/` — browser runtime: protocol/bridge clients (`ssh.js`, `network.js`, `ymodem.js`, `agent.js`), `features/*` UI and runtime wiring, `agent/*` AI command execution and approvals.
- `server/` — Vite dev-server plugins: SSH/SFTP bridge, network bridge, agent control bridge.
- `tools/` — `linktk-agent.mjs` (Agent CLI) and `linktk-mcp.mjs` (MCP stdio server).
- `shared/` — helpers shared between the browser and Node processes.
- `tests/` — MCP, coordination, SSH, YMODEM, smoke and probe suites.
- `examples/linktk-probe/` — a zero-dependency inspection tool deployed to a Linux board over the Agent CLI.

## Example project

`examples/linktk-probe` is a zero-dependency inspection tool deployed to a Linux board and run there through the LinkTK Agent CLI. It demonstrates environment probing, local unit tests, deployment over serial fragments, board-side syntax checks, real execution and threshold exit codes. See [`examples/linktk-probe/README.md`](examples/linktk-probe/README.md) for how to run it.

## License

MIT. See [LICENSE](LICENSE).
