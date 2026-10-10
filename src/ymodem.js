import { t } from "./core/i18n.js";

export const YMODEM = Object.freeze({
  SOH: 0x01,
  STX: 0x02,
  EOT: 0x04,
  ACK: 0x06,
  NAK: 0x15,
  CAN: 0x18,
  CRC: 0x43,
  CPMEOF: 0x1a,
  HEADER_SIZE: 128,
  DEFAULT_BLOCK_SIZE: 1024,
});

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const ONE_SHOT_CAN_GRACE_MS = 250;

export function crc16Xmodem(input) {
  let crc = 0;

  for (const byte of input) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc;
}

function checksum(input) {
  let sum = 0;
  for (const byte of input) sum = (sum + byte) & 0xff;
  return sum;
}

function padBlock(input, size, fill = YMODEM.CPMEOF) {
  if (input.byteLength > size) {
    throw new YmodemError(
      t("ymodem.session.blockTooLarge", { size: input.byteLength, limit: size }),
      "BLOCK_TOO_LARGE",
    );
  }

  if (input.byteLength === size) return input.slice();

  const block = new Uint8Array(size);
  block.fill(fill);
  block.set(input, 0);
  return block;
}

function concatBytes(chunks, totalLength) {
  const output = new Uint8Array(totalLength);
  let offset = 0;

  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  });

  return output;
}

function trimFilePadding(input, expectedSize) {
  if (Number.isFinite(expectedSize) && expectedSize >= 0) {
    return input.slice(0, Math.min(input.byteLength, expectedSize));
  }

  let end = input.byteLength;
  while (end > 0 && input[end - 1] === YMODEM.CPMEOF) end -= 1;
  return input.slice(0, end);
}

function normalizeFilename(value) {
  const name = String(value || "")
    .split(/[\\/]/)
    .at(-1)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();

  return name || "received.bin";
}

function encodeFilenameForHeader(value) {
  const encoded = new TextEncoder().encode(normalizeFilename(value));
  if (encoded.byteLength > 96) {
    throw new YmodemError(t("ymodem.session.filenameTooLong"), "FILENAME_TOO_LONG");
  }
  return encoded;
}

function parseMetadataHeader(data) {
  const nameEnd = data.indexOf(0);
  if (nameEnd <= 0) return { filename: "", size: null, final: true };

  const filename = normalizeFilename(textDecoder.decode(data.subarray(0, nameEnd)));
  let sizeEnd = data.indexOf(0, nameEnd + 1);
  if (sizeEnd === -1) {
    sizeEnd = Math.min(data.byteLength, nameEnd + 33);
  }

  const metadata = textDecoder.decode(data.subarray(nameEnd + 1, sizeEnd)).trim();
  const sizeToken = metadata.split(/\s+/)[0];
  const size = /^\d+$/.test(sizeToken) ? Number.parseInt(sizeToken, 10) : null;

  return { filename, size, final: false };
}

function phaseFromSignal(signal) {
  if (signal === YMODEM.ACK) return "ack";
  if (signal === YMODEM.NAK) return "nak";
  if (signal === YMODEM.CRC) return "crc";
  if (signal === YMODEM.CAN) return "cancel";
  return "timeout";
}

export class YmodemError extends Error {
  constructor(message, code = "YMODEM_ERROR") {
    super(message);
    this.name = "YmodemError";
    this.code = code;
  }
}

export class YmodemCancelledError extends YmodemError {
  constructor(message = t("ymodem.session.cancelled")) {
    super(message, "CANCELLED");
    this.name = "YmodemCancelledError";
  }
}

export class YmodemTimeoutError extends YmodemError {
  constructor(message = t("ymodem.session.timeout")) {
    super(message, "TIMEOUT");
    this.name = "YmodemTimeoutError";
  }
}

export class YmodemSession {
  constructor({
    write,
    onProgress = () => {},
    onLog = () => {},
    responseTimeout = 3000,
    packetTimeout = 5000,
    startTimeout = 30000,
    maxRetries = 10,
  } = {}) {
    if (typeof write !== "function") {
      throw new TypeError(t("ymodem.session.writeRequired"));
    }

    this.transportWrite = write;
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.responseTimeout = responseTimeout;
    this.packetTimeout = packetTimeout;
    this.startTimeout = startTimeout;
    this.maxRetries = maxRetries;

    this._active = false;
    this._cancelled = false;
    this._cancelError = null;
    this._mode = "crc";
    this._chunks = [];
    this._readOffset = 0;
    this._waiter = null;
    this._writeQueue = Promise.resolve();
  }

