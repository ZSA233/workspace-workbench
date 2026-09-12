export type ObserverTheme = {
  colors: {
    surface0: string;
    accent: string;
  };
};

function surfaceLuminance(surface: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(surface.trim());
  if (!match) return null;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Keep the selected/graph semantic distinct from clean/healthy green. */
export function observerAccent(theme: ObserverTheme): string {
  const luminance = surfaceLuminance(theme.colors.surface0);
  if (luminance === null) return theme.colors.accent;
  return luminance < 0.35 ? "#68bbff" : "#2376bd";
}
