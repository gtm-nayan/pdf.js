import * as acorn from "acorn";
import vm from "vm";
import fs from "fs";
import path from "path";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import { builtinModules } from "module";

const PDFJS_PREPROCESSOR_NAME = "PDFJSDev";
const ROOT_PREFIX = "$ROOT/";
const ACORN_ECMA_VERSION = 2022;

const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);

function isLiteral(obj, value) {
  return obj.type === "Literal" && obj.value === value;
}

function isPDFJSPreprocessor(obj) {
  return obj.type === "Identifier" && obj.name === PDFJS_PREPROCESSOR_NAME;
}

function evalWithDefines(code, defines, loc) {
  if (!code || !code.trim()) {
    throw new Error("No JavaScript expression given");
  }
  return vm.runInNewContext(code, defines, { displayErrors: false });
}

function handlePreprocessorAction(ctx, actionName, args, loc) {
  try {
    let arg;
    switch (actionName) {
      case "test":
        arg = args[0];
        if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") {
          throw new Error("No code for testing is given");
        }
        const isTrue = !!evalWithDefines(arg.value, ctx.defines);
        return { type: "Literal", value: isTrue, loc };
      case "eval":
        arg = args[0];
        if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") {
          throw new Error("No code for eval is given");
        }
        const result = evalWithDefines(arg.value, ctx.defines);
        if (
          typeof result === "boolean" ||
          typeof result === "string" ||
          typeof result === "number"
        ) {
          return { type: "Literal", value: result, loc };
        }
        if (typeof result === "object") {
          const parsedObj = acorn.parse("(" + JSON.stringify(result) + ")", {
            ecmaVersion: ACORN_ECMA_VERSION,
          });
          parsedObj.body[0].expression.loc = loc;
          return parsedObj.body[0].expression;
        }
        break;
      case "json":
        arg = args[0];
        if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") {
          throw new Error("Path to JSON is not provided");
        }
        let jsonPath = arg.value;
        if (jsonPath.indexOf(ROOT_PREFIX) === 0) {
          jsonPath = path.join(
            ctx.rootPath,
            jsonPath.substring(ROOT_PREFIX.length)
          );
        }
        const jsonContent = fs.readFileSync(jsonPath).toString();
        const parsedJSON = acorn.parse("(" + jsonContent + ")", {
          ecmaVersion: ACORN_ECMA_VERSION,
        });
        parsedJSON.body[0].expression.loc = loc;
        return parsedJSON.body[0].expression;
    }
    throw new Error("Unsupported action");
  } catch (e) {
    throw new Error(
      "Could not process " +
        PDFJS_PREPROCESSOR_NAME +
        "." +
        actionName +
        " at " +
        JSON.stringify(loc) +
        "\n" +
        e.name +
        ": " +
        e.message
    );
  }
}

