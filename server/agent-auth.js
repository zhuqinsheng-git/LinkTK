import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TOKEN_ENV = "LINKTK_AGENT_TOKEN";
const TOKEN_FILE_ENV = "LINKTK_AGENT_TOKEN_FILE";
const MIN_TOKEN_LENGTH = 16;

export function getAgentTokenPath() {
  return (
    String(process.env[TOKEN_FILE_ENV] || "").trim() ||
    join(homedir(), ".linktk", "agent-token")
  );
}

export function validateAgentToken(value) {
  const token = String(value || "").trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`LinkTK AI control token must be at least ${MIN_TOKEN_LENGTH} characters long.`);
  }
  return token;
}

export function readAgentToken() {
  const environmentToken = String(process.env[TOKEN_ENV] || "").trim();
  if (environmentToken) return validateAgentToken(environmentToken);

  const tokenPath = getAgentTokenPath();
  if (!existsSync(tokenPath)) return "";
  const fileToken = readFileSync(tokenPath, "utf8").trim();
  return fileToken ? validateAgentToken(fileToken) : "";
}

export function getOrCreateAgentToken() {
  const existing = readAgentToken();
  if (existing) return existing;

  const token = randomBytes(32).toString("hex");
  const tokenPath = getAgentTokenPath();
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(tokenPath, `${token}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const raced = readAgentToken();
    if (raced) return raced;
    throw new Error(`LinkTK AI control token file is empty: ${tokenPath}`);
  }
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Windows and some filesystems do not support POSIX file modes.
  }
  return token;
}

export function readControllerToken(request) {
  const authorization = String(request.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  return String(
    request.headers["x-linktk-agent-token"] ||
      request.headers["x-linktk-token"] ||
      "",
  ).trim();
}

export function agentTokenMatches(expected, actual) {
  const expectedHash = createHash("sha256").update(String(expected || "")).digest();
  const actualHash = createHash("sha256").update(String(actual || "")).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

export function isSameOriginRequest(request, { allowMissing = false } = {}) {
  const origin = String(request.headers.origin || "").trim();
  if (!origin || origin === "null") return allowMissing;

  const host = String(request.headers.host || "").trim();
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}
