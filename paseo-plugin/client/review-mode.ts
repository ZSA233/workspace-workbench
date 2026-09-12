export type ReviewMode = "split" | "unified";

export function effectiveReviewMode(compact: boolean, saved: ReviewMode | null | undefined): ReviewMode {
  return compact ? "unified" : saved || "split";
}
