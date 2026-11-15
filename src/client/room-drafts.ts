/** Preserve drafts for existing rooms, including archived rooms, and no others. */
export function retainRoomEntries<T>(entries: Record<string, T>, roomIds: ReadonlySet<string>) {
  if (Object.keys(entries).every((id) => roomIds.has(id))) return entries;
  return Object.fromEntries(Object.entries(entries).filter(([id]) => roomIds.has(id)));
}

/** Also runs when Chat is unmounted, or this browser reconnects after deletion. */
export function pruneStoredRoomDrafts(roomIds: ReadonlySet<string>) {
  for (const key of ['loom.drafts', 'loom.task-input-targets', 'loom.task-input-attempts']) {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) || '{}');
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      const kept = retainRoomEntries(saved as Record<string, unknown>, roomIds);
      if (kept !== saved) localStorage.setItem(key, JSON.stringify(kept));
    } catch {
      // Unavailable storage must not block receiving the deletion or navigation.
    }
  }
}
