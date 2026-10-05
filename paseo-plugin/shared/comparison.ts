/** Frozen comparison identity shared by the sidebar and file tabs. */
export type Comparison = {
  fromRef: string; toRef: string; fromSha: string; toSha: string;
  mode: 'endpoints' | 'contribution'; leftSha: string; mergeBase: string | null;
};
export const comparisonKey = (value?: Comparison) => value
  ? JSON.stringify([value.fromSha, value.toSha, value.mode, value.leftSha]) : '';
