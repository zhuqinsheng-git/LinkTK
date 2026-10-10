// Module: Browser binary and Base64 conversion.
// Owns: Pure functions for Base64 encoding and decoding.
// Depends on: nothing.
// Called by: app.js and the agent SSH/YMODEM commands.

function bytesToBase64(bytes) {
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return window.btoa(binary);
}

function base64ToBytes(value) {
  const binary = window.atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export { base64ToBytes, bytesToBase64 };
