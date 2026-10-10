# LinkTK AI Agent Operator Manual

This document is for AI agents that need to operate serial devices through LinkTK. The goal is not to bypass the browser, but to let the AI read and write the serial port through the already-open LinkTK page, so that every operation, every byte sent, and every device response stays visible to a human in the page.

## 1. Boundaries

- The AI can call `linktk_launch` first to start the local LinkTK service and open a desktop Chrome or Edge page automatically.
- The user only has to complete the browser's Web Serial authorization the first time a given serial port is used. After that, the AI can reconnect by port or by serial preset.
- The AI cannot complete the browser's serial permission chooser for the user, and must not open the same COM port directly from another process.
- Only one AI write operation runs at a time. Read-only queries, log observation and response waits can run in parallel with a write; a second write returns "Another AI write operation is already running."
- With multiple LinkTK pages open, always list and select the target `sessionId` first; do not rely on "the last page opened".
- The default approval policy is "writes require confirmation". The AI must not attempt to bypass the page's pause, read-only, or human confirmation gates.
- The default control URL is `ws://127.0.0.1:5173/__agent-control`.
- The control channel uses the random token in `~/.linktk/agent-token` and validates the page Origin. The Agent CLI and MCP read the token automatically; never expose that token from the browser, logs, or project files.
- The Agent CLI keeps protocol-level commands; MCP exposes only business-goal tools by default, covering serial, TCP/UDP, YMODEM, Macro, the link bridge, the SSH terminal and SFTP file operations.
- Use the default MCP tools by capability — connect a target, execute, observe, transfer, replay, bridge — rather than mechanically mapping every UI button to one tool call.
- The AI never connects to the target device directly. All SSH/SFTP operations run through the already-open LinkTK page, so the user can see terminal output, file listings and transfer progress.

## 2. Pre-flight checks

If the LinkTK service or page is not open yet, run:

```text
linktk_launch
```

This tool checks the local `5173` service, starts the service and opens the browser if needed, then waits for a LinkTK page session. When only one page exists it is selected automatically.

Once the page is ready, run:

```powershell
npm run agent -- status
```

Check carefully:

- whether `connected` is `true`
- whether `port` is the target COM port
- whether `baudRate` matches the device
- whether `consoleView` is currently `log` or `terminal`
- `cursor`, the current receive event cursor
- `rxBytes` and `txBytes` as the troubleshooting baseline

If `connected` is `false`, run `linktk_targets` first to see authorized serial ports, connection presets and available targets. An authorized port can be connected directly with `linktk_connect`; if the port has not been authorized yet, have the user complete one system chooser in the LinkTK page — the AI cannot bypass that permission dialog.

## 3. Commands

### 3.0 serial

The default MCP surface uses the unified target catalog:

```text
linktk_targets(transport="all")
```

Connect and disconnect:

```text
linktk_connect(transport="serial", portIndex=0, baudRate=115200)
linktk_connect(transport="serial", presetName="COM12 debug")
linktk_disconnect(transport="serial")
```

`linktk_connect` supports `presetId`, preset name, `portIndex`, port label, baud rate, data bits, stop bits, parity, flow control, DTR and RTS, and covers TCP/UDP and SSH through the same interface. An unauthorized port returns a clear error; it never fakes a user click.

The Agent CLI can still use protocol-level commands:

```powershell
npm run agent -- serial-connect --port-index 0 --baud 115200
npm run agent -- serial-connect --name "COM12 debug"
npm run agent -- serial-disconnect
```

If the legacy protocol-level MCP tools are needed, set `LINKTK_MCP_ADVANCED=1` before starting the MCP process to keep using `linktk_serial_*`, `linktk_network_*`, `linktk_ssh_*`, `linktk_sftp_*` and `linktk_ymodem_*`.

### 3.1 status

Read the current LinkTK and serial state:

```powershell
npm run agent -- status
```

Useful for confirming the serial port, baud rate, console view, RX/TX counters and event buffer state.

### 3.2 send

Send data without waiting for a specific response:

```powershell
npm run agent -- send --text "help" --ending lf
npm run agent -- send --text "AA 55 01" --hex --ending none
```

Options:

- `--ending none|lf|cr|crlf`, default `lf`
- `--hex` to parse the data as hexadecimal
- `--data`, equivalent to `--text`

On success it returns the actual bytes sent, their HEX, and the current event cursor.

### 3.3 wait

Wait for the expected text to appear in the receive area:

```powershell
npm run agent -- wait --expect "login:" --timeout 10000
npm run agent -- wait --expect "^root@" --mode regex --timeout 5000
```

Options:

- `--expect` or `--pattern`
- `--mode contains|regex`, default `contains`
- `--case-sensitive`
- `--direction rx|tx|all`, default `rx`
- `--since` to specify the event cursor
- `--timeout` in milliseconds, default 5000

### 3.4 read

Read the current event buffer:

```powershell
npm run agent -- read
npm run agent -- read --since 12 --limit 100
npm run agent -- read --wait 1000
```

Returns the text, the event array and the new `cursor`. Pass the previous `cursor` as `--since` on the next read so old content is not read twice.

### 3.5 exec

Send data and wait for a matching response — the recommended way to run shell commands:

```powershell
npm run agent -- exec --data 'printf "LINKTK_%s\n" AGENT_OK' --expect "LINKTK_AGENT_OK" --timeout 8000
npm run agent -- exec --text "uname -a" --expect "Linux" --timeout 8000
```

`exec` records the current event cursor first, then sends, then waits for the RX match, so old log lines from before the execution are never mistaken for this response.

Options:

- `--expect` or `--pattern`
- `--mode contains|regex`
- `--case-sensitive`
- `--timeout` in milliseconds
- `--capture-ms` to keep waiting after a match, collecting the rest of the same output batch
- `--ending none|lf|cr|crlf`
- `--hex`

The result contains:

- `sent`: bytes sent and their HEX
- `matched`: whether the match succeeded
- `timedOut`: whether it timed out
- `text`: the full text received during this execution
- `cursor`: the new cursor to use for subsequent reads
- `events`: receive events as split by the serial port

### 3.6 network

TCP/UDP uses its own event cursor and never shares the serial `cursor`. Common commands:

```powershell
npm run agent -- network-status
npm run agent -- network-presets
npm run agent -- network-connect --protocol tcp --role client --host 127.0.0.1 --port 9000
npm run agent -- network-send --text "PING" --ending lf
npm run agent -- network-wait --expect "PONG" --timeout 5000
npm run agent -- network-read --since 0 --limit 100
npm run agent -- network-exec --text "STATUS" --expect "OK" --timeout 5000
npm run agent -- network-disconnect
```

`network-connect` also accepts `--preset-id` or `--name` to use a network preset saved in the page. The TCP server, UDP server and clients are all held by the LinkTK page; the AI never creates a second listening port itself.

### 3.7 YMODEM

YMODEM transfers files over the already-open serial port:

```powershell
npm run agent -- ymodem-status
npm run agent -- ymodem-send --file .\firmware.bin --block-size 1024
npm run agent -- ymodem-receive --output .\received.bin --max-bytes 1048576
npm run agent -- ymodem-cancel
```

A single YMODEM upload is limited to 1 MiB. A received file returns up to 1 MiB of base64 by default; beyond that limit the download is only triggered in the page, to keep MCP messages from growing too large. During a YMODEM transfer, do not send serial data, replay a Macro or start the bridge in parallel.

### 3.8 Macro

The AI can create, view, replay and delete Macros:

```powershell
npm run agent -- macro-list
npm run agent -- macro-create --name "Boot" --steps "[{\"type\":\"text\",\"data\":\"help\\r\"}]"
npm run agent -- macro-run --name "Boot" --command-delay 500 --character-delay 0
npm run agent -- macro-delete --name "Boot"
```

Replay is a write operation and goes through the page approval policy. When the current AI operation is cancelled, Macro replay stops as soon as possible; never use a Macro as a way around the serial send confirmation.

### 3.9 Link bridge

The bridge requires both the serial port and a plain TCP/UDP session to be connected:

```powershell
npm run agent -- bridge-status
npm run agent -- bridge-start --serial-to-network --network-to-serial
npm run agent -- bridge-stop
```

