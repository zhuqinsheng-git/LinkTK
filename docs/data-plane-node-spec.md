# Transport data-plane sink-down spec (SFTP large-file local direct transfer)

Date: 2026-10-08 · Version: v2 · Goal: raise `linktk_transfer_file` large-file transfers from ~0.2 MB/s to LAN-level speed (MobaXterm/psftp class), while keeping the page approval gate, leases and withdrawal control plane, and defining the new local file access boundary.

> v2 revision focus: complete the local path policy, long-task timeout and progress boundary, remote atomic overwrite capability, SFTP packet size/concurrency negotiation, and cancellation and temp-file cleanup rules. The control plane's approval, lease and withdrawal mechanisms keep their original design.

## 0. Background (real-hardware measurements, 2026-10-08)

- Baseline (LinkTK MCP path): 8 MiB download in 39.8 s (~0.2 MB/s), 2 MiB upload in 6.8 s; board TCP retransmits ≈0, RTT 2–7 ms → the network, the board and TCP parameters (including setNoDelay) are not the bottleneck.
- The board's send pacing is only ~150 segments/second; that works out to about **155 ms** per 32 KiB SFTP read, of which ~150 ms is the cost of the lock-step relay "board → ssh-bridge → WS → page JS → WS → agent-bridge → MCP → disk" (pause/wait for ack per block).
- For reference: MobaXterm (PuTTY psftp) = single-process direct connection + SFTP request pipelining + MB-level channel window, tens of MB/s on gigabit LAN.

## 1. Design points

1. **Large-file data never enters the browser**: bytes only travel `board ↔ ssh-bridge (Node, same machine as localPath) ↔ local file system`.
2. **Pipelining + negotiated block size**: N concurrent SFTP read/write requests in flight (16 by default, tunable), initial request block size 256 KiB; the actual block size is `min(requested, ssh2-negotiated max read/write length)`, dropping to 128/64/32 KiB when needed. Not all servers can be assumed to accept 256 KiB.
3. **Control plane preserved**: the page remains the only approval gate; dangerous-operation dialogs, read-only mode, single-writer, leases and withdrawal are all kept. What is added is the local file access rule set defined in section 5.1.
4. **Progress boundary**: the page can receive transfer progress events; in this stage MCP only receives the final `agent:result` and no general `agent:progress` is added. For AI-side long-task queries, use the existing `operation_start/status`.
5. **Explicit local overwrite**: download refuses to overwrite an existing local file by default; only when the caller explicitly passes `overwrite: true` does it enter dangerous-operation approval. Remote overwrite on upload prefers the server's atomic replace capability, falls back to a plain `rename` when the extension is unsupported, and leaves the original target untouched on failure.

```
After the change (illustrative; the actual block size comes from negotiation):
download  board --(16 concurrent SFTP reads × negotiated block)--> ssh-bridge --(direct local fs write to temp file→safe replace)--> localPath
upload    localPath --(direct local fs read)--> ssh-bridge --(16 concurrent SFTP writes × negotiated block, temp file→atomic replace)--> board
control   MCP --single command--> agent-bridge --approval gate + progress UI--> page --path-level messages only--> ssh-bridge
```

## 2. Current path (before the change, for comparison)

**Download**: MCP `downloadBusinessFile` (tools/linktk-mcp.mjs:842) → `sftp_download_open` → page `openSshAgentDownload` (src/app.js:6935) → `state.sshBridge.downloadFile` (src/ssh.js:224) → WS `/__ssh` `sftp:download-start` → **server/ssh-bridge.js:509** (`createReadStream`, `stream.pause()` after each data event, base64 over WS) → the page **accumulates the whole file in memory** (ssh.js `task.chunks`) → stored in `state.sshAgentReadSessions` → MCP then pulls it back chunk by chunk with `sftp_download_chunk` (256 KiB serial, mcp:880) → `writeFileSync(localPath)`.

**Upload**: MCP `uploadBusinessFile` (mcp:761) → ≤1 MiB single-shot `sftp_upload`; otherwise `sftp_upload_begin` + one 256 KiB `sftp_upload_chunk` per request (serial request/response) → page `appendSshAgentUpload` (app.js:6858) accumulates chunks in **page memory** → `finishSshAgentUpload` (6880) assembles a `window.File` → `state.sshBridge.uploadFile` (ssh.js:187) slices it again into 256 KiB pieces → WS `sftp:upload-chunk` → bridge (ssh-bridge.js:445) awaits the `stream.write` callback. Bytes are base64-encoded twice, cross two WS hops, and are lock-step the whole way.

## 3. Change list

### 3.1 `server/ssh-bridge.js` (core)

