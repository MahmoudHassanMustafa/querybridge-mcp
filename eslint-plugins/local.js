/**
 * In-project ESLint plugin codifying the CONVENTIONS.md §9 rules that
 * can't be expressed via stock `no-restricted-syntax` selectors.
 *
 * Two rules:
 *   - no-record-unknown-query-result — keeps tool code from typing
 *     queryWithTimeout results as Record<string, unknown> (or `any`).
 *     §4.2 wants a concrete row type next to every SQL.
 *   - log-message-no-interpolation — keeps log() messages free of
 *     `${var}` interpolation so operators can grep on a stable
 *     string. Variables go in the third-arg context object so they
 *     show up as separate JSON fields next to traceId / toolName.
 *
 * Why a plugin and not `no-restricted-syntax`:
 *  - Rule A needs to traverse TS type AST (TSTypeReference,
 *    TSTypeParameterInstantiation) and recognise the
 *    Array<Record<string, X>> pattern in two equivalent shapes.
 *    Esquery selectors can't easily express that.
 *  - Rule B needs to check that arguments[1] of a `log(...)` call is
 *    a TemplateLiteral with at least one expression — doable as a
 *    selector but the error message benefits from referencing the
 *    actual log level, and a plugin makes the helper hint cleaner.
 */

// ── helpers shared between rules ────────────────────────────────────

/** Identifier whose name we recognise (skips parens/satisfies/etc). */
function identName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  // `someTypeRef`'s name lives in `.typeName.name` for TSTypeReference,
  // but we only call this with expression nodes — keep simple.
  return undefined;
}

/** Is the AST a Record<string, unknown> / Record<string, any> type? */
function isRecordUnknownType(node) {
  if (!node || node.type !== "TSTypeReference") return false;
  if (node.typeName?.type !== "Identifier") return false;
  if (node.typeName.name !== "Record") return false;
  const params = node.typeArguments?.params ?? [];
  if (params.length !== 2) return false;
  const [k, v] = params;
  if (k.type !== "TSStringKeyword") return false;
  return v.type === "TSUnknownKeyword" || v.type === "TSAnyKeyword";
}

/** Is the AST an Array<...> or ...[] of a Record-unknown row? */
function isArrayOfRecordUnknown(node) {
  if (!node) return false;
  if (node.type === "TSTypeReference" && node.typeName?.name === "Array") {
    return isRecordUnknownType(node.typeArguments?.params?.[0]);
  }
  if (node.type === "TSArrayType") {
    return isRecordUnknownType(node.elementType);
  }
  return false;
}

// ── rule: no-record-unknown-query-result ────────────────────────────

const noRecordUnknownQueryResult = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Record<string, unknown> as the type argument to queryWithTimeout — define a concrete row type next to the SQL instead (CONVENTIONS.md §4.2).",
    },
    schema: [],
    messages: {
      tooBroad:
        "queryWithTimeout result is typed as `{{shape}}` — define a concrete row type alongside the SQL (CONVENTIONS.md §4.2). If the schema is genuinely unknown at compile time (e.g. sample_data), justify with an inline eslint-disable.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        // Only flag queryWithTimeout — pool.query / conn.execute return
        // a union that's harder to type, so they're left to review.
        if (identName(node.callee) !== "queryWithTimeout") return;
        const typeArg = node.typeArguments?.params?.[0];
        if (!typeArg) return;
        if (isArrayOfRecordUnknown(typeArg) || isRecordUnknownType(typeArg)) {
          const src = context.sourceCode.getText(typeArg);
          context.report({
            node: typeArg,
            messageId: "tooBroad",
            data: { shape: src },
          });
        }
      },
    };
  },
};

// ── rule: log-message-no-interpolation ──────────────────────────────

const logMessageNoInterpolation = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `${var}` interpolation in log() messages — variables belong in the third-arg context object so they appear as separate JSON fields (CONVENTIONS.md §5.1).",
    },
    schema: [],
    messages: {
      interpolated:
        "Don't interpolate into the log message — put `{{vars}}` in the context object (3rd arg) so it appears as a separate JSON field operators can grep on. See CONVENTIONS.md §5.1.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (identName(node.callee) !== "log") return;
        // log(level, msg, ctx?) — msg is arguments[1]
        const msg = node.arguments[1];
        if (!msg || msg.type !== "TemplateLiteral") return;
        if (msg.expressions.length === 0) return;
        // Collect the interpolated expressions' source text for the
        // error message — gives the operator a concrete suggestion.
        const vars = msg.expressions
          .map((e) => context.sourceCode.getText(e))
          .join(", ");
        context.report({
          node: msg,
          messageId: "interpolated",
          data: { vars },
        });
      },
    };
  },
};

// ── export ─────────────────────────────────────────────────────────

const plugin = {
  meta: { name: "local" },
  rules: {
    "no-record-unknown-query-result": noRecordUnknownQueryResult,
    "log-message-no-interpolation": logMessageNoInterpolation,
  },
};

export default plugin;