`bridge-status` returns `serialReady`, `networkReady`, the current directions and cumulative bytes. SSH mode does not support bridging.

## 4. Sessions, snapshots and operation lifecycle

### 4.1 Session selection

First list the LinkTK pages currently connected to the local bridge:

```text
linktk_sessions
```

Every page has its own `sessionId`, label, operation target and capabilities. When more than one page exists, a selection is required:

```text
linktk_select_session(sessionId="...")
```

The MCP process keeps using that selection for subsequent requests. The Agent CLI can pass it per command:

```powershell
npm run agent -- status --session "<sessionId>"
```

### 4.2 Full snapshot

Do not rely on a single serial connection state. Before starting work, read:

```text
linktk_snapshot
```

The snapshot contains session identity, serial, TCP/UDP, SSH, SFTP, UI filters, the bridge, auto-save, AI pause state, approval policy, the current operation and recent operation records. The `session.id` in the snapshot should match `linktk_select_session`.

### 4.3 Trackable and cancellable operations

Short commands can call the corresponding MCP tool directly. For long waits, continuous capture, or tasks that need independent tracking, use:

```text
linktk_operation_start
linktk_operation_status
linktk_operation_cancel
linktk_operations
```

`linktk_operation_start` returns an `operationId` immediately, and the final result is obtained by polling the status. The user can see the operation target, state, elapsed time and result summary in the page's "AI activity" panel, and can cancel the current operation there too.

### 4.4 Human approval and pause

The page offers three policies:

- `read-only`: only status, logs and read-only queries; writes are rejected.
- `confirm-writes`: serial sends, command execution, SSH connections and SFTP modifications raise a confirmation dialog.
- `trusted`: the current page trusts the AI and does not prompt per operation, but "pause AI" can still not be bypassed.

While the page shows "AI paused", read-only queries still run but writes are blocked immediately. An operation the user denied must be treated as failed; do not resubmit it automatically.

Under `confirm-writes`, read `agent.approvalMode` and `agent.pendingApproval` via
`linktk_snapshot` before starting a write. For writes, use a `timeoutMs` of at least
`60000` so the user has enough time to confirm; MCP adds an additional approval grace
period on top, `180000` milliseconds by default, adjustable with
`LINKTK_APPROVAL_GRACE_MS`.

When the approval wait times out, the AI controller disconnects, or the request is
withdrawn, the page closes the approval dialog immediately, releases the write lock,
and guarantees the device does not execute the operation. The recorded final state is
then `withdrawn`, meaning "not executed, safe to retry". When the user explicitly
clicks "Deny", the recorded final state is `blocked` — a terminal result; the AI must
not retry automatically. If the controller disconnects after the operation reached
`running`, the device operation is not forcibly interrupted, but the record carries
`deliveryState="result-undelivered"`, meaning the result was not delivered; the AI
should re-read the device state before deciding the next step.

**Do not judge results by error prose.** The UI language can be switched to English,
and operation states, error descriptions and other text change with the language;
every operation record returned by `linktk_operation_status` / `linktk_operations`
carries a stable `errorCode` field (when an operation is blocked immediately, an error
message is returned first — call `linktk_operation_status` afterwards to read the
`errorCode`):

- `user-denied`: the user explicitly denied in the approval dialog. Terminal; do not retry automatically.
- `policy-denied`: the page is in read-only policy and the write was denied. Terminal; do not retry automatically.
- `approval-timeout`: the approval window timed out; the operation was not executed. Safe to retry.
- `withdrawn`: the controller disconnected or the request was withdrawn; the operation was not executed. Safe to retry.
- `cancelled`: the operation was cancelled via `linktk_operation_cancel`.
- `paused`: the page is in "AI paused" and the write was blocked; retry after the user resumes.
- `busy`: another write operation is in flight and this one was blocked; retry later.

In all other cases `errorCode` is an empty string.

A chunked SFTP upload is approved once per upload session: after `sftp_upload_begin`
completes human approval, subsequent `sftp_upload_chunk` and `sftp_upload_end` calls
with the same `uploadId` do not prompt again, and the operation record shows
`approval` as `approved-scope`; the scope is cleared when the upload session ends,
SSH disconnects, or the approval policy leaves `confirm-writes`.

