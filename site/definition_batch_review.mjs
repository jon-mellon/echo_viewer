const STOP_WORDS = new Set([
  "about", "after", "among", "based", "between", "during", "from", "into", "their",
  "through", "toward", "using", "with", "within", "without", "measured", "number",
]);

export function reviewWords(label) {
  return [...new Set(String(label || "").toLowerCase().match(/[a-z]+/g) || [])]
    .filter(word => word.length >= 4 && !STOP_WORDS.has(word));
}

export function reviewTerms(variables, selectedIds, limit = 16) {
  const selected = new Set(selectedIds);
  const terms = new Map();
  for (const variable of variables) {
    for (const word of reviewWords(variable.label)) {
      const entry = terms.get(word) || { word, ids: [], inNew: 0 };
      entry.ids.push(variable.id);
      if (selected.has(variable.id)) entry.inNew += 1;
      terms.set(word, entry);
    }
  }
  return [...terms.values()].filter(entry => entry.ids.length >= 3)
    .sort((a, b) => b.ids.length - a.ids.length || a.word.localeCompare(b.word))
    .slice(0, limit);
}
