export function isReadOnlyAgentTransfer(command, params = {}) {
  if (command !== "sftp_download_to_file") return false;
  return params?.overwrite !== true;
}
