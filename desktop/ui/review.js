/** Parse displayed unified hunks into aligned old/new rows; never pretend these are full files. */
export function splitPatch(patch) {
  const rows = []; let oldLine = 0; let newLine = 0; let active = false; let removed = []; let added = [];
  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ kind: 'change', before: removed[i] ?? null, after: added[i] ?? null });
    removed = []; added = [];
  }
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { flush(); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); active = true; rows.push({ kind: 'hunk', text: line }); continue; }
    if (!active || line.startsWith('\\')) continue;
    if (line.startsWith('-')) removed.push({ line: oldLine++, text: line.slice(1) });
    else if (line.startsWith('+')) added.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith(' ')) { flush(); rows.push({ kind: 'context', before: { line: oldLine++, text: line.slice(1) }, after: { line: newLine++, text: line.slice(1) } }); }
    else { flush(); active = false; }
  }
  flush(); return rows;
}
