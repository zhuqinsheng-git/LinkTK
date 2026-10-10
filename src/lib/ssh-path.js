// Module: SSH remote path pure functions.
// Owns: POSIX path normalization and joining, remote file names, and list formatting.
// Depends on: core/i18n.js.
// Called by: the ssh feature, SSH presets, and agent file operations.

import { formatDateTime, formatNumber, t } from "../core/i18n.js";

function sshAgentFileName(path) {
  const normalized = normalizeSshPath(path);
  return normalized === "/"
    ? "root.bin"
    : normalized.split("/").filter(Boolean).at(-1) || "remote.bin";
}

function normalizeSshPath(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return ".";
  const absolute = raw.startsWith("/");
  const parts = [];
  raw.split("/").forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      return;
    }
    parts.push(part);
  });
  if (absolute) return parts.length ? `/${parts.join("/")}` : "/";
  return parts.length ? parts.join("/") : ".";
}

function parentSshPath(value) {
  const path = normalizeSshPath(value);
  if (path === "/") return path;
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  if (absolute) return `/${parts.join("/")}` || "/";
  return parts.join("/") || ".";
}

function joinSshPath(base, name) {
  const normalized = normalizeSshPath(base);
  const cleanName = normalizeSshPath(name).split("/").filter(Boolean).at(-1);
  if (!cleanName || cleanName === "." || cleanName === "..") {
    throw new Error(t("ssh.path.nameRequired"));
  }
  if (normalized === ".") return cleanName;
  if (normalized === "/") return `/${cleanName}`;
  return `${normalized}/${cleanName}`;
}

function formatSshFileTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--";
  return formatDateTime(timestamp * 1000, {
    hour12: false,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSshFileSize(bytes, isDirectory) {
  if (isDirectory) return "--";
  const size = Math.max(0, Number(bytes) || 0);
  if (size < 1024) return "<1";
  return formatNumber(size / 1024, { maximumFractionDigits: 1 });
}

export { formatSshFileSize, formatSshFileTime, joinSshPath, normalizeSshPath, parentSshPath, sshAgentFileName };
