// Snapshot strings are opaque here; project transformations own their format.
export function recordHistory({ undoHistory, undoPointer, actionLog }, description, before, after, time) {
  if (before === after) return null;
  const history = [...undoHistory.slice(0, undoPointer + 1), { description, before, after }].slice(-60);
  return {
    undoHistory: history,
    undoPointer: history.length - 1,
    actionLog: [{ description, time }, ...actionLog].slice(0, 40),
  };
}

export function historyStep({ undoHistory, undoPointer }, direction) {
  const index = direction === "undo" ? undoPointer : undoPointer + 1;
  if (index < 0 || index >= undoHistory.length) return null;
  return {
    undoPointer: direction === "undo" ? index - 1 : index,
    snapshot: undoHistory[index][direction === "undo" ? "before" : "after"],
  };
}
