import { useEffect, useRef, useState } from "react";
import { allocateSections } from "./section-allocation";
import { beginResize } from "./resize-session";
import type { ObserverSectionId, ObserverSectionLayout } from "./model";

export function useSectionSizing(height: number, width: number, identity: string, layout: ObserverSectionLayout, commit: (sizes: Record<ObserverSectionId, number>) => void) {
  const [chrome, setChrome] = useState(132);
  const [content, setContent] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<ReturnType<typeof allocateSections> | null>(null);
  const session = useRef<ReturnType<typeof beginResize>>(null);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const pendingDy = useRef(0);
  const latest = useRef({ height, width, identity, layout, commit, chrome, content });
  latest.current = { height, width, identity, layout, commit, chrome, content };
  const controller = useRef<{
    begin(id: ObserverSectionId): boolean; move(dy: number): void; finish(dy: number): void; cancel(): void;
  } | null>(null);
  if (!controller.current) {
    const clearFrame = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
    controller.current = {
      begin(id) {
        const v = latest.current;
        session.current = beginResize(id, v.height, v.chrome, v.layout, v.content);
        if (!session.current) return false;
        pendingDy.current = 0;
        setPreview(session.current.initial);
        return true;
      },
      move(dy) {
        pendingDy.current = dy;
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          if (session.current) setPreview(session.current.update(pendingDy.current).allocation);
        });
      },
      finish(dy) {
        clearFrame();
        pendingDy.current = dy;
        const active = session.current;
        session.current = null;
        if (active) latest.current.commit(active.update(dy).allocation.sizes);
        setPreview(null);
      },
      cancel() { clearFrame(); pendingDy.current = 0; session.current = null; setPreview(null); },
    };
  }
  useEffect(() => { controller.current!.cancel(); }, [height, width, identity, layout.repositories.collapsed, layout.graph.collapsed, layout.changes.collapsed]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); session.current = null; }, []);
  return {
    ...(preview || allocateSections(height, layout, chrome, content)),
    dragging: preview !== null,
    ...controller.current,
    measureContent(id: ObserverSectionId, value: number) {
      if (session.current || preview) return;
      const rounded = Math.round(value);
      setContent((current) => current[id] === rounded ? current : { ...current, [id]: rounded });
    },
    measureChrome(value: number) {
      if (session.current || preview) return;
      setChrome((current) => Math.abs(current - value) > 1 ? Math.round(value) : current);
    },
  };
}