function postprocessNode(ctx, node) {
  switch (node.type) {
    case "Identifier":
      if (node.name === "__non_webpack_require__") {
        return { type: "Identifier", name: "require", loc: node.loc };
      } else if (node.name === "__non_webpack_import__") {
        return { type: "Identifier", name: "import", loc: node.loc };
      }
      break;
    case "ExportNamedDeclaration":
    case "ImportDeclaration":
      if (
        node.source &&
        node.source.type === "Literal" &&
        ctx.map &&
        ctx.map[node.source.value]
      ) {
        const newValue = ctx.map[node.source.value];
        node.source.value = node.source.raw = newValue;
      }
      break;
    case "IfStatement":
      if (isLiteral(node.test, true)) {
        // if (true) stmt1; => stmt1
        return node.consequent;
      } else if (isLiteral(node.test, false)) {
        // if (false) stmt1; else stmt2; => stmt2
        return node.alternate || { type: "EmptyStatement", loc: node.loc };
      }
      break;
    case "ConditionalExpression":
      if (isLiteral(node.test, true)) {
        // true ? stmt1 : stmt2 => stmt1
        return node.consequent;
      } else if (isLiteral(node.test, false)) {
        // false ? stmt1 : stmt2 => stmt2
        return node.alternate;
      }
      break;
    case "UnaryExpression":
      if (node.operator === "typeof" && isPDFJSPreprocessor(node.argument)) {
        return { type: "Literal", value: "object", loc: node.loc };
      }
      if (
        node.operator === "!" &&
        node.argument.type === "Literal" &&
        typeof node.argument.value === "boolean"
      ) {
        // !true => false,  !false => true
        return { type: "Literal", value: !node.argument.value, loc: node.loc };
      }
      break;
    case "LogicalExpression":
      switch (node.operator) {
        case "&&":
          if (isLiteral(node.left, true)) {
            return node.right;
          }
          if (isLiteral(node.left, false)) {
            return node.left;
          }
          break;
        case "||":
          if (isLiteral(node.left, true)) {
            return node.left;
          }
          if (isLiteral(node.left, false)) {
            return node.right;
          }
          break;
      }
      break;
    case "BinaryExpression":
      switch (node.operator) {
        case "==":
        case "===":
        case "!=":
        case "!==":
          if (
            node.left.type === "Literal" &&
            node.right.type === "Literal" &&
            typeof node.left.value === typeof node.right.value
          ) {
            // folding two literals == and != check
            switch (typeof node.left.value) {
              case "string":
              case "boolean":
              case "number":
                const equal = node.left.value === node.right.value;
                return {
                  type: "Literal",
                  value: (node.operator[0] === "=") === equal,
                  loc: node.loc,
                };
            }
          }
          break;
      }
      break;
    case "CallExpression":
      if (
        node.callee.type === "MemberExpression" &&
        isPDFJSPreprocessor(node.callee.object) &&
        node.callee.property.type === "Identifier"
      ) {
        // PDFJSDev.xxxx(arg1, arg2, ...) => transform
        const action = node.callee.property.name;
        return handlePreprocessorAction(ctx, action, node.arguments, node.loc);
      }
      // require('string')
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1 &&
        node.arguments[0].type === "Literal" &&
        ctx.map &&
        ctx.map[node.arguments[0].value]
      ) {
        const requireName = node.arguments[0];
        requireName.value = requireName.raw = ctx.map[requireName.value];
      }
      break;
    case "BlockStatement":
      let subExpressionIndex = 0;
      while (subExpressionIndex < node.body.length) {
        switch (node.body[subExpressionIndex].type) {
          case "EmptyStatement":
            // Removing empty statements from the blocks.
            node.body.splice(subExpressionIndex, 1);
            continue;
          case "BlockStatement":
            // Block statements inside a block are moved to the parent one.
            const subChildren = node.body[subExpressionIndex].body;
            Array.prototype.splice.apply(node.body, [
              subExpressionIndex,
              1,
              ...subChildren,
            ]);
            subExpressionIndex += Math.max(subChildren.length - 1, 0);
            continue;
          case "ReturnStatement":
          case "ThrowStatement":
            // Removing dead code after return or throw.
            node.body.splice(
              subExpressionIndex + 1,
              node.body.length - subExpressionIndex - 1
            );
            break;
        }
        subExpressionIndex++;
      }
      break;
    case "FunctionDeclaration":
    case "FunctionExpression":
      const block = node.body;
      if (
        block.body.length > 0 &&
        block.body[block.body.length - 1].type === "ReturnStatement" &&
        !block.body[block.body.length - 1].argument
      ) {
        // Function body ends with return without arg -- removing it.
        block.body.pop();
      }
      break;
  }
  return node;
}

function traverseTree(ctx, node) {
  // generic node processing
  for (const i in node) {
    const child = node[i];
    if (typeof child === "object" && child !== null && child.type) {
      const result = traverseTree(ctx, child);
      if (result !== child) {
        node[i] = result;
      }
    } else if (Array.isArray(child)) {
      child.forEach(function (childItem, index) {
        if (
          typeof childItem === "object" &&
          childItem !== null &&
          childItem.type
        ) {
          const result = traverseTree(ctx, childItem);
          if (result !== childItem) {
            child[index] = result;
          }
        }
      });
    }
  }

  node = postprocessNode(ctx, node) || node;

  return node;
}

/**
 * @type {import("rollup").RollupOptions}
 */
export default {
  input: {
    pdf: "src/pdf.js",
    "pdf.worker": "src/pdf.worker.js",
    "web/pdf_viewer.component": "web/pdf_viewer.component.js",
  },
  external: ["canvas", ...builtinModules],
  plugins: [
    {
      name: "ciri",
      async resolveId(id, importer) {
        if (id === "pdfjs-lib") {
          return __dirname + "/src/pdf.js";
        }
        if (id === "pdfjs/pdf.worker.js") {
          return {
            id: __dirname + "/src/pdf.worker.js",
            external: true,
          };
        } else {
          if (id === "pdfjs-fitCurve") {
            return {
              id: __dirname + "/src/display/editor/fit_curve.js",
              moduleSideEffects: false,
            };
          } else if (/pdfjs(\/)?.+/.test(id)) {
            return __dirname + ("/src/" + id.replace(/pdfjs(\/)?/, "") + ".js");
          }
        }
      },
      async transform(code, id) {
        if (!id.startsWith(__dirname + "/src") && !id.startsWith(__dirname + "/web")) return;

        const ctx = {
          defines: {
            SKIP_BABEL: true,
            TESTING: false,
            // The main build targets:
            GENERIC: true,
            MOZCENTRAL: false,
            GECKOVIEW: false,
            CHROME: false,
            MINIFIED: false,
            COMPONENTS: false,
            LIB: false,
            IMAGE_DECODERS: false,
            BUNDLE_VERSION: "ciri-custom",
            BUNDLE_BUILD: "ciri-custom",
          },
          skipComments: true,
        };

        let ast = this.parse(code);
        ast = traverseTree(ctx, ast);

        const { print } = await import("code-red");
        code = print(ast).code;

        return code;
      },
    },
    nodeResolve({
      preferBuiltins: true,
    }),
    commonjs({
      transformMixedEsModules: true,
      strictRequires: true,
      ignoreDynamicRequires: true,
      ignore: ["canvas"],
    }),
  ],
};
