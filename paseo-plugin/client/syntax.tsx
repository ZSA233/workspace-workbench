import { Highlight } from "prism-react-renderer/dist/index.mjs";
import Prism from "prismjs/prism.js";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-go";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";
import { Text } from "react-native";

import { languageForPath } from "./model";
import { observerAccent } from "./theme";

type SyntaxTheme = {
  colors: {
    surface0: string;
    foreground: string;
    foregroundMuted: string;
    accent: string;
    statusSuccess: string;
    statusWarning: string;
  };
};

type SyntaxToken = { content: string; types: string[] };

function tokenColor(types: string[], theme: SyntaxTheme): string {
  if (types.includes("comment") || types.includes("prolog")) {
    return theme.colors.foregroundMuted;
  }
  if (types.includes("string") || types.includes("char")) return theme.colors.statusSuccess;
  if (types.includes("keyword") || types.includes("selector")) return observerAccent(theme);
  if (types.includes("number") || types.includes("boolean")) return theme.colors.statusWarning;
  if (types.includes("function") || types.includes("class-name")) return theme.colors.foreground;
  if (types.includes("operator") || types.includes("punctuation")) {
    return theme.colors.foregroundMuted;
  }
  return theme.colors.foreground;
}

export function HighlightedCode({
  code,
  path,
  theme,
}: {
  code: string;
  path: string;
  theme: SyntaxTheme;
}) {
  const language = languageForPath(path);
  if (language === "plain") return <Text>{code || " "}</Text>;
  return (
    <Highlight
      code={code || " "}
      language={language}
      prism={Prism}
    >
      {({ tokens }: { tokens: SyntaxToken[][] }) => (
        <Text>
          {(tokens[0] || []).map((token, index) => (
            <Text
              key={`${token.content}-${index}`}
              style={{ color: tokenColor(token.types, theme) }}
            >
              {token.content}
            </Text>
          ))}
        </Text>
      )}
    </Highlight>
  );
}
