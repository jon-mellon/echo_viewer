export const DAG_EXPORT_WIDTH = 1600;
export const DAG_EXPORT_HEIGHT = 900;

export function fitDagImage(sourceWidth, sourceHeight, targetWidth = DAG_EXPORT_WIDTH, targetHeight = DAG_EXPORT_HEIGHT, padding = 48) {
  const availableWidth = Math.max(1, targetWidth - 2 * padding);
  const availableHeight = Math.max(1, targetHeight - 2 * padding);
  const scale = Math.min(availableWidth / Math.max(1, sourceWidth), availableHeight / Math.max(1, sourceHeight));
  const width = sourceWidth * scale, height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error("Could not render the causal map image.")),
    "image/png",
  ));
}

export async function renderDagPng(network, container, documentApi = document) {
  const source = container?.querySelector("canvas");
  if (!network || !source) return null;
  const prior = { scale: network.getScale(), position: network.getViewPosition() };
  try {
    network.fit({ animation: false });
    network.redraw();
    const boxes = Object.keys(network.getPositions()).map(id => network.getBoundingBox(id));
    if (!boxes.length) return null;
    const world = {
      left: Math.min(...boxes.map(box => box.left)), top: Math.min(...boxes.map(box => box.top)),
      right: Math.max(...boxes.map(box => box.right)), bottom: Math.max(...boxes.map(box => box.bottom)),
    };
    const topLeft = network.canvasToDOM({ x: world.left, y: world.top });
    const bottomRight = network.canvasToDOM({ x: world.right, y: world.bottom });
    const cssWidth = source.clientWidth || container.clientWidth || source.width;
    const cssHeight = source.clientHeight || container.clientHeight || source.height;
    const pixelX = source.width / Math.max(1, cssWidth), pixelY = source.height / Math.max(1, cssHeight);
    const margin = 24;
    const sx = Math.max(0, (topLeft.x - margin) * pixelX);
    const sy = Math.max(0, (topLeft.y - margin) * pixelY);
    const sw = Math.min(source.width - sx, (bottomRight.x - topLeft.x + 2 * margin) * pixelX);
    const sh = Math.min(source.height - sy, (bottomRight.y - topLeft.y + 2 * margin) * pixelY);
    const output = documentApi.createElement("canvas");
    output.width = DAG_EXPORT_WIDTH; output.height = DAG_EXPORT_HEIGHT;
    const context = output.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, output.width, output.height);
    const destination = fitDagImage(sw, sh);
    context.drawImage(source, sx, sy, sw, sh, destination.x, destination.y, destination.width, destination.height);
    return new Uint8Array(await (await canvasBlob(output)).arrayBuffer());
  } finally {
    network.moveTo({ scale: prior.scale, position: prior.position, animation: false });
  }
}
