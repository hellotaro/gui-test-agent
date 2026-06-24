// AI エージェントモード（Claude でシナリオを計画し実行する）

import { writeFile } from "node:fs/promises";

import { ALLOWED_AGENT_ACTIONS } from "./config.js";
import {
  askUser,
  createTimestampForFileName,
  extractFirstJsonObject,
  trimPromptSize
} from "./utils.js";
import { callTool } from "./mcp.js";
import { waitForDomReady, getCurrentUrl } from "./browser-actions.js";
import { captureAndSaveDom } from "./dom-cache.js";
import { askClaude, compactDomCacheForClaude } from "./claude.js";
import { executeScenario, buildExistingScenarioSummary } from "./scenario.js";

async function confirmStepReplacement(oldStep, newStep) {
  console.log("\n[AI RETRY] Step failed. Retry with AI suggestion?\n");

  console.log("---- Original ----");
  console.log(JSON.stringify(oldStep, null, 2));

  console.log("---- Suggested ----");
  console.log(JSON.stringify(newStep, null, 2));

  const answer = await askUser("Use this step? (y/n): ");

  return answer.toLowerCase().startsWith("y");
}

async function regenerateStepWithAI(step, errorMessage, cacheItem) {
  const prompt = [
    "A Playwright step failed.",
    "",
    "Fix this step using DOM information.",
    "",
    "Return only JSON for a single step.",
    "",
    "Original step:",
    JSON.stringify(step, null, 2),
    "",
    "Error:",
    errorMessage,
    "",
    "DOM:",
    JSON.stringify(compactDomCacheForClaude(cacheItem), null, 2),
    "",
    "Rules:",
    "- Keep same intent",
    "- Fix selector or frame",
    "- Do not remove action",
    "- Output only JSON"
  ].join("\n");

  const result = await askClaude(prompt);

  return extractFirstJsonObject(result.answer);
}

async function saveAgentPlan(plan) {
  const fileName = `ai-suggestions/agent-plan-${createTimestampForFileName()}.json`;

  await writeFile(
    fileName,
    JSON.stringify(plan, null, 2),
    "utf-8"
  );

  console.log(`[AGENT] plan saved: ${fileName}`);
  return fileName;
}

function buildAgentPrompt({
  goal,
  currentUrl,
  cacheItem,
  existingScenarios
}) {
  const compactDom = compactDomCacheForClaude(cacheItem);

  return [
    "You are an autonomous browser operation scenario planner.",
    "",
    "Your task:",
    "- Create the next executable browser operation scenario steps.",
    "- Use only selectors that exist in the DOM cache when possible.",
    "- Prefer stable selectors: id, name, data-testid, aria-label.",
    "- Do not invent selectors unless no usable selector exists.",
    "- If you must suggest an invented selector, set confidence to low.",
    "- Return only valid JSON. Do not use Markdown fences.",
    "",
    "Required JSON schema:",
    JSON.stringify({
      scenarioName: "agent-generated-scenario",
      description: "short description",
      confidence: "high|medium|low",
      steps: [
        {
          selector: "CSS selector inside top document or iframe",
          frame: "iframe selector. Empty string only for top document.",
          action: "click|type|select|wait",
          value: "",
          is_jump: false,
          purpose: "",
          expect: "",
          expect_check: "",
          question: "",
          answer: "",
          result: "",
          screenshot_path: ""
        }
      ],
      continuationSuggestions: [
        {
          title: "",
          reason: "",
          suggestedCommand: ""
        }
      ]
    }, null, 2),
    "",
    "Rules:",
    "- action must be one of: click, type, select, wait.",
    "- For type/select, value must be set.",
    "- For click, value should be empty.",
    "- For wait, selector may be empty and value may contain milliseconds.",
    "- expect_check must be JavaScript code body beginning with return when possible.",
    "- Keep steps minimal and executable.",
    "- Do not include destructive operations unless the user explicitly requested them.",
    "",
    "suggestedCommand:",
    "- Must be a valid CLI command that can be directly executed.",
    "- Use one of the following formats:",
    "  auto \"<next goal>\"",
    "  run <scenarioName>",
    "- DO NOT output natural language like \"click on ...\".",
    "- DO NOT describe operations in English sentences.",
    "- The command must be executable as-is in the CLI.",
    "Examples:",
    "  auto \"adminユーザ詳細画面を開いてください\"",
    "  auto \"ユーザ設定を変更できるか確認してください\"",
    "  run user-management-edit",
    "",
    "User goal:",
    goal,
    "",
    "Current URL:",
    currentUrl,
    "",
    "Current DOM cache:",
    JSON.stringify(compactDom, null, 2),
    "",
    "Existing scenario summary:",
    JSON.stringify(existingScenarios, null, 2),
    "Frame handling rules:",
    "- If an element has non-empty frame in interactiveElements, the generated step MUST include the same frame value.",
    "- Do not move iframe elements to top-level document.",
    "- If selector belongs to iframe, set frame to the iframe selector.",
    "- If frame is empty, the selector is searched in the top document.",
    "- Prefer elements from interactiveElements exactly as provided.",
    "- Do not generate a step with frame empty when the target element in DOM cache has a non-empty frame.",
    "",
    "Examples:",
    JSON.stringify({
      selector: "#user_management_edit",
      frame: "iframe[name='main']",
      action: "click",
      value: "",
      is_jump: false,
      purpose: "Click edit button inside iframe",
      expect: "Edit screen is opened",
      expect_check: "const doc = document.querySelector(\"iframe[name='main']\")?.contentDocument; return doc?.querySelector('#user_management_edit') !== null;",
      question: "",
      answer: "",
      result: "",
      screenshot_path: ""
    }, null, 2),
    "Cross-origin iframe handling rules:",
    "- If iframe is not accessible (cross-origin):",
    "  DO NOT generate steps trying to access its content.",
    "- Instead:",
    "  Extract iframe src path",
    "  Then generate a step to navigate directly to that page.",
    "Example:",
    "iframe src: https://example.com/sys_system",
    "Then generate:",
    "{",
    "  \"action\": \"navigate\",",
    "  \"value\": \"/sys_system\"",
    "}",
    "Service routing rules:",
    "- Different subdomains represent different systems.",
    "- Examples:",
    "    git.xxx → Git system",
    "    docs.xxx → Documentation system",
    "    main → Main UI",
    "- Treat different services separately.",
    "- Do not assume same DOM across services.",
  ].join("\n");
}

