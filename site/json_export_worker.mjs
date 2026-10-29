// Serialize large projects away from input handling and canvas rendering.
self.onmessage = ({ data }) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  self.postMessage(blob);
};
