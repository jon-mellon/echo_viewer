export function pairKey(a, b) {
  const pair = [String(a), String(b)].sort();
  return JSON.stringify(pair);
}

export function pathPairKeys(path = []) {
  const keys = new Set();
  for (let index = 0; index < path.length - 1; index += 1) {
    keys.add(pairKey(path[index], path[index + 1]));
  }
  return keys;
}
