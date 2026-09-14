export function createGroupingSetPresenter({ elements, alertImpl = message => window.alert(message) }) {
  function beginExport() {
    const button = elements.exportGroupingFolder;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Building ZIP…";
    return originalLabel;
  }

  function endExport(originalLabel) {
    elements.exportGroupingFolder.textContent = originalLabel;
    elements.exportGroupingFolder.disabled = false;
  }

  function showExportError(error) {
    alertImpl(error?.message || "Could not export the grouping schema folder.");
  }

  return { beginExport, endExport, showExportError };
}
