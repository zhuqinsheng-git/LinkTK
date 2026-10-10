import assert from "node:assert/strict";
import { crc16Xmodem, YmodemSession } from "../src/ymodem.js";

function createPair(options = {}) {
  let receiver;
  let sender;

  sender = new YmodemSession({
    ...options,
    write: async (bytes) => {
      receiver.push(bytes);
      return true;
    },
  });

  receiver = new YmodemSession({
    ...options,
    write: async (bytes) => {
      sender.push(bytes);
      return true;
    },
  });

  return { sender, receiver };
}

function createPayload(length) {
  const payload = new Uint8Array(length);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 37 + 11) & 0xff;
  }
  return payload;
}

async function roundTrip({ length, blockSize }) {
  const { sender, receiver } = createPair();
  const payload = createPayload(length);
  const sendPromise = sender.send(payload, {
    filename: "firmware.bin",
    blockSize,
  });
  const receivePromise = receiver.receive();
  const [sent, received] = await Promise.all([sendPromise, receivePromise]);

  assert.equal(sent.size, payload.byteLength);
  assert.equal(received.filename, "firmware.bin");
  assert.equal(received.size, payload.byteLength);
  assert.deepEqual(received.data, payload);
}

assert.equal(crc16Xmodem(new TextEncoder().encode("123456789")), 0x31c3);

await roundTrip({ length: 8193, blockSize: 1024 });
await roundTrip({ length: 2049, blockSize: 128 });
await roundTrip({ length: 0, blockSize: 1024 });

console.log("YMODEM test passed: CRC16, 1K blocks, 128-byte blocks, and zero-byte file transfer.");