> The new `linktk_transfer_file` large-file SFTP path no longer uses the chunked
> interface above; `server/ssh-bridge.js` reads and writes local files directly. An
> upload still raises one approval dialog as a dangerous operation; downloading to a
> new local path is read-only, and downloading over an existing local path requires
> `overwrite=true` explicitly and enters dangerous-operation approval. The old
> `sftp_upload_begin/chunk/end` and advanced MCP tools remain compatible.

### 4.5 Multi-controller coordination

Every MCP/CLI controller gets its own `controllerId` on connect. Before writing to the same page, claim an exclusive lease with `linktk_session_claim`:

```text
linktk_session_claim(sessionId="...", mode="exclusive", ttlMs=300000)
```

While the lease is active, other controllers' serial sends, transactions, task
replays and SFTP modifications are rejected, but read-only queries such as
`status`, `snapshot`, `read` and `wait` keep working. `sftp_download_to_file`
counts as read-only when `overwrite !== true`, so downloading to a new local file is
allowed under someone else's exclusive lease; `overwrite: true` replaces a local file
and is a write. Release promptly with `linktk_session_release` when done; the bridge
releases the lease automatically when the controller disconnects or the lease
expires. `linktk_leases` shows the current leases, and `force=true` is only for
taking over the lease of an unresponsive controller after confirming.

A lease is not a substitute for device safety permission. The page's pause, read-only,
write confirmation and user denial still take precedence, and a denied operation must
never be retried automatically.

### 4.6 Device Profiles

A device Profile pins down the target device's semantics so the AI does not have to guess every time:

- `linktk_device_profile(action="list")`: list Profiles.
- `linktk_device_profile(action="upsert", name="...", transport="...")`: create or update a Profile.
- `linktk_device_profile(action="select", profileId="...")`: select the current Profile by `profileId` or `name`.
- `linktk_device_profile(action="delete", name="...")`: delete a Profile.

A Profile contains the board name, the applicable `serial/network/ssh` transport, the `linux/rtos/uboot/raw` shell type, the default line ending, the prompt regex, login/boot hints, common commands and dangerous patterns. Send commands without an explicit `ending` use the current Profile's line ending. After switching devices or transports, read `linktk_snapshot` first to confirm `deviceProfile`.

### 4.7 Transactions, task templates and evidence

When multiple steps are needed, prefer a transaction over firing several unrelated MCP requests in a row:

```text
linktk_transaction(action="execute", ...)
```

A transaction executes its steps in order and records the result of each one. SFTP upload, delete, rename and empty-directory creation provide recovery-style rollback; serial, SSH and network commands are irreversible by default, and an atomic transaction rejects such steps by default. Only use `allowIrreversible=true` when the device state and inputs are fully known, or turn `atomic` off and accept partial execution.

`linktk_task` can create, list, replay and delete task templates. Every operation and transaction exposes an evidence bundle through `linktk_evidence`, containing the request, pre-execution state, post-execution state, result, error and replayable steps; the page activity panel can also export it as JSON. Evidence bundles automatically hide passwords, keys and large base64 content — do not put sensitive information into ordinary string parameters.

## 5. Recommended workflow

1. Use `status` to confirm the target serial port and connection state.
2. Confirm the shell with a side-effect-free command, such as `printf "LINKTK_%s\n" AGENT_OK`, and wait for the actual output `LINKTK_AGENT_OK`.
3. Judge command completion by explicit response markers, not by prompts that vary between systems.
4. When developing or modifying files, write the content to a temporary file each time, check the exit code, and then replace the target file.
5. Run the minimal verification command immediately after each change.
6. Use `read --since <cursor>` to look for missed output; never mistake old logs for a new response.
7. Commands with long or continuous output should use a timeout so the AI request cannot hang forever.

## 6. File transfer

### 6.1 SSH/SFTP MCP

LinkTK's MCP server can be started with `npm run mcp`, or registered in Codex's `mcp_servers` configuration. Common tools:

