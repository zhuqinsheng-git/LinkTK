# LinkTK AI Agent Instructions

When the user asks an AI agent to operate LinkTK, communicate with a board through LinkTK, or automate its serial console, read `docs/AI_AGENT.md` before issuing commands.

Use the local Agent CLI or LinkTK MCP server instead of opening the serial port, TCP/UDP socket, SSH connection, or SFTP session directly from another process. The browser page owns those connections, and duplicating them can conflict with the user's active session.

Use `linktk_launch` when the LinkTK service or page is not already open. The browser operator must authorize each physical serial port once. After authorization, use `linktk_targets` and `linktk_connect` to connect through the existing page. Never claim that the AI can bypass the Web Serial permission chooser.

Keep operations visible in the LinkTK page. Serialize commands, use `exec` when waiting for a response, and avoid parallel writes to the same port.

The agent bridge is authenticated with the local `~/.linktk/agent-token` file and validates the browser Origin. Do not print, copy, or persist the token in evidence, logs, or project files.

When more than one LinkTK page can be open, call `linktk_sessions` and `linktk_select_session` before operating. Read `linktk_snapshot` before changing device state. Long-running work should use the `linktk_operation_*` tools so the user can monitor and cancel it. Read-only observation may run alongside one write operation, but writes must remain serialized.

When multiple AI controllers may use the same page, claim an `exclusive` session lease before writes and release it when finished. Use `linktk_device_profile` as the source of shell semantics and default line ending. For multi-step changes, prefer `linktk_transaction` and inspect rollback status; use `linktk_task` for repeatable workflows and `linktk_evidence` when the user needs an auditable record.

Use `linktk_connect`, `linktk_execute` and `linktk_observe` as the transport-neutral path for serial, TCP/UDP and SSH. Use `linktk_transfer_file` for SFTP/YMODEM file transfer, `linktk_macro` for repeatable input and `linktk_bridge` for serial-to-network forwarding. The low-level protocol tools are advanced compatibility APIs and are hidden unless `LINKTK_MCP_ADVANCED=1` is set.

Never bypass the page's read-only mode, write confirmation, or paused state. A user denial is a final failure for that operation and must not be retried automatically.

## Source Module Map

`src/`
- `app.js`: Browser entry. Registers Lucide icons and defines the single `initialize()` order.
- `network.js`: WebSocket bridge client for network workbench traffic.
- `ssh.js`: SSH bridge client owned by the page runtime.
- `ymodem.js`: YMODEM protocol implementation.
- `styles.css`: Application layout, terminal palette, responsive behavior, and component styling.

`src/lib/`
- `ansi.js`: Pure ANSI/VT style parsing and SGR application helpers.
- `encoding.js`: Base64/byte conversion helpers.
- `format.js`: Shared byte, rate, time, and USB formatting helpers.
- `ssh-path.js`: Pure POSIX path and SSH file metadata helpers.

`src/core/`
- `constants.js`: Shared limits, command lists, storage keys, and default values.
- `dom.js`: DOM element lookup, Lucide icon creation, and shared element registry.
- `errors.js`: Error message normalization.
- `settings.js`: Default settings and persistence primitives.
- `state.js`: Shared mutable application state and session label persistence.

`src/features/`
- `autosave.js`: Log auto-save dialog, rotation, and persistent buffer handling.
- `bridge.js`: Serial-to-network bridge state and forwarding.
- `connection-presets.js`: Serial and network connection preset management.
- `events.js`: All DOM event binding and status-pill interactions.
- `layout.js`: Collapsible sections, mobile layout defaults, and panel grouping.
- `log-view.js`: Log entry rendering, ANSI output, filtering, timestamps, counters, and copy actions.
- `macro.js`: Macro data model, editor, recording state, and list rendering.
- `macro-runtime.js`: Macro playback and timing execution.
- `network.js`: Network peers, receive/send buffers, counters, and network log rendering.
- `network-runtime.js`: Network connection lifecycle and workbench runtime.
- `payload.js`: Text/HEX payload construction, template expansion, and send-count parsing.
- `quick-send.js`: Quick-send item editing, rendering, and connection checks.
- `response-test.js`: Response test workflow and latency display.
- `send-history.js`: Send-history storage and keyboard navigation.
- `serial-runtime.js`: Serial connection lifecycle, receive loop, and auto-send.
- `serial.js`: Serial port discovery, labels, options, and signal state.
- `settings-runtime.js`: Applying, reading, and resetting persisted settings.
- `ssh-presets.js`: SSH preset apply/save/delete and quick-path management.
- `ssh-runtime.js`: SSH connection lifecycle and connect-dialog coordination.
- `ssh.js`: SSH workbench terminal, SFTP browser, transfers, and file operations.
- `template.js`: Built-in/custom template variables and insertion controls.
- `terminal.js`: xterm terminal lifecycle and input forwarding.
- `toast.js`: Toast queue, expiry, and rendering.
- `view-controls.js`: Workspace mode, console view, send/receive controls, and global shortcuts.
- `ymodem.js`: YMODEM UI, progress, and file selection.
- `ymodem-runtime.js`: YMODEM transfer session orchestration.

`src/agent/`
- `bridge-controller.js`: Agent bridge lifecycle and controller callback injection.
- `catalog.js`: Device profiles, task templates, variables, and agent evidence.
- `commands.js`: Business-level device operations exposed to AI commands.
- `device-commands.js`: Connection, serial/network/SSH, bridge, and YMODEM command adapters.
- `events.js`: Agent event capture, waiting, matching, and serialization.
- `execution.js`: Agent command dispatch, operation records, transactions, and task execution.
- `operations.js`: Agent operation lifecycle, approvals, upload scopes, and cancellation.
- `runtime.js`: Agent status snapshots, capabilities, activity rendering, and shared runtime helpers.
- `transactions.js`: Transaction creation, serialization, and undo summaries.
- `ui.js`: Agent dialogs, activity views, MCP configuration, and evidence display.

## Where New Work Goes

1. Serial setting or serial workflow: put pure serial helpers in `features/serial.js`, runtime behavior in `features/serial-runtime.js`, DOM binding in `features/events.js`, and initialization in `app.js` if it needs startup wiring.
2. Network protocol or transport feature: put protocol state/rendering in `features/network.js`, connection/runtime behavior in `features/network-runtime.js`, DOM binding in `features/events.js`, and startup wiring in `app.js`.
3. AI business capability: implement the device operation in `agent/commands.js` or `agent/device-commands.js`, register dispatch in `agent/execution.js`, expose approval/risk behavior in `agent/operations.js`, and keep MCP business tool definitions aligned in the server/MCP layer.