async function askClaudeForAgentPlan({
  goal,
  currentUrl,
  cacheItem,
  existingScenarios
}) {
  const prompt = buildAgentPrompt({
    goal,
    currentUrl,
    cacheItem,
    existingScenarios
  });

  const safePrompt = trimPromptSize(prompt);
  const result = await askClaude(safePrompt);

  const plan = extractFirstJsonObject(result.answer);

  return {
    rawAnswer: result.answer,
    plan,
    messageId: result.id
  };
}

function normalizeAgentStep(step) {
  return {
    selector: String(step.selector ?? ""),
    frame: String(step.frame ?? ""),
    action: String(step.action ?? ""),
    value: step.value == null ? "" : String(step.value),
    is_jump: step.is_jump === true,
    purpose: String(step.purpose ?? ""),
    expect: String(step.expect ?? ""),
    expect_check: String(step.expect_check ?? ""),
    question: String(step.question ?? ""),
    answer: String(step.answer ?? ""),
    result: String(step.result ?? ""),
    screenshot_path: String(step.screenshot_path ?? "")
  };
}

function validateAgentPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("Agent plan is not an object.");
  }

  if (!Array.isArray(plan.steps)) {
    throw new Error("Agent plan does not contain steps array.");
  }

  const normalizedSteps = plan.steps.map((step, index) => {
    const normalized = normalizeAgentStep(step);

    if (!ALLOWED_AGENT_ACTIONS.has(normalized.action)) {
      throw new Error(
        `Invalid action at step ${index + 1}: ${normalized.action}`
      );
    }

    if (
      normalized.action !== "wait" && normalized.action !== "navigate" &&
      !normalized.selector
    ) {
      throw new Error(
        `Missing selector at step ${index + 1}. action=${normalized.action}`
      );
    }

    if (step.action === "navigate") {
      if (!step.value || step.value.length < 2) {
        throw new Error("Invalid navigate value");
      }
    }

    if (
      ["type", "select"].includes(normalized.action) &&
      normalized.value === ""
    ) {
      console.warn(
        `[AGENT] step ${index + 1}: action=${normalized.action} has empty value.`
      );
    }

    return normalized;
  });

  return {
    scenarioName: String(plan.scenarioName ?? "agent-generated-scenario"),
    description: String(plan.description ?? ""),
    confidence: String(plan.confidence ?? "medium"),
    steps: normalizedSteps,
    continuationSuggestions: Array.isArray(plan.continuationSuggestions)
      ? plan.continuationSuggestions
      : []
  };
}