  get active() {
    return this._active;
  }

  push(bytes) {
    if (!this._active || !bytes?.byteLength) return;

    const chunk = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    this._chunks.push(chunk);
    this._pump();
  }

  async cancel({ sendCan = true, reason = t("ymodem.session.cancelled") } = {}) {
    if (!this._active) return;

    this._cancelled = true;
    this._cancelError = new YmodemCancelledError(reason);

    if (sendCan) {
      await this._writeBytes(new Uint8Array([YMODEM.CAN, YMODEM.CAN])).catch(() => {});
    }

    this._rejectWaiter(this._cancelError);
    this._finish();
  }

  async send(data, { filename = "firmware.bin", blockSize = YMODEM.DEFAULT_BLOCK_SIZE } = {}) {
    this._begin();
    const source = data instanceof Uint8Array ? data : new Uint8Array(data);
    const transferSize = source.byteLength;
    const dataBlockSize = blockSize === 128 ? 128 : 1024;
    const safeFilename = normalizeFilename(filename);

    try {
      this._emitLog("info", t("ymodem.session.waitingForRequest", { name: safeFilename }));
      this._emitProgress({
        direction: "send",
        phase: "waiting",
        transferred: 0,
        total: transferSize,
        percent: 0,
      });

      const startSignal = await this._waitForSignal([YMODEM.CRC, YMODEM.NAK], this.startTimeout);
      if (startSignal === null) {
        throw new YmodemTimeoutError(t("ymodem.session.noStartSignal"));
      }

      this._mode = startSignal === YMODEM.NAK ? "checksum" : "crc";
      this._emitLog(
        "info",
        this._mode === "crc"
          ? t("ymodem.session.crcReceiver")
          : t("ymodem.session.checksumReceiver"),
      );

      const filenameBytes = encodeFilenameForHeader(safeFilename);
      const metadata = new Uint8Array(filenameBytes.byteLength + 1 + String(transferSize).length + 1);
      metadata.set(filenameBytes, 0);
      metadata[filenameBytes.byteLength] = 0;
      metadata.set(
        new TextEncoder().encode(String(transferSize)),
        filenameBytes.byteLength + 1,
      );
      metadata[metadata.byteLength - 1] = 0;

      await this._sendBlockWithAck(0, padBlock(metadata, YMODEM.HEADER_SIZE, 0), YMODEM.HEADER_SIZE);
      this._emitLog(
        "info",
        t("ymodem.session.headerSent", { name: safeFilename, size: transferSize }),
      );

      let readyForData = false;
      for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
        const signal = await this._waitForSignal([YMODEM.CRC, YMODEM.NAK], this.responseTimeout);
        if (signal === YMODEM.CRC) {
          readyForData = true;
          break;
        }
        if (signal === YMODEM.NAK) {
          this._emitLog("warn", t("ymodem.session.headerRequestedAgain"));
          await this._sendBlockWithAck(
            0,
            padBlock(metadata, YMODEM.HEADER_SIZE, 0),
            YMODEM.HEADER_SIZE,
          );
          continue;
        }
        throw new YmodemTimeoutError(t("ymodem.session.noStartAfterHeader"));
      }

      if (!readyForData) {
        throw new YmodemError(t("ymodem.session.headerRejected"), "HEADER_REJECTED");
      }

      let sequence = 1;
      let offset = 0;
      let blockCount = 0;

      while (offset < transferSize) {
        const end = Math.min(offset + dataBlockSize, transferSize);
        const block = padBlock(source.subarray(offset, end), dataBlockSize);
        await this._sendBlockWithAck(sequence & 0xff, block, dataBlockSize);

        offset = end;
        blockCount += 1;
        sequence = (sequence + 1) & 0xff;
        this._emitProgress({
          direction: "send",
          phase: "sending",
          transferred: offset,
          total: transferSize,
          percent: transferSize ? (offset / transferSize) * 100 : 100,
          block: blockCount,
        });
      }

      await this._sendEotWithAck();
      this._emitLog("info", t("ymodem.session.eotConfirmed"));

      const finalSignal = await this._waitForSignal([YMODEM.CRC], this.responseTimeout);
      if (finalSignal === YMODEM.CRC) {
        await this._sendBlockWithAck(0, new Uint8Array(YMODEM.HEADER_SIZE), YMODEM.HEADER_SIZE);
        this._emitLog("info", t("ymodem.session.endHeaderConfirmed"));
      } else {
        this._emitLog("warn", t("ymodem.session.noEndHeaderSend"));
      }

      this._emitProgress({
        direction: "send",
        phase: "complete",
        transferred: transferSize,
        total: transferSize,
        percent: 100,
        blocks: blockCount,
      });

      return {
        filename: safeFilename,
        size: transferSize,
        blocks: blockCount,
        blockSize: dataBlockSize,
      };
    } finally {
      this._finish();
    }
  }

  async receive() {
    this._begin();
    const chunks = [];
    let received = 0;

    try {
      let header = null;
      for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
        this._emitLog(
          "info",
          t("ymodem.session.requestingHeader", { attempt, total: this.maxRetries }),
        );
        this._emitProgress({
          direction: "receive",
          phase: "waiting",
          transferred: 0,
          total: null,
          percent: 0,
        });
        await this._writeBytes(new Uint8Array([YMODEM.CRC]));

        const packet = await this._receivePacket(this.responseTimeout);
        if (!packet || packet.type === "eot") continue;
        if (!packet.valid) {
          await this._writeBytes(new Uint8Array([YMODEM.NAK]));
          continue;
        }
        if (packet.sequence !== 0) {
          await this._writeBytes(new Uint8Array([YMODEM.NAK]));
          continue;
        }

        const parsed = parseMetadataHeader(packet.data);
        if (parsed.final) {
          await this._writeBytes(new Uint8Array([YMODEM.ACK]));
          continue;
        }

        await this._writeBytes(new Uint8Array([YMODEM.ACK]));
        header = parsed;
        break;
      }

      if (!header) {
        throw new YmodemTimeoutError(t("ymodem.session.invalidHeader"));
      }

      const total = Number.isFinite(header.size) ? header.size : null;
      this._emitLog(
        "info",
        total === null
          ? t("ymodem.session.headerReceivedUnknownSize", { name: header.filename })
          : t("ymodem.session.headerReceived", { name: header.filename, size: total }),
      );
      await this._writeBytes(new Uint8Array([YMODEM.CRC]));

      let expectedSequence = 1;
      let lastAcceptedSequence = 0;
      let blockCount = 0;
      let missingPackets = 0;

      while (true) {
        const packet = await this._receivePacket(this.packetTimeout);
        if (!packet) {
          missingPackets += 1;
          if (missingPackets > this.maxRetries) {
            throw new YmodemTimeoutError(t("ymodem.session.receiveTimeout"));
          }
          await this._writeBytes(new Uint8Array([YMODEM.NAK]));
          continue;
        }

        if (packet.type === "eot") {
          await this._writeBytes(new Uint8Array([YMODEM.ACK]));
          break;
        }

        if (!packet.valid) {
          missingPackets += 1;
          this._emitLog(
            "warn",
            t("ymodem.session.blockChecksumFailed", { sequence: packet.sequence }),
          );
          await this._writeBytes(new Uint8Array([YMODEM.NAK]));
          continue;
        }

        if (packet.sequence === lastAcceptedSequence) {
          await this._writeBytes(new Uint8Array([YMODEM.ACK]));
          continue;
        }

        if (packet.sequence !== expectedSequence) {
          missingPackets += 1;
          this._emitLog(
            "warn",
            t("ymodem.session.sequenceMismatch", {
              sequence: packet.sequence,
              expected: expectedSequence,
            }),
          );
          await this._writeBytes(new Uint8Array([YMODEM.NAK]));
          continue;
        }

        const remaining = total === null ? packet.data.byteLength : Math.max(0, total - received);
        const data = remaining < packet.data.byteLength ? packet.data.slice(0, remaining) : packet.data;
        chunks.push(data);
        received += data.byteLength;
        blockCount += 1;
        lastAcceptedSequence = packet.sequence;
        expectedSequence = (expectedSequence + 1) & 0xff;
        missingPackets = 0;
        await this._writeBytes(new Uint8Array([YMODEM.ACK]));

        this._emitProgress({
          direction: "receive",
          phase: "receiving",
          transferred: received,
          total,
          percent: total ? Math.min(100, (received / total) * 100) : 0,
          block: blockCount,
        });
      }

      this._emitLog("info", t("ymodem.session.eotReceived"));
      await this._writeBytes(new Uint8Array([YMODEM.CRC]));
      const finalPacket = await this._receivePacket(this.responseTimeout);

      if (
        finalPacket &&
        finalPacket.type !== "eot" &&
        finalPacket.valid &&
        finalPacket.sequence === 0 &&
        parseMetadataHeader(finalPacket.data).final
      ) {
        await this._writeBytes(new Uint8Array([YMODEM.ACK]));
        this._emitLog("info", t("ymodem.session.endHeaderConfirmed"));
      } else if (finalPacket) {
        await this._writeBytes(new Uint8Array([YMODEM.NAK]));
        this._emitLog("warn", t("ymodem.session.invalidEndHeader"));
      } else {
        this._emitLog("warn", t("ymodem.session.noEndHeaderReceive"));
      }

      const combined = concatBytes(chunks, received);
      const output = trimFilePadding(combined, total);
      this._emitProgress({
        direction: "receive",
        phase: "complete",
        transferred: output.byteLength,
        total: output.byteLength,
        percent: 100,
        blocks: blockCount,
      });

      return {
        filename: normalizeFilename(header.filename),
        data: output,
        size: output.byteLength,
        blocks: blockCount,
      };
    } finally {
      this._finish();
    }
  }

  _begin() {
    if (this._active) {
      throw new YmodemError(t("ymodem.error.busy"), "BUSY");
    }

    this._active = true;
    this._cancelled = false;
    this._cancelError = null;
    this._mode = "crc";
    this._chunks = [];
    this._readOffset = 0;
    this._waiter = null;
    this._writeQueue = Promise.resolve();
  }

  _finish() {
    this._active = false;
    this._chunks = [];
    this._readOffset = 0;
    this._waiter = null;
  }

  _assertActive() {
    if (!this._active) {
      throw this._cancelError || new YmodemCancelledError();
    }
  }

  _emitProgress(event) {
    try {
      this.onProgress(event);
    } catch {
      // UI callbacks must not break the protocol state machine.
    }
  }

  _emitLog(level, message) {
    try {
      this.onLog(level, message);
    } catch {
      // UI callbacks must not break the protocol state machine.
    }
  }

  async _writeBytes(bytes) {
    const task = this._writeQueue.then(() => this.transportWrite(bytes));
    this._writeQueue = task.catch(() => {});
    const result = await task;

    if (result === false) {
      throw new YmodemError(t("ymodem.session.writeFailed"), "WRITE_FAILED");
    }
  }

  _takeByte() {
    while (this._chunks.length) {
      const chunk = this._chunks[0];
      if (this._readOffset >= chunk.byteLength) {
        this._chunks.shift();
        this._readOffset = 0;
        continue;
      }

      const byte = chunk[this._readOffset];
      this._readOffset += 1;
      return byte;
    }

    return undefined;
  }

  _pump() {
    if (!this._waiter) return;

    const byte = this._takeByte();
    if (byte === undefined) return;

    const waiter = this._waiter;
    this._waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(byte);
  }

  _rejectWaiter(error) {
    if (!this._waiter) return;

    const waiter = this._waiter;
    this._waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  _waitForByte(timeout) {
    this._assertActive();
    const byte = this._takeByte();
    if (byte !== undefined) return Promise.resolve(byte);

    if (this._waiter) {
      return Promise.reject(new YmodemError(t("ymodem.session.readerBusy"), "READER_BUSY"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._waiter?.timer !== timer) return;
        this._waiter = null;
        reject(new YmodemTimeoutError());
      }, Math.max(1, timeout));

      this._waiter = { resolve, reject, timer };
    });
  }

  async _readExactly(size, timeout) {
    const deadline = Date.now() + timeout;
    const output = new Uint8Array(size);

    for (let index = 0; index < size; index += 1) {
      output[index] = await this._waitForByte(Math.max(1, deadline - Date.now()));
    }

    return output;
  }

  async _waitForSignal(signals, timeout) {
    const allowed = new Set(signals);
    const deadline = Date.now() + timeout;

    while (this._active) {
      let byte;
      try {
        byte = await this._waitForByte(Math.max(1, deadline - Date.now()));
      } catch (error) {
        if (error instanceof YmodemTimeoutError) return null;
        throw error;
      }

      if (byte === YMODEM.CAN) {
        let second = null;
        try {
          second = await this._waitForByte(ONE_SHOT_CAN_GRACE_MS);
        } catch {
          // A single CAN is accepted as a cancellation request as well.
        }
        if (second === YMODEM.CAN || second === null) {
          throw new YmodemCancelledError(t("ymodem.session.remoteCancelled"));
        }
        continue;
      }

      if (allowed.has(byte)) return byte;
    }

    this._assertActive();
    return null;
  }

  _buildPacket(sequence, block, blockSize) {
    const checksumLength = this._mode === "crc" ? 2 : 1;
    const marker = blockSize === 1024 ? YMODEM.STX : YMODEM.SOH;
    const packet = new Uint8Array(3 + blockSize + checksumLength);
    packet[0] = marker;
    packet[1] = sequence & 0xff;
    packet[2] = 0xff - (sequence & 0xff);
    packet.set(block, 3);

    if (this._mode === "crc") {
      const value = crc16Xmodem(block);
      packet[3 + blockSize] = (value >> 8) & 0xff;
      packet[3 + blockSize + 1] = value & 0xff;
    } else {
      packet[3 + blockSize] = checksum(block);
    }

    return packet;
  }

  async _sendBlockWithAck(sequence, block, blockSize) {
    let lastSignal = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      this._assertActive();
      await this._writeBytes(this._buildPacket(sequence, block, blockSize));
      const signal = await this._waitForSignal(
        [YMODEM.ACK, YMODEM.NAK, YMODEM.CRC],
        this.responseTimeout,
      );
      lastSignal = signal;

      if (signal === YMODEM.ACK) return;
      if (signal === null) {
        this._emitLog("warn", t("ymodem.session.ackTimeout", { sequence }));
        continue;
      }

      this._emitLog(
        "warn",
        t("ymodem.session.unexpectedSignal", {
          sequence,
          signal: phaseFromSignal(signal).toUpperCase(),
        }),
      );
    }

    throw new YmodemTimeoutError(
      lastSignal
        ? t("ymodem.session.retriesExhaustedSignal", {
            sequence,
            count: this.maxRetries,
            signal: phaseFromSignal(lastSignal),
          })
        : t("ymodem.session.retriesExhausted", { sequence, count: this.maxRetries }),
    );
  }

  async _sendEotWithAck() {
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      await this._writeBytes(new Uint8Array([YMODEM.EOT]));
      const signal = await this._waitForSignal([YMODEM.ACK, YMODEM.NAK], this.responseTimeout);

      if (signal === YMODEM.ACK) return;
      if (signal === null) {
        this._emitLog("warn", t("ymodem.session.eotAckTimeout"));
      } else {
        this._emitLog("warn", t("ymodem.session.eotResendRequested"));
      }
    }

    throw new YmodemTimeoutError(t("ymodem.session.eotRejected"));
  }

  async _receivePacket(timeout) {
    const deadline = Date.now() + timeout;

    try {
      while (this._active) {
        const marker = await this._waitForByte(Math.max(1, deadline - Date.now()));
        if (marker === YMODEM.EOT) return { type: "eot" };
        if (marker === YMODEM.CAN) {
          throw new YmodemCancelledError(t("ymodem.session.remoteCancelled"));
        }
        if (marker !== YMODEM.SOH && marker !== YMODEM.STX) continue;

        const sequence = await this._waitForByte(Math.max(1, deadline - Date.now()));
        const complement = await this._waitForByte(Math.max(1, deadline - Date.now()));
        const blockSize = marker === YMODEM.STX ? 1024 : 128;
        const data = await this._readExactly(blockSize, Math.max(1, deadline - Date.now()));
        const checksumLength = this._mode === "crc" ? 2 : 1;

        if (checksumLength === 2) {
          const high = await this._waitForByte(Math.max(1, deadline - Date.now()));
          const low = await this._waitForByte(Math.max(1, deadline - Date.now()));
          const expected = crc16Xmodem(data);
          const actual = (high << 8) | low;
          return {
            type: "data",
            marker,
            sequence,
            complement,
            data,
            valid: ((sequence + complement) & 0xff) === 0xff && expected === actual,
          };
        }

        const actual = await this._waitForByte(Math.max(1, deadline - Date.now()));
        return {
          type: "data",
          marker,
          sequence,
          complement,
          data,
          valid: ((sequence + complement) & 0xff) === 0xff && checksum(data) === actual,
        };
      }

      this._assertActive();
      return null;
    } catch (error) {
      if (error instanceof YmodemTimeoutError) return null;
      throw error;
    }
  }
}
