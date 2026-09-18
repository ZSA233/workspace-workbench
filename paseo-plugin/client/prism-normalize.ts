import type Prism from "prismjs/components/prism-core";

type PrismToken = string | {
  type: string;
  content: PrismToken | PrismToken[];
  alias?: string | string[];
};

export type NormalizedToken = {
  types: string[];
  content: string;
};

const newlineRe = /\r\n|\r|\n/;

function normalizeEmptyLine(line: NormalizedToken[]): void {
  if (line.length === 0) {
    line.push({ types: ["plain"], content: "\n" });
  } else if (line.length === 1 && line[0].content === "") {
    line[0].content = "\n";
  }
}

function appendType(types: string[], type: string): string[] {
  return types.length > 0 && types[types.length - 1] === type ? types : types.concat(type);
}

/**
 * Convert Prism's nested Token tree into lines without importing
 * prism-react-renderer. That package imports the browser-only prism.js entry,
 * which touches Element.prototype while the native Paseo runtime is loading.
 */
export function normalizePrismTokens(tokens: ReturnType<typeof Prism.tokenize>): NormalizedToken[][] {
  const typeStack: string[][] = [[]];
  const tokenStack: PrismToken[][] = [tokens as PrismToken[]];
  const indexStack = [0];
  const sizeStack = [tokens.length];
  let stackIndex = 0;
  let currentLine: NormalizedToken[] = [];
  const lines: NormalizedToken[][] = [currentLine];

  while (stackIndex > -1) {
    let index: number;
    while ((index = indexStack[stackIndex]++) < sizeStack[stackIndex]) {
      let content: PrismToken | PrismToken[];
      let types = typeStack[stackIndex];
      const token = tokenStack[stackIndex][index];
      if (typeof token === "string") {
        types = stackIndex > 0 ? types : ["plain"];
        content = token;
      } else {
        types = appendType(types, token.type);
        if (token.alias) {
          for (const alias of Array.isArray(token.alias) ? token.alias : [token.alias]) {
            types = appendType(types, alias);
          }
        }
        content = token.content;
      }
      if (typeof content !== "string") {
        stackIndex++;
        typeStack.push(types);
        tokenStack.push(Array.isArray(content) ? content : [content]);
        indexStack.push(0);
        sizeStack.push(Array.isArray(content) ? content.length : 1);
        continue;
      }

      const parts = content.split(newlineRe);
      currentLine.push({ types, content: parts[0] });
      for (let partIndex = 1; partIndex < parts.length; partIndex++) {
        normalizeEmptyLine(currentLine);
        lines.push(currentLine = []);
        currentLine.push({ types, content: parts[partIndex] });
      }
    }
    stackIndex--;
    typeStack.pop();
    tokenStack.pop();
    indexStack.pop();
    sizeStack.pop();
  }

  normalizeEmptyLine(currentLine);
  return lines;
}
