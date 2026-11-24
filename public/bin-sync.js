export async function reconcileEntries(entries, checkBin) {
  const checks = await Promise.all(entries.map(async entry => {
    try {
      const result = await checkBin(entry);
      if (result.missing) return { id: entry.id, missing: true };
      return {
        id: entry.id,
        visibility: ['public', 'private'].includes(result.visibility) ? result.visibility : null
      };
    } catch {
      return { id: entry.id };
    }
  }));

  const missing = new Set(checks.filter(check => check.missing).map(check => check.id));
  const visibilityById = new Map(checks
    .filter(check => check.visibility)
    .map(check => [check.id, check.visibility]));
  return {
    entries: entries
      .filter(entry => !missing.has(entry.id))
      .map(entry => ({ ...entry, visibility: visibilityById.get(entry.id) || entry.visibility })),
    missingCount: missing.size
  };
}
