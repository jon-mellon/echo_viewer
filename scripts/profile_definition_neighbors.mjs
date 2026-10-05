import { performance } from "node:perf_hooks";
import { nearbyMapNeighbors } from "../site/definition_neighbors.mjs";

const count = Number(process.argv[2] || 10000);
const selections = Number(process.argv[3] || 50);
const iterations = Number(process.argv[4] || 100);
const variables = new Map();
for (let index = 0; index < count; index++) {
  variables.set(`v${index}`, { map_x: (index * 137) % 1000, map_y: (index * 271) % 1000 });
}
const eligible = [...variables.keys()];
const selected = eligible.slice(0, selections);
for (let index = 0; index < 10; index++) nearbyMapNeighbors(eligible, selected, variables);
const samples = [];
for (let index = 0; index < iterations; index++) {
  const start = performance.now();
  nearbyMapNeighbors(eligible, selected, variables);
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ eligible: count, selected: selections, iterations,
  median_ms: Number(samples[Math.floor(iterations / 2)].toFixed(2)),
  p95_ms: Number(samples[Math.floor(iterations * 0.95)].toFixed(2)) }));
