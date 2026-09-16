type EventTargetLike = {
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
};

type DocumentLike = EventTargetLike & {
  visibilityState?: string;
  hasFocus?(): boolean;
};

export type WebForegroundTarget = EventTargetLike & { document?: DocumentLike };

export function webForeground(target: WebForegroundTarget): boolean {
  return target.document?.visibilityState !== "hidden" && target.document?.hasFocus?.() !== false;
}

export function observeWebForeground(target: WebForegroundTarget, onChange: (active: boolean) => void): () => void {
  const document = target.document;
  let focused = document?.hasFocus?.() !== false;
  const publish = () => onChange(document?.visibilityState !== "hidden" && focused);
  const blur = () => { focused = false; publish(); };
  const focus = () => { focused = true; publish(); };
  const visibility = () => {
    if (document?.visibilityState !== "hidden") focused = document?.hasFocus?.() !== false;
    publish();
  };
  target.addEventListener?.("blur", blur);
  target.addEventListener?.("focus", focus);
  document?.addEventListener?.("visibilitychange", visibility);
  publish();
  return () => {
    target.removeEventListener?.("blur", blur);
    target.removeEventListener?.("focus", focus);
    document?.removeEventListener?.("visibilitychange", visibility);
  };
}