- `linktk_sessions`: list operable pages and session IDs.
- `linktk_launch`: start the local service, open the page and wait for a session.
- `linktk_select_session`: select the page session for subsequent operations.
- `linktk_session_claim/release/leases`: coordinate multiple AI controllers writing to the same page.
- `linktk_snapshot`: read the full operable state.
- `linktk_operation_start/status/cancel`: manage long-running operations.
- `linktk_targets`: list serial, network and SSH presets.
- `linktk_connect` / `linktk_disconnect`: unified connect and disconnect for serial, TCP/UDP and SSH.
- `linktk_execute`: send data and optionally wait for a response.
- `linktk_observe`: incrementally read or wait for device output by cursor.
- `linktk_transfer_file`: run SFTP or YMODEM file transfers between the local machine and the target device.
- `linktk_macro`: list, create, replay and delete Macros.
- `linktk_bridge`: view, start and stop the bidirectional link bridge between serial and TCP/UDP.
- `linktk_device_profile`: manage device Profiles.
- `linktk_transaction`: execute multi-step transactions and view records.
- `linktk_task`: manage reusable task templates.
- `linktk_evidence`: read operation evidence bundles and replayable steps.

Prefer `linktk_execute` with a unique completion marker for running commands; do not rely on the shell prompt alone.
The SFTP large-file path of `linktk_transfer_file` sinks the data plane to the local SSH
bridge; a single business transfer is limited to 2 GiB and a single YMODEM upload to
1 MiB. SFTP upload does not overwrite an existing remote file by default, and SFTP
download does not overwrite an existing local file by default; when overwriting is
really needed, pass `overwrite: true` explicitly and wait for page approval.
`overwrite` does not affect YMODEM — device-side write and overwrite semantics are
determined by the shell command and the board's file system.

The default MCP surface has 23 business tools. `linktk_serial_*`, `linktk_network_*`, `linktk_ssh_*`, `linktk_sftp_*` and `linktk_ymodem_*` are advanced compatibility interfaces, exposed only when `LINKTK_MCP_ADVANCED=1` is set.

MCP tools also provide `readOnlyHint`, `destructiveHint` and `idempotentHint`. AI clients should use these annotations for pre-call hints, but must not treat them as permission control; the page approval mode, pause state and session lease still take precedence.

Recommended connection order:

1. Call `linktk_targets(transport="ssh")` and pick the target preset.
2. Call `linktk_connect(transport="ssh", presetId="...")` to connect. If the preset has no saved password, supply it in this call.
3. Call `linktk_execute(transport="ssh", ...)` with a uniquely marked command to confirm the remote shell works.
4. Use `linktk_transfer_file` to upload or download files; enable the advanced SFTP tools or use remote shell commands only when directory browsing is needed.

### 6.2 Serial base64 chunking

A serial terminal is not suited to pasting large files directly. To deploy a local file to the board, use base64 chunks:

1. Create the target directory and a temporary file first.
2. Use `stty -echo` to turn off remote terminal echo.
3. Send the base64 content in chunks of roughly 768 to 1024 characters.
4. Run `printf '%s' '<chunk>' >> /tmp/name.b64` for each chunk, and wait for a unique marker that cannot appear in the command text itself.
5. After everything is written, run `base64 -d /tmp/name.b64 > /target/name`.
6. Run the syntax check for the target language, for example `python3 -m py_compile`.
7. Restore `stty echo` in a `finally` block or failure handler so the serial terminal does not lose input echo.

Note: `stty -echo` only disables echo on the device side; LinkTK still shows the chunks the AI sent in the TX/AI log. Do not mistake a base64 chunk for a device response.

## 7. Shell interaction guidance

### 7.1 Do not rely on prompts, and do not let command echo masquerade as a completion marker

After the device echoes a command to the serial port, the echo enters the RX event stream and shares the same `events` and `text` as the real execution result. This is not a bridge error and should not be filtered automatically, because some devices use the echo itself as an interaction signal. The AI must use a split marker to tell "the command text echoed back" apart from "the command actually finished executing".

Different devices may use `#`, `$`, `root@board:/#` or a custom prompt. Prefer a unique marker, but remember that a serial terminal usually echoes the command. If you send:

```text
echo LINKTK_STEP_DONE
```

then the `LINKTK_STEP_DONE` in the echo may appear before the real execution result, causing `wait` or `exec` to report a false success. Split the marker inside the command instead:

