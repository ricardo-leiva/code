import { createContext, useContext } from "react";

export interface ReviewViewedContextValue {
  viewedFiles: Set<string>;
  toggleViewed: (key: string) => void;
}

export const ReviewViewedContext =
  createContext<ReviewViewedContextValue | null>(null);

export function useReviewViewedContext(): ReviewViewedContextValue | null {
  return useContext(ReviewViewedContext);
}
