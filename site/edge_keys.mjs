export const pairKey = (a, b) => [a, b].sort().join("__");

export function pathPairKeys(path = []) {
  const keys = new Set();
  for (let index = 0; index < path.length - 1; index += 1) {
    keys.add(pairKey(path[index], path[index + 1]));
  }
  return keys;
}