```text
printf "LINKTK_%s\n" STEP_DONE
```

The command echo then contains only `LINKTK_%s` and `STEP_DONE`, and only the actual output forms the complete `LINKTK_STEP_DONE`. Then:

```powershell
npm run agent -- exec --data 'printf "LINKTK_%s\n" STEP_DONE' --expect "LINKTK_STEP_DONE" --timeout 5000
```

In Windows PowerShell, pass commands containing spaces and shell quotes to `--data` in single quotes. Do not rely on `\"` to protect double quotes in PowerShell; it may be split into multiple arguments and leave the device at a `>` continuation prompt.

### 7.2 Check command exit codes

When you need to confirm whether a command succeeded, use an explicit status:

```text
command && printf "LINKTK_%s\n" STATUS_OK || printf "LINKTK_%s\n" STATUS_FAIL
```

### 7.3 Interactive login

Do not repeatedly send passwords or retry an unknown state. Wait for the prompt first:

```powershell
npm run agent -- wait --expect "login:" --timeout 10000
```

After confirming the prompt, send the username or password. Passwords appear in the LinkTK log, so warn the user first when real credentials are involved.

### 7.4 Control characters

The current CLI does not provide discrete Ctrl key events. Do not assume sending the text `Ctrl+C` is the same as the keyboard control key. To send specific bytes, confirm the protocol first, then send precisely with `--hex`. For example, when the device is stuck at a shell `>` continuation prompt, you can send ASCII ETX:

```powershell
npm run agent -- send --hex --text "03" --ending none
```

## 8. Safety rules

- Do not run multiple serial-writing commands in parallel.
- Do not automatically execute commands that format storage, break firmware, delete system directories or modify boot partitions.
- Do not write user passwords, keys or tokens into project files, test snapshots or persistent logs.
- Back up the original file before modifying a device file, and keep the restore command.
- For reboots, flashing, network configuration and permission changes, explain the impact first and let the user confirm.
- AI sends are shown with a prominent `AI` marker; never try to hide AI operations.

## 9. Common errors

### What the top-bar AI status means

- `AI offline`: the browser page is not connected to the local `/__agent` control bridge.
- `AI pairing`: the WebSocket is open, but the browser has not yet received the bridge's ready confirmation.
- `AI ready`: the LinkTK page has received the local control bridge's ready confirmation and is waiting for an AI controller to connect.
- `AI online`: an AI controller has connected to `/__agent-control` and can execute commands.
- `AI running`: an AI controller has issued a command and LinkTK is executing it.

### Cannot connect to the control URL

Check:

- whether the LinkTK service is running on `127.0.0.1:5173`
- whether the page is still open
- whether a wrong `LINKTK_AGENT_URL` is set
- whether the LinkTK service was started under the same user; the default token file is `~/.linktk/agent-token`
- if `LINKTK_AGENT_TOKEN` is set, the service and the Agent CLI/MCP must use the same value

### No LinkTK page is available

The browser page has been closed, is reloading, or has not finished initializing. Reopen the page and wait for the top bar to show "AI ready".

### Another AI write operation is already running

Another write operation has not finished. Wait for it to complete, or check first whether the device is waiting for input; read-only observation and response waits do not need to wait for the write.

### matched is false

Check:

- whether the command executed at all
- whether the expected text matches the actual output's case
- whether `--capture-ms` is needed to collect split fragments
- whether the device is still booting, logging in, or waiting for other input

## 10. Example: developing a small script on a Linux shell

Verify the shell first:

```powershell
npm run agent -- exec --data 'printf "LINKTK_%s\n" AGENT_OK' --expect "LINKTK_AGENT_OK" --timeout 8000
```

Before writing the script, check the directory and tools:

```powershell
npm run agent -- exec --text "uname -a" --expect "Linux" --timeout 8000
```

After running the script, confirm completion with an independent marker:

```powershell
npm run agent -- exec --data 'python3 ./linktk_probe.py; printf "LINKTK_%s\n" PROBE_DONE' --expect "LINKTK_PROBE_DONE" --timeout 10000
```

This document only defines how to operate; it does not replace engineering judgment about device state, command side effects and failure rollback.
