import { createContext, useContext } from "react";

export interface ReviewViewedContextValue {
  // key -> signature of the diff when the file was marked read
  viewedRecord: Record<string, string>;
  // key -> current signature of the diff being shown
  currentSignatures: Map<string, string>;
  // Pass a signature to mark read (at that signature), or null to un-mark.
  toggleViewed: (key: string, sig: string | null) => void;
}

export const ReviewViewedContext =
  createContext<ReviewViewedContextValue | null>(null);

export function useReviewViewedContext(): ReviewViewedContextValue | null {
  return useContext(ReviewViewedContext);
}
