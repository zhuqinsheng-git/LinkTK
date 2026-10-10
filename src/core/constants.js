// Module: Application-level read-only constants.
// Owns: Capacity limits, protocol sets, storage keys, template metadata, and palettes.
// Depends on: nothing.
// Called by: core, features, and agent modules.

const MAX_LOG_ENTRIES = 5000;

const MAX_PENDING_BYTES = 4 * 1024 * 1024;

const MAX_AGENT_EVENTS = 5000;

const MAX_AGENT_EVENT_BYTES = 4 * 1024 * 1024;

const MAX_AGENT_OPERATIONS = 100;

const MAX_AGENT_ACTIVITY = 80;

const MAX_AGENT_TRANSACTIONS = 100;

const DEFAULT_AGENT_APPROVAL_WINDOW_MS = 120000;

const AGENT_APPROVAL_FALLBACK_GRACE_MS = 2000;

const AGENT_UPLOAD_APPROVAL_TTL_MS = 5 * 60 * 1000;

const AGENT_UPLOAD_SCOPED_COMMANDS = new Set([
  "sftp_upload_chunk",
  "sftp_upload_end",
]);

const MAX_DEVICE_PROFILES = 50;

const MAX_TASK_TEMPLATES = 100;

const MAX_TRANSACTION_BACKUP_BYTES = 16 * 1024 * 1024;

const AGENT_READ_COMMANDS = new Set([
  "status",
  "snapshot",
  "read",
  "wait",
  "network_status",
  "network_presets",
  "network_read",
  "network_wait",
  "serial_status",
  "serial_ports",
  "serial_presets",
  "ssh_status",
  "ssh_presets",
  "ssh_read",
  "ssh_wait",
  "sftp_list",
  "sftp_download_to_file",
  "sftp_download",
  "sftp_download_open",
  "sftp_download_chunk",
  "sftp_download_close",
  "ymodem_status",
  "macro_list",
  "bridge_status",
  "operation_status",
  "operation_list",
  "device_profile_list",
  "transaction_list",
  "task_template_list",
  "evidence_get",
]);

const AGENT_DANGEROUS_COMMANDS = new Set([
  "network_disconnect",
  "serial_disconnect",
  "ymodem_cancel",
  "macro_delete",
  "bridge_stop",
  "sftp_delete",
  "sftp_rename",
  "sftp_upload",
  "sftp_upload_from_file",
  "sftp_upload_begin",
  "sftp_upload_chunk",
  "sftp_upload_end",
  "ssh_disconnect",
  "device_profile_delete",
  "transaction_execute",
  "task_delete",
  "task_run",
]);

// Command ids in a frozen order. Display labels live in the locales under
// "agent.cmd.<id>" — this table intentionally carries no user-visible text.
const AGENT_COMMAND_IDS = Object.freeze([
  "status",
  "snapshot",
  "send",
  "read",
  "wait",
  "exec",
  "network_status",
  "network_presets",
  "network_connect",
  "network_disconnect",
  "network_send",
  "network_read",
  "network_wait",
  "network_exec",
  "serial_status",
  "serial_ports",
  "serial_presets",
  "serial_connect",
  "serial_disconnect",
  "ymodem_status",
  "ymodem_send",
  "ymodem_receive",
  "ymodem_cancel",
  "macro_list",
  "macro_run",
  "macro_create",
  "macro_delete",
  "bridge_status",
  "bridge_start",
  "bridge_stop",
  "ssh_status",
  "ssh_presets",
  "ssh_connect",
  "ssh_connect_preset",
  "ssh_disconnect",
  "ssh_send",
  "ssh_read",
  "ssh_wait",
  "ssh_exec",
  "sftp_list",
  "sftp_mkdir",
  "sftp_rename",
  "sftp_delete",
  "sftp_upload",
  "sftp_upload_from_file",
  "sftp_download_to_file",
  "sftp_upload_begin",
  "sftp_upload_chunk",
  "sftp_upload_end",
  "sftp_download_open",
  "sftp_download_chunk",
  "sftp_download_close",
  "sftp_download",
  "operation_start",
  "operation_status",
  "operation_cancel",
  "operation_list",
  "transaction_execute",
  "transaction_list",
  "device_profile_list",
  "device_profile_select",
  "device_profile_upsert",
  "device_profile_delete",
  "task_template_list",
  "task_run",
  "task_create",
  "task_create_from_operation",
  "task_delete",
  "evidence_get",
]);

const MAX_SSH_AGENT_TRANSFER_BYTES = 16 * 1024 * 1024;

