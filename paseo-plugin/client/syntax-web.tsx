import {syntaxPalette,tokenColor} from './syntax-palette';
import "./prism-environment";
import { memo } from "react";
// The full prism.js entry includes prism-file-highlight, which touches
// Element.prototype in native hosts that expose only a partial document shim.
import Prism from "./prism-core";
import { normalizePrismTokens } from "./prism-normalize";
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

function tokenLines(code: string, language: string, grammar: Grammar): SyntaxToken[][] {
  if (code.length > MAX_HIGHLIGHT_LENGTH) return [[{ types: ["plain"], content: code }]];
  const key = `${language}\u0000${code}`;
  const cached = tokenCache.get(key);
  if (cached) {
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached.tokens;
  }
  const tokens = normalizePrismTokens(Prism.tokenize(code, grammar)) as SyntaxToken[][];
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

export { editorCodeFontFamily } from "./code-font";
import { editorCodeFontFamily } from "./code-font";

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
    {
      color: palette.plain,
      fontFamily: editorCodeFontFamily,
      ...(Platform.OS === "web" ? { whiteSpace: "pre" } : {}),
    } as TextStyle,
    style,
  ];
  if (!code) return <Text selectable style={codeStyle} />;
  const grammar = language === "plain" ? null : Prism.languages[language];
  if (!grammar) return <Text selectable style={codeStyle}>{code || " "}</Text>;
  const tokens = tokenLines(code || " ", language, grammar);
  return (
    <Text selectable style={codeStyle}>
      {(tokens[0] || []).map((token, index) => (
        <Text
          key={`${token.content}-${index}`}
          style={{ color: tokenColor(token.types, palette), fontFamily: editorCodeFontFamily }}
        >
          {token.content}
        </Text>
      ))}
    </Text>
  );
});