New WS messages: `sftp:download-to-file`, `sftp:upload-from-local`, `sftp:transfer-cancel`.
New events: `sftp:transfer-begin`, `sftp:transfer-progress`, `sftp:transfer-result`, `sftp:transfer-error`.

Constants at the top of the file (message parameters may override them, for tuning):
```js
const SFTP_FLOW_CHUNK = 256 * 1024;
const SFTP_FLOW_MIN_CHUNK = 32 * 1024;
const SFTP_FLOW_CONCURRENCY = 16;
const SFTP_FLOW_MAX_CONCURRENCY = 32;
```

New internal helpers:

- `negotiateSftpChunkSize(sftp, direction, requested)`: reads the ssh2-negotiated `sftp._maxReadLen` (download) or `sftp._maxWriteLen` (upload) and returns `max(32 KiB, min(requested, negotiatedMax))`. If the library does not provide a valid value, fall back conservatively to 32 KiB. Never hard-code 256 KiB.
- `validateLocalUploadPath(value)` / `validateLocalDownloadPath(value, { overwrite })`: enforce the local path rules of section 5.1; a validation failure must be reported before any remote temp file is created.
- `makeTransferTempPath(localPath, transferId)` / `makeRemoteTempPath(path, transferId)`: temp file names must include a random value or the `transferId`; never use a fixed `path + ".linktk-part"`.
- `replaceRemoteFile(sftp, tempPath, targetPath)`: when the target exists, prefer `ext_openssh_rename`; when the server does not support that extension, fall back to the standard `rename` (OpenSSH's ordinary rename is usually the atomic `rename(2)`); only if the plain rename also fails, report an error. Neither path may delete the target file first.

**Download** `sftp:download-to-file { transferId, path, localPath, maxBytes, chunkSize?, concurrency? }`:
1. `stat` the remote path: a directory → error; `size > maxBytes` → error; `total = size`.
2. Run `validateLocalDownloadPath(localPath, { overwrite })`; open a temp file in the same directory with `makeTransferTempPath(localPath, transferId)` using exclusive `wx` creation; `sftp.open(path, "r")` to get the remote read handle.
3. Register `this.transfers.set(transferId, { kind: "download-local", cancel(), cleanup() })`. `cancel()` only sets the cancel flag; `cleanup()` closes the local/remote handles and best-effort deletes the local temp file.
4. Send `sftp:transfer-begin { transferId, name, total }` first.
5. Compute the block size with `negotiateSftpChunkSize(sftp, "read", chunkSize || SFTP_FLOW_CHUNK)` and start `min(requested concurrency, SFTP_FLOW_MAX_CONCURRENCY)` workers. Each worker loops over the next offset: `sftp.read(handle, buf, 0, len, offset)` (reusing the existing `sftpCall`, ssh-bridge.js:30) → `local.write(buf, 0, n, offset)` (positional write, order-independent) → `done += n`.
6. Throttled progress (one event per ≥200 ms or per whole-block milestone): `sftp:transfer-progress { transferId, direction: "download", done, total }`.
7. On success close both handles. When the target path does not exist, `fs.promises.rename(temp, localPath)` directly; with `overwrite: true`, perform a local safe replace. The actual behavior of `rename` overwriting an existing target on Windows must be handled and tested in the implementation; if the platform does not allow a safe replace, the transfer fails and the original target file is preserved — never "delete the target, then rename".
8. On success send `sftp:transfer-result { transferId, bytes, name, ms }`. On failure/cancel close the handles, best-effort delete the local temp file, and send `sftp:transfer-error { transferId, message }`.
9. Check the cancel flag before each block; once cancelled, stop scheduling new blocks and clean up after the in-flight requests finish.

**Upload** `sftp:upload-from-local { transferId, localPath, path, size?, chunkSize?, concurrency? }`:
1. Run `validateLocalUploadPath(localPath)`; after a local `stat` it must be a regular file. The remote write handle opens at a random temp path, e.g. `makeRemoteTempPath(path, transferId)`, not a fixed `path + ".linktk-part"`.
2. Compute the block size with `negotiateSftpChunkSize(sftp, "write", chunkSize || SFTP_FLOW_CHUNK)` and start `min(requested concurrency, SFTP_FLOW_MAX_CONCURRENCY)` workers: `local.read(buf, 0, len, offset)` → `sftp.write(remoteHandle, buf, 0, n, offset)`.
3. On completion: close the remote handle and use `replaceRemoteFile(sftp, tempPath, path)`.
   - Target does not exist: standard `rename`.
   - Target exists and the server supports `posix-rename@openssh.com`: atomic replace with `sftp.ext_openssh_rename`.
   - Target exists but the extension is unsupported: try the standard `rename` first. If the server maps it to `rename(2)`, it has the same atomic overwrite semantics; only when the plain `rename` also fails, report an error and keep the original target file — never "unlink, then rename".
4. Failure/cancel: close the remote handle and best-effort `sftp.unlink(tempPath)`; no local residue is produced. If temp-file cleanup fails, keep the temp path in the result for the user or AI to handle later.

**Wiring**:
- Add three branches to `handleSftp` (ssh-bridge.js:361 onwards). Note that this method runs on `handle()`'s serial queue (112): **do not await completion inside the method after starting a transfer** — attach the promise to the transfer record, catch it there, and emit events.
- Extend `destroyTransfer` (590) to also call `transfer.cancel?.()`; SSH disconnect/`stop()` goes through `cleanupTransfers` (601) to abort concurrent transfers automatically and run temp-file cleanup.
- `sftp:transfer-cancel` must immediately flag a known transfer as cancelled and emit a final error/result event; repeated cancellation returns an idempotent result. An unknown transfer creates no new state.
- **Keep** all existing `sftp:upload-start/chunk/end` and `sftp:download-start/-data/-end` branches untouched (the advanced MCP tools, the three approval-scope scenarios, and transaction rollback still depend on them).
- Note: ssh2's `createReadStream` issues 32 KiB serial read requests and `fastGet/fastPut` cannot be cancelled — hence the handle + concurrent read/write implementation here (which also gains cancellation, progress, and atomic rename of temp files).

### 3.2 `src/ssh.js`

- New methods:
  - `downloadToLocal({ remotePath, localPath, overwrite, maxBytes, onProgress, signal })`
  - `uploadFromLocal({ localPath, remotePath, size, onProgress, signal })`
  Each sends one message, then listens for `transfer-begin/progress/result` and `transfer-error` for this transferId; `signal` abort → send `sftp:transfer-cancel` and reject with an `AbortError`.
- Add dispatch for the four new events in `handleSftpMessage` (ssh.js:84), at the same level as `sftp:download-data`.
- Leave `uploadFile`/`downloadFile` alone (the old path keeps using them).

### 3.3 `src/app.js` (page = approval gate + UI)

- Add `"sftp_download_to_file"` to `AGENT_READ_COMMANDS` (app.js:498); add `"sftp_upload_from_file"` to `AGENT_DANGEROUS_COMMANDS` (529); add labels to `AGENT_COMMAND_LABELS` (547) (e.g. "AI download file to local" / "AI upload local file"), and include remotePath / localPath / size in the approval dialog details.
- Add a dynamic branch to `getAgentCommandRisk(command, params)` that calls the `isReadOnlyAgentTransfer(command, params)` helper shared with agent-bridge: `sftp_download_to_file` is `read` when `overwrite !== true`, and `dangerous` when `overwrite === true` because it replaces an existing local file. Other commands keep the existing set-based classification.
- Add two branches + two handlers to `executeAgentCommand` (app.js:8770 area):
  - `downloadSshFileToLocalForAgent(params, context)`: ensureAgentSshConnected → `requireSafeSshAgentPath(params.path)` → open the file panel → `beginSshFileTransfer` → `state.sshBridge.downloadToLocal({...overwrite: Boolean(params.overwrite), signal: context.signal, onProgress → updateSshFileProgress})` → refresh the directory, toast, return `{ path, localPath, bytes, name }`.
  - `uploadSshFileFromLocalForAgent(params, context)`: same shape, calling `uploadFromLocal`, returning `{ path, localPath, bytes }`.
- This path **no longer** uses `state.sshAgentUploads` / `state.sshAgentReadSessions` and builds no `window.File`/`Blob`.
- Add a page-side size cap constant (aligned with MCP, suggest `MAX_SSH_LOCAL_TRANSFER_BYTES = 2 * 1024 ** 3`); leave the old `MAX_SSH_AGENT_TRANSFER_BYTES` as-is for the old path.
- Cancellation of `context.signal` must travel all the way to the SSH bridge; page cancellation, AI withdrawal and approval timeout all call the same `sftp:transfer-cancel` path.

### 3.4 `server/agent-bridge.js`

- Raise `MAX_TIMEOUT_MS` (agent-bridge.js:18) to 30 minutes for large-file transfers; do not confuse it with the default timeout of ordinary short commands.
- Add `"sftp_download_to_file"` to `READ_ONLY_COMMANDS` (agent-bridge.js:21, used only for exclusive-lease decisions, 604) and call the same `isReadOnlyAgentTransfer(command, params)` helper shared with the page: only `overwrite !== true` may be treated as read-only; `overwrite: true` replaces a local file and must obey the write-operation lease and approval gate.
- Do not add `"sftp_upload_from_file"` (a write operation; it should be rejected under a lease).

### 3.5 `tools/linktk-mcp.mjs`

- Raise `MAX_TIMEOUT_MS` (mcp:16) to 30 minutes and keep the `operation_start` path as the long-task query/cancel entry point.
- Change the SFTP branch of `downloadBusinessFile` (mcp:842) to **one** request:
  ```js
  await client.request(
    "sftp_download_to_file",
    {
      transport: "ssh",
      path: remotePath,
      localPath,
      overwrite: Boolean(overwrite),
      maxBytes: Math.min(maxBytes, MAX_BUSINESS_TRANSFER_BYTES),
    },
    transferApprovalTimeout(size),
  );
  ```
  Delete the open/chunk/close loop and the local `Buffer.concat` / `writeFileSync` (the bridge writes directly now). Leave the ymodem branch untouched.
- `uploadBusinessFile` (mcp:761): change the >1 MiB branch to **one** request `sftp_upload_from_file { transport: "ssh", path: remotePath, localPath, size }`; the timeout is computed dynamically and the same value is the approval dialog countdown, so do not set it too small: `transferApprovalTimeout(size)`, capped at 30 minutes. Keep the old `sftp_upload` for ≤1 MiB (behavior unchanged, tests need no update).
- Add an optional parameter `overwrite: boolean = false` to `linktk_transfer_file`. Downloading to an existing path requires an explicit `true`, otherwise the bridge returns `EEXIST`; approval and remote-extension capability decisions for remote overwrite on upload remain in the bridge.
- `MAX_BUSINESS_TRANSFER_BYTES` (mcp:22) 16 MiB → **2 GiB** (the `.max()` of the transfer_file schema follows the constant, mcp:1349; the 100 MB scenario is currently blocked by exactly this limit). The 1 MiB YMODEM limit is unchanged.
- Before raising the limit, move `readFileSync(localPath)` inside the `<= MAX_INLINE_TRANSFER_BYTES` branch of `uploadBusinessFile`; the SFTP path for files >1 MiB must never read the whole file into memory first, or the 2 GiB schema will cause OOM.
- `SFTP_CHUNK_BYTES` (mcp:23) is no longer used on the new path; keep it if the advanced tools starting at mcp:2552 still reference it.
- Optional: validate locally that the parent directory of `localPath` exists first, for a friendlier error (the bridge must still validate and report clearly).

Timeouts are generated uniformly by this rule; download uses `maxBytes` as the size hint:

```js
function transferApprovalTimeout(sizeHint) {
  const bytes = Math.max(0, Number(sizeHint) || 0);
  const businessMs = Math.max(
    120000,
    120000 + Math.ceil(bytes / (1024 * 1024)) * 5000,
  );
  return approvalTimeoutMs(Math.min(30 * 60 * 1000, businessMs));
}
```

### 3.6 Explicitly untouched

- The old full chunk paths (`sftp_upload_begin/chunk/end`, `sftp_download_open/chunk/close`, the bridge's `sftp:upload-*`/`sftp:download-*`): kept. The advanced MCP tools and the three approval-scope tests (TTL/interrupt/disconnect) all depend on them, and the regression must stay green.
- Transaction rollback (`prepareTransactionUndo` app.js:7407, `applyTransactionUndo` 7485, which has the small `MAX_TRANSACTION_BACKUP_BYTES` cap) and the ymodem path: untouched.
- Single-writer / leases / operations (`linktk_operation_*`) / withdrawal: untouched; the new commands naturally go through the same machinery.
- Network layer (TCP parameters etc.): untouched (retransmits are already ≈0 and unrelated to this work).

## 4. Acceptance

**Numbers (real hardware, over the MCP path, verified by the tester)**
- 8 MiB download: target ≤3 s (currently 39.8 s); 2 MiB upload: target ≤2 s (currently 6.8 s); also run one upload ≥100 MB (currently blocked by the limit; it must complete).
- During the transfer the PC NIC should show a smooth high-rate curve; board TCP retransmits should not increase noticeably.

**Behavior**
1. confirm-writes: upload raises **1** approval dialog (with local/remote paths and size); deny → fails without auto-retry; approve → completes. Download to a new path raises no dialog.
2. Download to a non-existent local path: no dangerous-approval dialog, and the file exists afterwards. Download to an existing local path without `overwrite: true`: the bridge returns `EEXIST` and the original file is unchanged. `overwrite: true`: a dangerous-approval dialog is raised, and the original file is unchanged after a denial.
3. read-only: upload is rejected outright; download to a new path works; download over an existing local file is rejected.
4. SSH disconnect / withdrawal-cancel mid-transfer: the operation fails; the local random temp file must be cleaned up; the board-side random temp file is best-effort cleaned up; a retry must be approved again (no leftover scope).
5. Overwriting an existing remote file: succeeds via atomic replace when the server supports `posix-rename@openssh.com`; falls back to the standard `rename` when it does not, still counted as atomic on success, and leaves the original file unchanged on failure.
6. A local path that is not absolute, is a directory, is a symlink/reparse point, is under a system pseudo path, or a remote target that is a directory: all fail before data transfer starts.
7. Page memory does not grow with file size, and the page stays interactive during the transfer (no more whole-file-in-page).
8. Page-side progress updates are visible; MCP receives only the final result. A transfer started with `operation_start` can be queried with `operation_status` and cancelled.

**Regression**
- `npm run test:mcp` / `test:ssh` / `test:coordination` / `test:ymodem` all green (old paths untouched).
- tests/ssh.mjs additions: a bridge-level round trip of the new messages (≥1 MiB of random content, hashes match after landing) + a cancellation-cleanup case; invalid local path, overwrite, and temp-file cleanup cases.
- tests/mcp.mjs additions: a `linktk_transfer_file` large-file case (≥2 MiB, ensuring the new path is used) + an assertion that the 2 GiB schema does not trigger a whole-file `readFileSync`; positive/negative cases for the `overwrite` parameter.
- tests/coordination.mjs additions: lease/read-only decisions for `sftp_download_to_file` under `overwrite`; the approval scope of `sftp_upload_from_file` is unaffected by the old upload path.

## 5. Notes

- **After changing files under `server/`, `npm run dev` must be restarted**: in practice vite does not restart automatically (the last round measured old code exactly this way). Files under `src/` go through HMR.
- `handleSftp` is a serial queue: after starting a new transfer, do not await its completion inside that method.
- Local path safety is in section 5.1; **never send local file contents back over the WS**.
- Progress events are the only transfer data that flows through the page; keep the messages small and throttled (≤5 per second).
- Keep a tuning entry point (chunkSize/concurrency can be passed with the message) for later real-hardware tuning.

### 5.1 Local path policy

This stage introduces no global directory allowlist, because large-file transfer must let the user and the AI access local files the user explicitly specifies; the safety boundary is made up of the following rules together. If multi-user or remote-browser support is added later, this must be re-evaluated and a root-directory allowlist added.

1. MCP converts `localPath` to an absolute path with `path.resolve(localPath)` before sending the command. The bridge only accepts absolute paths and rejects empty paths, the root directory, directory paths ending in `.`, and paths containing NUL.
2. The upload source and the download target must be regular files. Resolve and check the upload source with `realpath` beforehand, rejecting symlinks, Windows reparse points, directories and device files. When the download target does not exist, its parent directory must exist and be writable; when the download target exists, only `overwrite: true` allows continuing, and the target must not be a symlink, directory or special file.
3. Reject the Windows device namespace (`\\.\`, `\\?\GLOBALROOT`), UNC paths and POSIX system directories (`/proc`, `/sys`, `/dev`) by default. These paths need a separate authorization design later and are not implicitly allowed by this spec.
4. A local temp file must live in the same directory as the target file, have a name containing the `transferId` or a random value, and be created exclusively with `wx`. Failure, cancellation, SSH disconnect or process-exit cleanup must all best-effort delete temp files.
5. Upload is a dangerous operation and must go through page approval. Download to a new file raises no dangerous-approval dialog; download over an existing file is a dangerous operation and must show the resolved absolute path, the size, and a "will overwrite the local file" warning.
6. A local path validation failure must be returned before the remote temp file is opened. Between validation and the actual read/write, still rely on the operating system's `lstat`/`realpath` results; never rely on front-end string checks alone.

## 6. Suggested implementation order

0. Restart `npm run dev`, re-measure the current baseline first, and only enter this spec's implementation when the existing `setNoDelay` still does not meet the target.
1. ssh-bridge local path validation, temp files, remote atomic replace helper
2. ssh-bridge concurrent transfer engine + new messages (with cancellation, cleanup, progress)
3. src/ssh.js new methods
4. src/app.js commands, dynamic risk, approval details, handlers, cancellation passthrough
5. agent-bridge timeout/lease classification + MCP tool rewrite, `overwrite` and the 2 GiB limit
6. Test additions
7. Hand over for real-hardware re-measurement (download/upload benchmarks + overwrite/cancel/disconnect + the three-scenario regression + four suites green)
