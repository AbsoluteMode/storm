// scripts/lib/proof.mjs
// Proof-required review: parse engine proof tags, classify experiment cost,
// match predictions, run experiments in isolation, and orchestrate the second
// pass. PROVEN is set ONLY here (verify-don't-trust), never by an engine.

// Tolerant line parser: STORM_RESULT text -> findings. Never throws; unknown
// lines are ignored. Engine-claimed [PROVEN] is captured as 'proven-claimed'
// so the orchestrator can DOWNGRADE it (an engine cannot self-prove).
export function parseProofFindings(text) {
  const findings = [];
  let cur = null;
  const push = () => { if (cur) { findings.push(cur); cur = null; } };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^\[NEEDS-EXPERIMENT\]\s*(.*)$/i))) {
      push();
      cur = { tag: 'needs-experiment', title: m[1].trim() };
    } else if ((m = line.match(/^\[UNPROVEN-CANNOT\]\s*(.*)$/i))) {
      push();
      const rest = m[1].trim();
      const wm = rest.match(/^(.*?)\s*[—-]\s*why:\s*(.*)$/i);
      cur = wm
        ? { tag: 'unproven-cannot', title: wm[1].trim(), why: wm[2].trim() }
        : { tag: 'unproven-cannot', title: rest };
    } else if ((m = line.match(/^\[PROVEN\]\s*(.*)$/i))) {
      push();
      cur = { tag: 'proven-claimed', title: m[1].trim() };
    } else if (cur && (m = line.match(/^run:\s*(.*)$/i))) {
      cur.run = m[1].trim();
    } else if (cur && (m = line.match(/^expects:\s*(.*)$/i))) {
      cur.expects = m[1].trim();
    } else if (cur && (m = line.match(/^cost:\s*(.*)$/i))) {
      cur.cost = m[1].trim();
    }
    // unknown lines: ignored (tolerant)
  }
  push();
  return findings;
}
