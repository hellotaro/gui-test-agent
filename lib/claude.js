// Claude API (Anthropic) 連携と DOM 由来プロンプトの組み立て

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";

import {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL,
  CLAUDE_MAX_TOKENS,
  CLAUDE_DEFAULT_OUTPUT_FILE,
  GENERATED_SCENARIO_FILE,
  MAX_INTERACTIVE_ELEMENTS,
  MAX_IFRAMES_FOR_CLAUDE
} from "./config.js";
import { trimPromptSize } from "./utils.js";
import { loadDomCache, normalizePathKeyFromInput } from "./dom-cache.js";

let client = null;

export function assertClaudeConfig() {
  if (!ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }
}

function getClient() {
  if (!client) {
    assertClaudeConfig();
    // APIキーは ANTHROPIC_API_KEY 環境変数から解決される
    client = new Anthropic(
      ANTHROPIC_API_KEY ? { apiKey: ANTHROPIC_API_KEY } : {}
    );
  }

  return client;
}

async function callClaude(prompt) {
  const anthropic = getClient();

  // 出力が長くなり得るためストリーミングを使い、完成メッセージを取得する
  const stream = anthropic.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    thinking: { type: "adaptive" },
    messages: [
      { role: "user", content: prompt }
    ]
  });

  return await stream.finalMessage();
}

export function extractClaudeAnswer(message) {
  if (!message) {
    return "";
  }

  if (typeof message === "string") {
    return message;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("");
  }

  if (typeof message.text === "string") {
    return message.text;
  }

  return JSON.stringify(message);
}

export async function askClaude(question) {
  const message = await callClaude(question);

  return {
    raw: message,
    answer: extractClaudeAnswer(message),
    id: message?.id ?? "",
    stopReason: message?.stop_reason ?? ""
  };
}

export function compactDomCacheForClaude(cacheItem) {
  if (!cacheItem) {
    return null;
  }

  const raw = Array.isArray(cacheItem.interactiveElements)
    ? cacheItem.interactiveElements
    : [];

  const picked = raw
    .filter((el) => !el.disabled && !el.readonly)
    .slice(0, MAX_INTERACTIVE_ELEMENTS);

  const iframes = Array.isArray(cacheItem.iframes)
    ? cacheItem.iframes.slice(0, MAX_IFRAMES_FOR_CLAUDE).map((frame) => ({
        frame: frame.frame,
        selector: frame.selector,
        id: frame.id,
        name: frame.name,
        title: frame.title,
        src: frame.src,
        accessible: frame.accessible,
        url: frame.url,
        interactiveElementCount: Array.isArray(frame.interactiveElements)
          ? frame.interactiveElements.length
          : 0
      }))
    : [];

  return {
    key: cacheItem.key,
    service: cacheItem.service,
    path: cacheItem.path,
    url: cacheItem.url,
    title: cacheItem.title,
    capturedAt: cacheItem.capturedAt,
    iframes,
    interactiveElements: picked.map((item) => ({
      frame: item.frame ?? "",
      tag: item.tag,
      type: item.type,
      selector: item.selector,
      label: item.label,
      text: item.text,
      name: item.name,
      id: item.id,
      href: item.href,
      role: item.role,
      placeholder: item.placeholder
    }))
  };
}

function buildClaudePromptForDomScenario(cacheItem, userQuestion) {
  const compact = compactDomCacheForClaude(cacheItem);

  return [
    "You are assisting with browser operation scenario design.",
    "Create or improve a Playwright operation scenario based on the cached DOM information.",
    "",
    "Requirements:",
    "- Use CSS selectors from interactiveElements when possible.",
    "- Output scenario steps in JSON format.",
    "- Each step should include selector, frame, action, value, is_jump, purpose, expect, expect_check, question, answer, result, screenshot_path.",
    "- Prefer stable selectors such as id, name, data-testid, aria-label.",
    "- Do not invent selectors that are not present in the DOM cache unless clearly marked as a suggestion.",
    "",
    "User request:",
    userQuestion,
    "",
    "DOM cache:",
    JSON.stringify(compact, null, 2)
  ].join("\n");
}

export async function askClaudeWithDomCache(pathOrUrl, question, outputFile = CLAUDE_DEFAULT_OUTPUT_FILE) {
  const cache = await loadDomCache();
  const key = normalizePathKeyFromInput(pathOrUrl);
  const cacheItem = cache[key];

  if (!cacheItem) {
    throw new Error(
      `DOM cache not found: ${key}\nAvailable keys: ${Object.keys(cache).join(", ")}`
    );
  }

  const prompt = buildClaudePromptForDomScenario(cacheItem, question);

  const safePrompt = trimPromptSize(prompt);
  const result = await askClaude(safePrompt);

  await writeFile(outputFile, result.answer, "utf-8");

  console.log(`[CLAUDE] answer saved: ${outputFile}`);
  console.log(`[CLAUDE] message_id: ${result.id}`);

  return result;
}

export async function askClaudeWithFile(inputFile, question, outputFile = CLAUDE_DEFAULT_OUTPUT_FILE) {
  if (!existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const content = await readFile(inputFile, "utf-8");

  const prompt = [
    "You are reviewing or generating a browser operation scenario.",
    "",
    "User request:",
    question,
    "",
    "File content:",
    content
  ].join("\n");

  const safePrompt = trimPromptSize(prompt);
  const result = await askClaude(safePrompt);

  await writeFile(outputFile, result.answer, "utf-8");

  console.log(`[CLAUDE] answer saved: ${outputFile}`);
  console.log(`[CLAUDE] message_id: ${result.id}`);

  return result;
}

export async function improveGeneratedScenarioWithClaude(
  inputFile = GENERATED_SCENARIO_FILE,
  outputFile = "./generated-scenario-improved.json"
) {
  const question = [
    "Improve this generated browser operation scenario.",
    "Return only valid JSON.",
    "Keep the same schema.",
    "Remove duplicate or low-confidence steps.",
    "Prefer stable selectors.",
    "Add useful purpose, expect, and expect_check fields.",
    "Do not include Markdown fences."
  ].join("\n");

  const result = await askClaudeWithFile(inputFile, question, outputFile);

  return result;
}
