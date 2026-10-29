// Keep browser page zoom from competing with graph pinch handlers (including Safari).
// Do not stop propagation: the graph still needs the same events to zoom itself.
export function preventGraphPageZoom(event) {
  if (event.type.startsWith("gesture") || event.touches?.length > 1) {
    if (event.cancelable) event.preventDefault();
  }
}

export function attachGraphTouchGuard(element) {
  const options = { passive: false, capture: true };
  const events = ["touchstart", "touchmove", "gesturestart", "gesturechange"];
  for (const name of events) element.addEventListener(name, preventGraphPageZoom, options);
  return () => {
    for (const name of events) element.removeEventListener(name, preventGraphPageZoom, options);
  };
}
