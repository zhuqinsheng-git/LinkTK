// Module: Browser file-download helper.
// Owns: the Blob → object URL → anchor click → revoke sequence.
// Depends on: nothing.
// Called by: features and agent modules that export files.

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export { downloadBlob };
