// Module: Shared byte and numeric formatting.
// Owns: Byte/rate/time text and HEX/ASCII fragment formatting.
// Depends on: nothing.
// Called by: display layers in serial, network, log-view, ssh, and ymodem.

function formatBytes(value, digits = 1) {
  const normalized = Math.max(0, Number(value) || 0);
  if (normalized < 1024) return `${Math.round(normalized)} B`;
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(digits)} KB`;
  return `${(normalized / (1024 * 1024)).toFixed(digits)} MB`;
}

function formatRate(value) {
  return `${formatBytes(value)}/s`;
}

function formatClockTime(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function bytesToAscii(bytes) {
  return [...bytes]
    .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."))
    .join("");
}

function appendHexText(previous, next) {
  if (!previous) return next || "";
  if (!next) return previous;
  return `${previous} ${next}`;
}

function formatUsbId(value) {
  return Number(value).toString(16).toUpperCase().padStart(4, "0");
}
export { appendHexText, bytesToAscii, bytesToHex, formatBytes, formatClockTime, formatRate, formatUsbId };
