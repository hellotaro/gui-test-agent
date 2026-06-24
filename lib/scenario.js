// シナリオの読み込み・実行・テンプレート生成

import { readFile, writeFile } from "node:fs/promises";

import {
  BASE_URL,
  JSON_FILE,
  SCENARIO_ALIASES,
  GENERATED_SCENARIO_FILE,
  MAX_SCENARIOS,
  MAX_STEPS_PER_SCENARIO
} from "./config.js";
import { callTool } from "./mcp.js";
import {
  waitForDomReady,
  waitForDomStable,
  resolveNavigateUrl,
  buildActionFunction,
  findElementInIframes,
  extractPathFromFrameSrc
} from "./browser-actions.js";
import { loadDomCache, normalizePathKeyFromInput } from "./dom-cache.js";
import { pushSessionStep } from "./session.js";

export async function loadScenarioFile(filePath) {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

export function resolveScenarioKey(inputKey, scenarioMap) {
  if (scenarioMap[inputKey]) return inputKey;

  const aliasKey = SCENARIO_ALIASES[inputKey];
  if (aliasKey && scenarioMap[aliasKey]) return aliasKey;

  return null;
}

export function buildExpectFunction(step) {
  if (!step.expect_check || !String(step.expect_check).trim()) {
    return null;
  }

  return `
() => {
  ${step.expect_check}
}
`.trim();
}

async function executeStepInternal(client, step, index) {
  console.log(`\n[STEP ${index + 1}] action=${step.action}, selector=${step.selector}`);

  // WAIT
  if (step.action === "wait") {
    const waitMs = Number(step.value || 1000);
    console.log(`[WAIT] ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    if (step.action === "wait") {
      pushSessionStep({
        action: "wait",
        value: step.value
      });
    }

    return { step };
  }

  // NAVIGATE
  if (step.action === "navigate") {
    const url = resolveNavigateUrl(BASE_URL, step.value);

    console.log("[NAVIGATE]", url);

    await callTool(client, "browser_navigate", { url });

    await waitForDomReady(client);
    await waitForDomStable(client);

    pushSessionStep({
      action: "navigate",
      value: step.value,
      is_jump: true
    });

    return { step };
  }

  // 通常操作
  const actionFn = buildActionFunction(step);

  const result = await callTool(client, "browser_evaluate", {
    function: actionFn
  });

  console.log("[ACTION RESULT]");
  console.log(JSON.stringify(result, null, 2));

  pushSessionStep({
    selector: step.selector,
    frame: step.frame,
    action: step.action,
    value: step.value,
    is_jump: step.is_jump,
    purpose: step.purpose,
    expect: step.expect,
    expect_check: step.expect_check
  });

  return { step };
}

export async function executeStep(client, step, index) {
  try {
    return await executeStepInternal(client, step, index);

  } catch (err) {
    const msg = String(err.message || err);

    // ✅ selector失敗時のリカバリ
    if (msg.includes("element not found")) {
      console.warn("[RECOVERY] trying iframe navigation");

      const iframeInfo = await findElementInIframes(client, step.selector);

      if (iframeInfo?.found) {

        // ✅ same-origin
        if (iframeInfo.type === "same-origin") {
          return await executeStepInternal(client, {
            ...step,
            frame: iframeInfo.frameSelector
          }, index);
        }

        // ✅ cross-origin → navigate
        if (iframeInfo.type === "cross-origin") {
          const path = extractPathFromFrameSrc(iframeInfo.src);
          const url = resolveNavigateUrl(BASE_URL, path);

          console.log("[RECOVERY] navigate:", url);

          await callTool(client, "browser_navigate", { url });

          await waitForDomReady(client);
          await waitForDomStable(client);

          return await executeStepInternal(client, {
            ...step,
            frame: ""
          }, index);
        }
      }
    }

    throw err;
  }
}

export async function executeScenario(client, scenarioName, steps) {
  console.log(`\n=== Execute Scenario: ${scenarioName} ===`);
  console.log(`step count: ${steps.length}`);

  for (let i = 0; i < steps.length; i++) {
    await executeStep(client, steps[i], i);
  }

  console.log(`\n=== Scenario completed: ${scenarioName} ===`);
}

function guessScenarioAction(element) {
  const tag = element.tag;
  const type = String(element.type || "").toLowerCase();

  if (tag === "textarea") {
    return "type";
  }

  if (tag === "select") {
    return "select";
  }

  if (tag === "input") {
    if (["button", "submit", "reset", "checkbox", "radio"].includes(type)) {
      return "click";
    }

    if (["hidden", "file"].includes(type)) {
      return "skip";
    }

    return "type";
  }

  if (tag === "button") {
    return "click";
  }

  if (tag === "a") {
    return "click";
  }

  if (element.role === "button") {
    return "click";
  }

  return "click";
}

function guessSampleValue(element) {
  const tag = element.tag;
  const type = String(element.type || "").toLowerCase();
  const name = String(element.name || "").toLowerCase();
  const id = String(element.id || "").toLowerCase();
  const placeholder = String(element.placeholder || "").toLowerCase();
  const label = String(element.label || "").toLowerCase();

  const searchTarget = [name, id, placeholder, label].join(" ");

  if (tag === "select") {
    return "";
  }

  if (type === "password" || searchTarget.includes("password")) {
    return "";
  }

  if (type === "email" || searchTarget.includes("mail")) {
    return "user@example.com";
  }

  if (type === "number") {
    return "1";
  }

  if (searchTarget.includes("user") || searchTarget.includes("login") || searchTarget.includes("account")) {
    return "testuser";
  }

  if (searchTarget.includes("name")) {
    return "test_name";
  }

  if (searchTarget.includes("search") || searchTarget.includes("filter")) {
    return "test";
  }

  if (tag === "textarea") {
    return "test description";
  }

  return "test";
}

function buildExpectCheckForTemplate(element, action, value) {
  const selector = String(element.selector || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

  const frame = String(element.frame || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

  const docExpr = frame
    ? `document.querySelector('${frame}')?.contentDocument`
    : "document";

  if (action === "type") {
    const escapedValue = String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");

    return `const doc = ${docExpr}; return doc?.querySelector('${selector}')?.value === '${escapedValue}';`;
  }

  if (action === "select") {
    return `const doc = ${docExpr}; return doc?.querySelector('${selector}') !== null;`;
  }

  if (action === "click") {
    return `const doc = ${docExpr}; return doc?.querySelector('${selector}') !== null;`;
  }

  if (action === "navigate") {
    return {
      ok: true,
      action,
      url: value
    };
  }

  return "";
}

function buildPurposeForTemplate(element, action) {
  const label = element.label || element.text || element.name || element.id || element.selector;

  if (action === "type") {
    return `${label} に値を入力できることを確認する。`;
  }

  if (action === "select") {
    return `${label} を選択できることを確認する。`;
  }

  if (action === "click") {
    return `${label} をクリックできることを確認する。`;
  }

  return `${label} の操作を確認する。`;
}

function buildExpectForTemplate(element, action, value) {
  const label = element.label || element.text || element.name || element.id || element.selector;

  if (action === "type") {
    return `${label} に '${value}' が入力されること。`;
  }

  if (action === "select") {
    return `${label} の選択操作が実行できること。`;
  }

  if (action === "click") {
    return `${label} のクリック操作が実行できること。`;
  }

  return `${label} の操作が実行できること。`;
}

export function generateScenarioTemplateFromDomCacheItem(cacheItem, scenarioName) {
  const elements = cacheItem.interactiveElements ?? [];

  const steps = [];

  for (const element of elements) {
    if (element.disabled || element.readonly) {
      continue;
    }

    const action = guessScenarioAction(element);

    if (action === "skip") {
      continue;
    }

    const value = action === "type" || action === "select"
      ? guessSampleValue(element)
      : "";

    const step = {
      selector: element.selector,
      frame: element.frame ?? "",
      action,
      value,
      is_jump: action === "click" && element.tag === "a",
      purpose: buildPurposeForTemplate(element, action),
      expect: buildExpectForTemplate(element, action, value),
      expect_check: buildExpectCheckForTemplate(element, action, value),
      question: "",
      answer: "",
      result: "",
      screenshot_path: ""
    };

    steps.push(step);
  }

  return {
    web_scenario: {
      [scenarioName]: steps
    }
  };
}

export async function generateScenarioTemplateFromCache(pathOrUrl, scenarioName) {
  const cache = await loadDomCache();
  const key = normalizePathKeyFromInput(pathOrUrl);
  const cacheItem = cache[key];

  if (!cacheItem) {
    throw new Error(
      `DOM cache not found: ${key}\nAvailable keys: ${Object.keys(cache).join(", ")}`
    );
  }

  const template = generateScenarioTemplateFromDomCacheItem(cacheItem, scenarioName);

  await writeFile(
    GENERATED_SCENARIO_FILE,
    JSON.stringify(template, null, 2),
    "utf-8"
  );

  console.log(`[SCENARIO TEMPLATE] generated: ${GENERATED_SCENARIO_FILE}`);
  console.log(`[SCENARIO TEMPLATE] source cache key: ${key}`);
  console.log(`[SCENARIO TEMPLATE] scenario name: ${scenarioName}`);
  console.log(`[SCENARIO TEMPLATE] step count: ${template.web_scenario[scenarioName].length}`);

  return template;
}

export async function buildExistingScenarioSummary() {
  const scenarioFile = await loadScenarioFile(JSON_FILE);
  const scenarioMap = scenarioFile?.web_scenario ?? {};

  return Object.entries(scenarioMap)
    .slice(0, MAX_SCENARIOS)
    .map(([name, steps]) => ({
      name,
      stepCount: Array.isArray(steps) ? steps.length : 0,
      steps: Array.isArray(steps)
        ? steps.slice(0, MAX_STEPS_PER_SCENARIO).map((s) => ({
            action: s.action ?? "",
            selector: s.selector ?? "",
            frame: s.frame ?? "",
            purpose: s.purpose ?? "",
            is_jump: s.is_jump === true
          }))
        : []
    }));
}
