# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-09

First public release.

### Added

- Serial workspace: Web Serial connection, text/HEX send and receive, timestamps, RX/TX log merging with direction toggles, ANSI colors, keyword highlight and filter, log auto-save with size/time rotation.
- Network workspace: TCP server/client, UDP server/client, multi-client broadcast, per-peer coloring, and a bidirectional serial ↔ network link bridge.
- SSH terminal and SFTP file panel: password login, host fingerprint display, on-demand SFTP, chunked upload/download, absolute-path browsing, quick paths and file operations.
- YMODEM file transfer: CRC16-XMODEM, 1 KB / 128 B blocks, timeout retransmission, send and receive.
- Terminal mode: xterm.js interactive shell, local echo, keyword search and jump.
- Everyday tooling: template variables, quick send, send history, response testing, timed send, Macro recording and playback, connection presets.
- Bilingual UI: English by default, switchable to Simplified Chinese from the top bar and persisted across sessions.
- AI control channel: Agent CLI and MCP server (23 business tools by default; `LINKTK_MCP_ADVANCED=1` exposes protocol-level tools).
- AI safety gates: read-only / confirm-writes / fully-trusted approval policies, pause and cancel, approval timeout withdrawal, serialized writes, exclusive multi-controller leases, evidence bundles, task templates, and rollback-capable transactions.
- Device Profiles: board and shell semantics, prompt regex, login/boot hints, default line ending, common commands and dangerous patterns.
- Example project `examples/linktk-probe`: a zero-dependency inspection tool deployed to a Linux board over the Agent CLI.
- Test suites: `test:mcp`, `test:coordination`, `test:ssh`, `test:ymodem`, `test:smoke`, `test:probe`.
