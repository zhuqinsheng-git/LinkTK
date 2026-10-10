import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API_PATH = "/api/system-serial-ports";
const CACHE_TTL = 15000;
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = "Stop"
$items = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | ForEach-Object {
  $vendorId = $null
  $productId = $null
  if ($_.PNPDeviceID -match 'VID_([0-9A-Fa-f]{4})') {
    $vendorId = [Convert]::ToInt32($matches[1], 16)
  }
  if ($_.PNPDeviceID -match 'PID_([0-9A-Fa-f]{4})') {
    $productId = [Convert]::ToInt32($matches[1], 16)
  }
  [PSCustomObject]@{
    name = $_.Name
    vendorId = $vendorId
    productId = $productId
  }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 3
`;

let cache = {
  expiresAt: 0,
  ports: [],
};

function normalizePorts(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return source
    .map((item) => {
      const name = String(item?.name || "").replace(/\s+/g, " ").trim();
      const port = name.match(/\((COM\d+)\)/i)?.[1]?.toUpperCase() || null;
      if (!name || !port) return null;

      return {
        name,
        port,
        vendorId: Number.isInteger(item?.vendorId) ? item.vendorId : null,
        productId: Number.isInteger(item?.productId) ? item.productId : null,
      };
    })
    .filter(Boolean);
}

async function readSystemSerialPorts() {
  if (process.platform !== "win32") return [];

  const encodedCommand = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );

  if (!stdout.trim()) return [];
  return normalizePorts(JSON.parse(stdout));
}

async function getSystemSerialPorts() {
  if (Date.now() < cache.expiresAt) return cache.ports;

  try {
    const ports = await readSystemSerialPorts();
    cache = { expiresAt: Date.now() + CACHE_TTL, ports };
    return ports;
  } catch {
    cache = { expiresAt: Date.now() + CACHE_TTL, ports: [] };
    return [];
  }
}

function createMiddleware() {
  return async (request, response, next) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || pathname !== API_PATH) {
      next();
      return;
    }

    const ports = await getSystemSerialPorts();
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(ports));
  };
}

export function systemSerialPortsPlugin() {
  const middleware = createMiddleware();
  return {
    name: "serial-workbench-system-ports",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
