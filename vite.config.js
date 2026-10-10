import { defineConfig } from "vite";
import { agentBridgePlugin } from "./server/agent-bridge.js";
import { networkBridgePlugin } from "./server/network-bridge.js";
import { sshBridgePlugin } from "./server/ssh-bridge.js";
import { systemSerialPortsPlugin } from "./server/system-serial-ports.js";

export default defineConfig({
  plugins: [
    agentBridgePlugin(),
    networkBridgePlugin(),
    sshBridgePlugin(),
    systemSerialPortsPlugin(),
  ],
});
