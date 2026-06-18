import { create } from "zustand";
import { persist } from "zustand/middleware";

// Backstop on persisted size: pruneArchived handles the common case, but tasks
// that are deleted without archiving would otherwise leak forever. Evict the
// least-recently-touched tasks once this cap is exceeded.
const MAX_TASKS = 200;

interface ReviewViewedStoreState {
  // taskId -> file key -> signature of the diff when the file was marked read.
  // Insertion order is treated as recency (touched tasks re-inserted last).
  viewed: Record<string, Record<string, string>>;
}

interface ReviewViewedStoreActions {
  // Pass a signature to mark read (at that signature), or null to un-mark.
  setViewed: (taskId: string, key: string, sig: string | null) => void;
  pruneArchived: (archivedTaskIds: Iterable<string>) => void;
}

type ReviewViewedStore = ReviewViewedStoreState & ReviewViewedStoreActions;

export const useReviewViewedStore = create<ReviewViewedStore>()(
  persist(
    (set) => ({
      viewed: {},
      setViewed: (taskId, key, sig) =>
        set((state) => {
          const taskViewed = { ...(state.viewed[taskId] ?? {}) };
          if (sig === null) delete taskViewed[key];
          else taskViewed[key] = sig;

          // Re-insert the touched task last so it is evicted last.
          const { [taskId]: _omit, ...rest } = state.viewed;
          const next =
            Object.keys(taskViewed).length > 0
              ? { ...rest, [taskId]: taskViewed }
              : rest;

          const taskIds = Object.keys(next);
          for (const stale of taskIds.slice(0, taskIds.length - MAX_TASKS)) {
            delete next[stale];
          }
          return { viewed: next };
        }),
      pruneArchived: (archivedTaskIds) =>
        set((state) => {
          let changed = false;
          const next = { ...state.viewed };
          for (const id of archivedTaskIds) {
            if (id in next) {
              delete next[id];
              changed = true;
            }
          }
          return changed ? { viewed: next } : state;
        }),
    }),
    {
      name: "review-viewed-storage",
      version: 1,
      // v0 stored booleans without a signature; drop them so files re-resolve
      // their read state under the signature-aware model.
      migrate: (persisted, version) => {
        if (version < 1) return { viewed: {} };
        return persisted as ReviewViewedStoreState;
      },
    },
  ),
);
