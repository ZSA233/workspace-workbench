import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const adapterModule = "@/utils/access-download";
const labels = {
  ar: "تم التحويل إلى مدير التنزيلات في النظام",
  en: "Handed to the system download manager",
  es: "Enviado al gestor de descargas del sistema",
  fr: "Transmis au gestionnaire de téléchargements",
  ja: "システムの保存画面に引き渡しました",
  ko: "시스템 다운로드로 전달됨",
  "pt-BR": "Enviado ao gerenciador de downloads",
  ru: "Передано системному менеджеру загрузок",
  "zh-CN": "已交给系统保存",
};

function find(node, predicate) {
  const result = [];
  function visit(child) {
    if (predicate(child)) result.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return result;
}

function one(file, label, matches) {
  if (matches.length !== 1) {
    throw new Error(`${file.fileName}: expected one ${label}, found ${matches.length}`);
  }
  return matches[0];
}

const named = (node, name) =>
  Boolean(node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === name);
const member = (node, object, property) =>
  ts.isPropertyAccessExpression(node) && named(node.expression, object) && named(node.name, property);

function parse(path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) throw new Error(`${path}: cannot parse TypeScript`);
  return file;
}

function insertBefore(file, node, lines) {
  const start = node.getStart(file);
  const line = file.getLineAndCharacterOfPosition(start).line;
  const indent = file.text.slice(file.getLineStarts()[line], start).match(/^\s*/)[0];
  const eol = file.text.includes("\r\n") ? "\r\n" : "\n";
  return { start, end: start, text: [...lines, ""].join(eol + indent) };
}

function edit(file, edits) {
  let text = file.text;
  for (const { start, end, text: replacement } of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  return parse(file.fileName, text).text;
}

function integrateStore(file) {
  const imports = file.statements.filter(ts.isImportDeclaration);
  if (imports.some(({ moduleSpecifier }) => named(moduleSpecifier, adapterModule))) {
    throw new Error(`${file.fileName}: download adapter is already installed`);
  }
  const schema = one(file, "Download interface", file.statements.filter(
    (node) => ts.isInterfaceDeclaration(node) && named(node.name, "Download"),
  ));
  const status = one(file, "Download.status union", schema.members.filter(
    (node) => ts.isPropertySignature(node) && named(node.name, "status") && node.type && ts.isUnionTypeNode(node.type),
  )).type;
  const statuses = status.types.flatMap((type) =>
    ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal) ? [type.literal.text] : [],
  );
  if (!["downloading", "complete", "error"].every((value) => statuses.includes(value)) || statuses.includes("delegated")) {
    throw new Error(`${file.fileName}: unsupported Download.status values`);
  }

  const method = one(file, "startDownload implementation", find(file, ts.isPropertyAssignment).filter(
    (node) => named(node.name, "startDownload") && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body),
  )).initializer;
  const { tryBlock } = one(file, "startDownload try block", method.body.statements.filter(ts.isTryStatement));
  const bindings = tryBlock.statements.filter(ts.isVariableStatement).flatMap(
    (statement) => statement.declarationList.declarations.map((declaration) => ({ statement, declaration })),
  );
  const { statement: request, declaration: { name: token } } = one(file, "file download token request", bindings.filter(
    ({ declaration: { name, initializer } }) =>
      ts.isIdentifier(name) && initializer && ts.isAwaitExpression(initializer) &&
      ts.isCallExpression(initializer.expression) && named(initializer.expression.expression, "requestFileDownloadToken"),
  ));
  const { statement: filename, declaration: { name: filenameBinding } } = one(file, "resolved download filename", bindings.filter(
    ({ declaration: { name, initializer } }) =>
      ts.isIdentifier(name) && initializer && ts.isBinaryExpression(initializer) &&
      initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      member(initializer.left, token.text, "fileName"),
  ));
  const { statement: transport } = one(file, "normal download transport selection", bindings.filter(
    ({ declaration: { initializer } }) =>
      initializer && ts.isCallExpression(initializer) && named(initializer.expression, "resolveDaemonDownloadTarget"),
  ));
  const tokenGuard = tryBlock.statements.some((node) =>
    ts.isIfStatement(node) && request.end <= node.pos && node.end <= filename.pos &&
    find(node.expression, (part) => ts.isPrefixUnaryExpression(part) &&
      part.operator === ts.SyntaxKind.ExclamationToken && member(part.operand, token.text, "token")).length > 0 &&
    find(node.thenStatement, ts.isThrowStatement).length > 0,
  );
  if (!tokenGuard || filename.end > transport.pos) {
    throw new Error(`${file.fileName}: expected a checked token and filename before transport selection`);
  }
  if (!imports.length) throw new Error(`${file.fileName}: expected TypeScript imports`);
  return edit(file, [
    insertBefore(file, imports[0], [`import { tryAccessDownload } from "${adapterModule}";`]),
    { start: status.end, end: status.end, text: ' | "delegated"' },
    insertBefore(file, transport, [
      "if (",
      "  isWeb &&",
      "  (await tryAccessDownload({",
      "    serverId,",
      `    token: ${token.text}.token,`,
      `    filename: ${filenameBinding.text},`,
      "  }))",
      ") {",
      "  set((state) => {",
      "    const current = state.downloads.get(id);",
      "    if (!current) return state;",
      "    const downloads = new Map(state.downloads);",
      '    downloads.set(id, { ...current, status: "delegated" });',
      "    return { downloads };",
      "  });",
      "  return;",
      "}",
    ]),
  ]);
}

