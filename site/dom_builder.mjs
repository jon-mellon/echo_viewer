const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

export function safeUrl(value, base = globalThis.location?.href || "http://localhost/") {
  const url = new URL(String(value), base);
  if (!SAFE_URL_PROTOCOLS.has(url.protocol)) throw new Error(`Unsafe URL protocol: ${url.protocol}`);
  return url.href;
}

export function h(tagName, properties = {}, ...children) {
  const node = document.createElement(tagName);
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "textContent") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key === "attrs") for (const [name, attribute] of Object.entries(value)) node.setAttribute(name, String(attribute));
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "href" || key === "src") node[key] = safeUrl(value);
    else node[key] = value;
  }
  node.append(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

export function setSafeUrl(node, property, value) {
  if (property !== "href" && property !== "src") throw new Error(`Unsupported URL property: ${property}`);
  node[property] = safeUrl(value);
  return node;
}

export function replaceChildren(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
  return node;
}
