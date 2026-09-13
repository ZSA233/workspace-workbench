import type { WorkbenchCopy, WorkbenchLocale } from "../../shared/copy.ts";
import { formatCopyFrom } from "../../shared/copy.ts";
import type { CommitNode } from "../model.ts";

export type CommitTimeDisplay = {
  absolute: string;
  relative: string;
};

export function formatCommitTime(
  value: string | null | undefined,
  locale: WorkbenchLocale,
  strings: WorkbenchCopy,
  now = Date.now(),
): CommitTimeDisplay {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!value || !Number.isFinite(timestamp)) {
    return { absolute: strings.commitTimeUnknown, relative: "" };
  }

  let absolute: string;
  try {
    absolute = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    absolute = new Date(timestamp).toISOString();
  }

  const delta = Math.max(0, now - timestamp);
  let relative: string;
  if (delta < 60_000) {
    relative = strings.text_9e636642d6;
  } else if (delta < 3_600_000) {
    relative = formatCopyFrom(strings, "text_607909447d", [Math.floor(delta / 60_000)]);
  } else if (delta < 86_400_000) {
    relative = formatCopyFrom(strings, "text_87a6439b2e", [Math.floor(delta / 3_600_000)]);
  } else {
    relative = formatCopyFrom(strings, "text_9094e27946", [Math.floor(delta / 86_400_000)]);
  }
  return { absolute, relative };
}

export function commitReferenceNames(node: Pick<CommitNode, "refs" | "decorations">): string[] {
  const values = [
    ...(node.refs || [])
      .filter((ref) => !ref.isHead)
      .map((ref) => ref.shortName || ref.name),
    ...(node.decorations || []).flatMap((decoration) => {
      if (decoration.startsWith("HEAD -> ")) return [decoration.slice("HEAD -> ".length)];
      return /^HEAD(?:\s|$)/.test(decoration) ? [] : [decoration];
    }),
  ];
  return [...new Set(values.filter(Boolean))];
}