function printContinuationSuggestions(suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    console.log("[AGENT] no continuation suggestions.");
    return;
  }

  console.log("\n[AGENT] continuation suggestions:");

  for (const [index, item] of suggestions.entries()) {
    console.log(`\n${index + 1}. ${item.title ?? ""}`);
    if (item.reason) {
      console.log(`   reason: ${item.reason}`);
    }
    if (item.suggestedCommand) {
      console.log(`   command: ${item.suggestedCommand}`);
    }
  }
}

async function proposeContinuationWithClaude({
  goal,
  beforeCacheItem,
  afterCacheItem,
  executedPlan
}) {
  const prompt = [
    "You are assisting with continued browser scenario construction.",
    "",
    "Based on the user's original goal, the executed scenario, and the resulting DOM cache, suggest useful next scenarios.",
    "",
    "Return only valid JSON with this schema:",
    JSON.stringify({
      status: "done|continue|failed",
      message: "",
      suggestions: [
        {
          title: "",
          reason: "",
          suggestedCommand: ""
        }
      ]
    }, null, 2),
    "",
    "Original goal:",
    goal,
    "",
    "Executed plan:",
    JSON.stringify(executedPlan, null, 2),
    "",
    "Before DOM cache:",
    JSON.stringify(compactDomCacheForClaude(beforeCacheItem), null, 2),
    "",
    "After DOM cache:",
    JSON.stringify(compactDomCacheForClaude(afterCacheItem), null, 2),
    "",
    "Rules for suggestedCommand:",
    "- suggestedCommand must be directly executable in this CLI.",
    "- Use one of:",
    "  auto \"<next goal>\"",
    "  run <scenarioName>",
    "- Do not output raw instructions such as click on '#id'.",
    "- If the next target is inside iframe, mention that explicitly in the natural language goal.",
    "- Example:",
    "  auto \"iframe内のユーザ編集ボタンをクリックして編集画面を開いてください\"",
  ].join("\n");

  const safePrompt = trimPromptSize(prompt);
  const result = await askClaude(safePrompt);

  let parsed;

  try {
    parsed = extractFirstJsonObject(result.answer);
  } catch {
    console.log("[AGENT] continuation raw answer:");
    console.log(result.answer);
    return;
  }

  console.log("\n[AGENT] status:", parsed.status ?? "");
  console.log("[AGENT] message:", parsed.message ?? "");

  printContinuationSuggestions(parsed.suggestions);
}

export async function runAgentMode(client, goal, url = "") {
  console.log("[AGENT] goal:", goal);

  if (url) {
    console.log("[AGENT] navigate:", url);
    await callTool(client, "browser_navigate", { url });
    await waitForDomReady(client);
  }

  const currentUrl = await getCurrentUrl(client);
  console.log("[AGENT] currentUrl:", currentUrl);

  const cacheItem = await captureAndSaveDom(client, "agent-before-plan");
  const existingScenarios = await buildExistingScenarioSummary();

  const { plan: rawPlan, rawAnswer, messageId } =
    await askClaudeForAgentPlan({
      goal,
      currentUrl,
      cacheItem,
      existingScenarios
    });

  let plan;

  try {
    plan = validateAgentPlan(rawPlan);
  } catch (err) {
    const failedFile = `agent-raw-${createTimestampForFileName()}.txt`;
    await writeFile(failedFile, rawAnswer, "utf-8");

    throw new Error(
      [
        `Agent plan validation failed: ${err.message}`,
        `Raw Claude response saved: ${failedFile}`
      ].join("\n")
    );
  }

  console.log("[AGENT] scenarioName:", plan.scenarioName);
  console.log("[AGENT] confidence:", plan.confidence);
  console.log("[AGENT] description:", plan.description);
  console.log("[AGENT] step count:", plan.steps.length);
  console.log("[AGENT] messageId:", messageId);

  await saveAgentPlan(plan);

  if (plan.steps.length === 0) {
    console.log("[AGENT] no executable steps returned.");
    printContinuationSuggestions(plan.continuationSuggestions);
    return;
  }

  await executeScenario(client, plan.scenarioName, plan.steps);

  const afterCacheItem = await captureAndSaveDom(client, "agent-after-run");

  await proposeContinuationWithClaude({
    goal,
    beforeCacheItem: cacheItem,
    afterCacheItem,
    executedPlan: plan
  });
}
