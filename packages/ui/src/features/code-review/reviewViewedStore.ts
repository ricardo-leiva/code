import { create } from "zustand";
import { persist } from "zustand/middleware";

// Backstop on persisted size: clearTasks handles the common cases (archive,
// merge), but tasks deleted without archiving would otherwise leak forever.
// Cap total stored entries (≈100 bytes each, so ~25KB) rather than task count,
// since files-per-task varies wildly; evict least-recently-touched tasks past
// the cap.
const MAX_FILES = 250;

interface ReviewViewedStoreState {
  // taskId -> file key -> signature of the diff when the file was marked read.
  // Insertion order is treated as recency (touched tasks re-inserted last).
  viewed: Record<string, Record<string, string>>;
}

interface ReviewViewedStoreActions {
  // Pass a signature to mark read (at that signature), or null to un-mark.
  setViewed: (taskId: string, key: string, sig: string | null) => void;
  // Drop read state for the given tasks (archived, merged, or otherwise done).
  clearTasks: (taskIds: Iterable<string>) => void;
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

          // Evict oldest tasks (front of insertion order) until under the cap,
          // never dropping the task just touched.
          let total = 0;
          for (const id in next) total += Object.keys(next[id]).length;
          for (const id of Object.keys(next)) {
            if (total <= MAX_FILES) break;
            if (id === taskId) continue;
            total -= Object.keys(next[id]).length;
            delete next[id];
          }
          return { viewed: next };
        }),
      clearTasks: (taskIds) =>
        set((state) => {
          let changed = false;
          const next = { ...state.viewed };
          for (const id of taskIds) {
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