function integrateToast(file) {
  const label = one(file, "download status label", file.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && named(node.name, "getDownloadStatusText") && node.body,
  ));
  const complete = one(file, "complete status label", label.body.statements.filter(
    (node) => ts.isIfStatement(node) && ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isPropertyAccessExpression(node.expression.left) && named(node.expression.left.name, "status") &&
      named(node.expression.right, "complete"),
  ));
  const error = one(file, "download error icon", find(file, ts.isConditionalExpression).filter((node) => {
    const icon = ts.skipParentheses(node.whenTrue);
    return ts.isJsxExpression(node.parent) && ts.isJsxSelfClosingElement(icon) && named(icon.tagName, "XCircle");
  }));
  const status = one(file, "download status used by the error icon", [...new Set(
    find(error.condition, (node) => ts.isPropertyAccessExpression(node) && named(node.name, "status"))
      .map((node) => node.getText(file)),
  )]);
  const icons = one(file, "Lucide icon imports", file.statements.filter(
    (node) => ts.isImportDeclaration(node) && named(node.moduleSpecifier, "lucide-react-native") &&
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings),
  )).importClause.namedBindings.elements;
  const icon = one(file, "XCircle icon import", icons.filter((node) => named(node.name, "XCircle")));
  return edit(file, [
    { start: icon.end, end: icon.end, text: ", ArrowDownToLine" },
    insertBefore(file, complete, [
      `if (${complete.expression.left.getText(file)} === "delegated") return t("downloads.handedOff");`,
    ]),
    insertBefore(file, error.parent, [
      `{${status} === "delegated" ? (`,
      "  <ArrowDownToLine size={18} color={theme.colors.primary} />",
      ") : null}",
    ]),
    {
      start: error.condition.getStart(file),
      end: error.condition.end,
      text: `${status} !== "delegated" && (${error.condition.getText(file)})`,
    },
  ]);
}

function integrateLocale(file, locale) {
  const sections = find(file, ts.isPropertyAssignment).filter(
    (node) => named(node.name, "downloads") && ts.isObjectLiteralExpression(node.initializer),
  );
  if (!sections.length && !Object.hasOwn(labels, locale)) return;
  const { properties } = one(file, "downloads translations", sections).initializer;
  if (properties.some((node) => named(node.name, "handedOff"))) {
    throw new Error(`${file.fileName}: download handoff translation already exists`);
  }
  const first = one(file, "first download translation", properties.slice(0, 1));
  return edit(file, [insertBefore(file, first, [
    `handedOff: ${JSON.stringify(labels[locale] ?? labels.en)},`,
  ])]);
}

/** Adapt only the recognized download flow. Prepare all edits before writing any file. */
export async function integrateDownloadHandoff(source) {
  const app = join(source, "packages/app/src");
  const locales = join(app, "i18n/resources");
  const changes = new Map();
  for (const [name, integrate] of [
    ["stores/download-store.ts", integrateStore],
    ["components/download-toast.tsx", integrateToast],
  ]) {
    const path = join(app, name);
    changes.set(path, integrate(parse(path, await readFile(path, "utf8"))));
  }
  const names = (await readdir(locales)).filter((name) => name.endsWith(".ts"));
  if (!names.includes("en.ts")) throw new Error(`${locales}: English download translations are missing`);
  for (const name of names) {
    const path = join(locales, name);
    const text = integrateLocale(parse(path, await readFile(path, "utf8")), basename(name, ".ts"));
    if (text !== undefined) changes.set(path, text);
  }
  for (const [file, text] of changes) await writeFile(file, text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Expected the extracted Paseo source directory");
  await integrateDownloadHandoff(resolve(process.argv[2]));
}
