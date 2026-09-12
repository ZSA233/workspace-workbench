import "./prism-environment";
import { memo } from "react";
import { normalizeTokens } from "prism-react-renderer/dist/index.mjs";
// The full prism.js entry includes prism-file-highlight, which touches
// Element.prototype in native hosts that expose only a partial document shim.
import Prism from "./prism-core";
import { Platform, Text, type StyleProp, type TextStyle } from "react-native";
import type { Grammar } from "prismjs";

import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-go";
import "prismjs/components/prism-json";
import "prismjs/components/prism-json5";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-css";

import { languageForPath } from "./model";

type SyntaxTheme = {
  colors: {
    surface0: string;
    foreground: string;
    foregroundMuted: string;
  };
};

type SyntaxToken = { content: string; types: string[] };
const TOKEN_CACHE_LIMIT = 256;
const TOKEN_CACHE_MAX_CHARS = 512_000;
const MAX_HIGHLIGHT_LENGTH = 12_000;
type CachedTokenLines = { tokens: SyntaxToken[][]; size: number };
const tokenCache = new Map<string, CachedTokenLines>();
let tokenCacheChars = 0;

type SyntaxPalette = {
  plain: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  boolean: string;
  function: string;
  type: string;
  property: string;
  tag: string;
  attribute: string;
  regex: string;
  operator: string;
  punctuation: string;
  builtin: string;
  constant: string;
};

/**
 * Keep editor syntax colors separate from Git state colors. Green and yellow
 * already mean added/attention in the Workbench UI; reusing them for strings
 * and numbers makes the diff harder to scan.
 */
function syntaxPalette(theme: SyntaxTheme): SyntaxPalette {
  const dark = isDarkSurface(theme.colors.surface0);
  return dark
    ? {
        plain: theme.colors.foreground,
        comment: "#6A9955",
        keyword: "#569CD6",
        string: "#CE9178",
        number: "#B5CEA8",
        boolean: "#569CD6",
        function: "#DCDCAA",
        type: "#4EC9B0",
        property: "#9CDCFE",
        tag: "#569CD6",
        attribute: "#9CDCFE",
        regex: "#D16969",
        operator: "#D4D4D4",
        punctuation: "#808080",
        builtin: "#4FC1FF",
        constant: "#4FC1FF",
      }
    : {
        plain: theme.colors.foreground,
        comment: "#008000",
        keyword: "#0000FF",
        string: "#A31515",
        number: "#098658",
        boolean: "#0000FF",
        function: "#795E26",
        type: "#267F99",
        property: "#001080",
        tag: "#800000",
        attribute: "#FF0000",
        regex: "#811F3F",
        operator: "#393A34",
        punctuation: "#808080",
        builtin: "#0070C1",
        constant: "#0070C1",
      };
}

function isDarkSurface(surface: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(surface.trim());
  if (!match) return true;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] < 0.35;
}

function tokenColor(types: string[], palette: SyntaxPalette): string {
  const has = (...names: string[]) => names.some((name) => types.includes(name));
  if (has("comment", "prolog", "doctype")) return palette.comment;
  if (has("tag", "namespace")) return palette.tag;
  if (has("property", "literal-property")) return palette.property;
  if (has("attr-name", "attribute")) return palette.attribute;
  if (has("string", "char", "attr-value")) return palette.string;
  if (has("regex", "url")) return palette.regex;
  if (has("boolean")) return palette.boolean;
  if (has("number", "date")) return palette.number;
  if (has("keyword", "control", "directive", "selector")) return palette.keyword;
  if (has("function", "function-variable")) return palette.function;
  if (has("class-name", "type")) return palette.type;
  if (has("builtin")) return palette.builtin;
  if (has("constant")) return palette.constant;
  if (has("operator", "important")) return palette.operator;
  if (has("punctuation")) return palette.punctuation;
  return palette.plain;
}

function tokenLines(code: string, language: string, grammar: Grammar): SyntaxToken[][] {
  if (code.length > MAX_HIGHLIGHT_LENGTH) return [[{ types: ["plain"], content: code }]];
  const key = `${language}\u0000${code}`;
  const cached = tokenCache.get(key);
  if (cached) {
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached.tokens;
  }
  const tokens = normalizeTokens(Prism.tokenize(code, grammar)) as SyntaxToken[][];
  while (tokenCache.size >= TOKEN_CACHE_LIMIT || tokenCacheChars + code.length > TOKEN_CACHE_MAX_CHARS) {
    const oldest = tokenCache.keys().next().value;
    if (typeof oldest !== "string") break;
    const entry = tokenCache.get(oldest);
    if (entry) tokenCacheChars -= entry.size;
    tokenCache.delete(oldest);
  }
  tokenCache.set(key, { tokens, size: code.length });
  tokenCacheChars += code.length;
  return tokens;
}

export const editorCodeFontFamily = Platform.OS === "web"
  ? 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace'
  : Platform.OS === "ios"
    ? "Menlo"
    : "monospace";

type HighlightedCodeProps = {
  code: string;
  path: string;
  theme: SyntaxTheme;
  style?: StyleProp<TextStyle>;
};

export const HighlightedCode = memo(function HighlightedCode({ code, path, theme, style }: HighlightedCodeProps) {
  const language = languageForPath(path);
  const palette = syntaxPalette(theme);
  const codeStyle: StyleProp<TextStyle> = [
    style,
    {
      color: palette.plain,
      fontFamily: editorCodeFontFamily,
      ...(Platform.OS === "web" ? { whiteSpace: "pre" } : {}),
    } as TextStyle,
  ];
  const grammar = language === "plain" ? null : Prism.languages[language];
  if (!grammar) return <Text selectable style={codeStyle}>{code || " "}</Text>;
  const tokens = tokenLines(code || " ", language, grammar);
  return (
    <Text selectable style={codeStyle}>
      {(tokens[0] || []).map((token, index) => (
        <Text
          key={`${token.content}-${index}`}
          style={{ color: tokenColor(token.types, palette) }}
        >
          {token.content}
        </Text>
      ))}
    </Text>
  );
});