const MAX_SSH_LOCAL_TRANSFER_BYTES = 2 * 1024 ** 3;

const MAX_SSH_AGENT_RESPONSE_BYTES = 1024 * 1024;

const SSH_AGENT_CHUNK_BYTES = 256 * 1024;

const MAX_SSH_QUICK_PATHS = 20;

const MAX_QUICK_COMMANDS = 20;

const MAX_CONNECTION_PRESETS = 20;

const MAX_TEMPLATE_VARIABLES = 20;

const MAX_SEND_HISTORY = 50;

const MAX_MACROS = 50;

const MAX_MACRO_STEPS = 500;

const ACTIVITY_SAMPLE_COUNT = 28;

const LOG_MERGE_IDLE_MS = 90;

const AUTO_SAVE_FLUSH_MS = 450;

const DEFAULT_AUTO_SAVE_SIZE_KB = 1024;

const DEFAULT_AUTO_SAVE_MINUTES = 5;

const NETWORK_PEER_COLORS = [
  "#57a7a4",
  "#d18a3f",
  "#7b9ed8",
  "#b778c7",
  "#d46f6a",
  "#78b46a",
  "#c7a348",
  "#5fa7cf",
  "#c6789c",
  "#7d8ed6",
];

const SETTINGS_KEY = "linktk.settings.v1";

const AGENT_SESSION_ID_KEY = "linktk.agent.session-id";

const AGENT_SESSION_LABEL_KEY = "linktk.agent.session-label";

const LEGACY_SETTINGS_KEYS = ["serial-web-assistant.settings.v1"];

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

const TEMPLATE_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const BUILTIN_TEMPLATE_VARIABLES = [
  { name: "time", example: "14:05:32.125" },
  { name: "date", example: "2026-09-30" },
  { name: "datetime", example: "2026-09-30 14:05:32.125" },
  { name: "unix", example: "1788175532" },
  { name: "unix_ms", example: "1788175532125" },
  { name: "counter", example: "1, 2, 3..." },
  { name: "random", example: "0 - 65535" },
  { name: "random_hex", example: "A7" },
  { name: "uuid", example: "xxxxxxxx-xxxx-..." },
];

const BUILTIN_TEMPLATE_VARIABLE_NAMES = new Set(
  BUILTIN_TEMPLATE_VARIABLES.map((variable) => variable.name),
);

const textEncoder = new TextEncoder();

const APP_STARTED_AT = Date.now();
export { ACTIVITY_SAMPLE_COUNT, AGENT_APPROVAL_FALLBACK_GRACE_MS, AGENT_COMMAND_IDS, AGENT_DANGEROUS_COMMANDS, AGENT_READ_COMMANDS, AGENT_SESSION_ID_KEY, AGENT_SESSION_LABEL_KEY, AGENT_UPLOAD_APPROVAL_TTL_MS, AGENT_UPLOAD_SCOPED_COMMANDS, APP_STARTED_AT, AUTO_SAVE_FLUSH_MS, BUILTIN_TEMPLATE_VARIABLES, BUILTIN_TEMPLATE_VARIABLE_NAMES, DEFAULT_AGENT_APPROVAL_WINDOW_MS, DEFAULT_AUTO_SAVE_MINUTES, DEFAULT_AUTO_SAVE_SIZE_KB, LEGACY_SETTINGS_KEYS, LOG_MERGE_IDLE_MS, MAX_AGENT_ACTIVITY, MAX_AGENT_EVENTS, MAX_AGENT_EVENT_BYTES, MAX_AGENT_OPERATIONS, MAX_AGENT_TRANSACTIONS, MAX_CONNECTION_PRESETS, MAX_DEVICE_PROFILES, MAX_LOG_ENTRIES, MAX_MACROS, MAX_MACRO_STEPS, MAX_PENDING_BYTES, MAX_QUICK_COMMANDS, MAX_SEND_HISTORY, MAX_SSH_AGENT_RESPONSE_BYTES, MAX_SSH_AGENT_TRANSFER_BYTES, MAX_SSH_LOCAL_TRANSFER_BYTES, MAX_SSH_QUICK_PATHS, MAX_TASK_TEMPLATES, MAX_TEMPLATE_VARIABLES, MAX_TRANSACTION_BACKUP_BYTES, NETWORK_PEER_COLORS, SETTINGS_KEY, SSH_AGENT_CHUNK_BYTES, TEMPLATE_VARIABLE_NAME_PATTERN, TEMPLATE_VARIABLE_PATTERN, textEncoder };
