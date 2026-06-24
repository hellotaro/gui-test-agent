// 汎用ヘルパ（文字列・URL・JSON・CLI入力）

import readline from "node:readline";

export function escapeForTemplateLiteral(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

export function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

export function trimPromptSize(text, maxLength = 35000) {
  if (text.length <= maxLength) return text;

  return text.slice(0, maxLength) + "\n...[truncated]";
}

export function createTimestampForFileName() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
}

export function stripMarkdownCodeFence(text) {
  const trimmed = String(text ?? "").trim();

  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  return trimmed;
}

export function extractFirstJsonObject(text) {
  const src = stripMarkdownCodeFence(text);

  try {
    return JSON.parse(src);
  } catch {
    // continue
  }

  const firstBrace = src.indexOf("{");
  const lastBrace = src.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = src.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }

  throw new Error("No valid JSON object found in Claude response.");
}

export function parseCommandLine(input) {
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

export function askUser(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
