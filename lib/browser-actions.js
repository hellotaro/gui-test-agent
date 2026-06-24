// ブラウザ操作・DOM待機・アクション関数生成

import { BASE_URL } from "./config.js";
import { escapeForTemplateLiteral } from "./utils.js";
import { callTool, extractEvaluateResult, parseEvaluateResult } from "./mcp.js";

export async function waitForDomReady(client, timeoutMs = 10000) {
  const start = Date.now();

  while (true) {
    const result = await callTool(client, "browser_evaluate", {
      function: `() => document.readyState`
    });

    const raw = extractEvaluateResult(result);

    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      state = raw.replace(/"/g, "");
    }

    console.log("[waitForDomReady] parsed =", state);

    if (state === "complete") {
      return;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting readyState. last=${state}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }
}

export async function waitForDomStable(client, timeoutMs = 10000) {
  const start = Date.now();

  while (true) {
    const result = await callTool(client, "browser_evaluate", {
      function: `() => ({
        ready: document.readyState,
        count: document.querySelectorAll('*').length,
        body: !!document.body
      })`
    });

    const data = parseEvaluateResult(result);

    if (
      data?.ready === "complete" &&
      data?.body &&
      data?.count > 50
    ) {
      return;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout waiting DOM stable");
    }

    await new Promise(r => setTimeout(r, 300));
  }
}

export function resolveNavigateUrl(baseUrl, value) {
  const v = String(value || "").trim();

  // ✅ フルURL
  if (v.startsWith("http://") || v.startsWith("https://")) {
    return v;
  }

  // ✅ プロトコル無し（//git.xxx）
  if (v.startsWith("//")) {
    const protocol = new URL(baseUrl).protocol;
    return protocol + v;
  }

  // ✅ "https//xxx" の壊れたパターン補正
  if (v.startsWith("https//") || v.startsWith("http//")) {
    return v.replace(/^https?\/\//, "https://");
  }

  // ✅ パス
  try {
    return new URL(v, baseUrl).href;
  } catch {
    return baseUrl;
  }
}

export async function getCurrentUrl(client) {
  const result = await callTool(client, "browser_evaluate", {
    function: `() => location.href`
  });

  const value = parseEvaluateResult(result);

  if (typeof value === "string") {
    return value;
  }

  return String(value ?? "");
}

export async function findElementInIframes(client, selector) {
  const result = await callTool(client, "browser_evaluate", {
    function: `
() => {
  const selector = ${JSON.stringify(selector)};
  const frames = Array.from(document.querySelectorAll("iframe"));

  for (const iframe of frames) {
    const src = iframe.getAttribute("src") || "";

    // same-origin
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.querySelector(selector)) {
        return {
          found: true,
          type: "same-origin",
          frameSelector: iframe.id
            ? "#" + iframe.id
            : iframe.getAttribute("name")
              ? "iframe[name='" + iframe.getAttribute("name") + "']"
              : "iframe",
          src
        };
      }
    } catch {}

    // cross-origin（中は見えないので候補として返す）
    if (src) {
      if (selector.includes("git") || src.includes("git")) {
        return {
          found: true,
          type: "cross-origin",
          frameSelector: iframe.id
            ? "#" + iframe.id
            : iframe.getAttribute("name")
              ? "iframe[name='" + iframe.getAttribute("name") + "']"
              : "iframe",
          src
        };
      }
    }
  }

  return { found: false };
}
`
  });

  return parseEvaluateResult(result);
}

export function extractPathFromFrameSrc(src) {
  try {
    const u = new URL(src, BASE_URL);

    // host無視 → pathだけ
    return u.pathname + (u.search || "");
  } catch {
    return "";
  }
}

export function buildActionFunction(step) {
  const selector = escapeForTemplateLiteral(step.selector);
  const value = escapeForTemplateLiteral(step.value ?? "");
  const frameSelector = escapeForTemplateLiteral(step.frame ?? "");

  return `
() => {
  const frameSelector = \`${frameSelector}\`;
  let rootDoc = document;

  if (frameSelector) {
    const iframe = document.querySelector(frameSelector);

    if (!iframe) {
      throw new Error(\`frame not found: \${frameSelector}\`);
    }

    if (!iframe.contentDocument) {
      throw new Error(\`frame contentDocument is not accessible: \${frameSelector}\`);
    }

    rootDoc = iframe.contentDocument;
  }

  const action = "${step.action}";

  if (action === "wait") {
    return {
      ok: true,
      action,
      waitMs: Number(\`${value}\`) || 0
    };
  }

  const el = rootDoc.querySelector(\`${selector}\`);

  if (!el) {
    // ✅ iframe探索
    const frames = Array.from(document.querySelectorAll("iframe"));

    for (const f of frames) {
      try {
        const doc = f.contentDocument;
        if (doc && doc.querySelector(selector)) {
          throw new Error(
            "Element exists in iframe but frame not specified: ${selector}"
          );
        }
      } catch {
        // cross-origin
        const src = f.getAttribute("src");

        if (src && selector.includes("#")) {
          throw new Error(
            "Element may be inside cross-origin iframe: \${src}"
          );
        }
      }
    }

    throw new Error("element not found: ${selector}");
  }

  if (action === "type") {
    el.focus();

    if ("value" in el) {
      el.value = \`${value}\`;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.textContent = \`${value}\`;
    }

    return {
      ok: true,
      action,
      frame: frameSelector,
      selector: \`${selector}\`,
      value: \`${value}\`
    };
  }

  if (action === "select") {
    if (!("value" in el)) {
      throw new Error(\`element does not support value: \${selector}\`);
    }

    el.value = \`${value}\`;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      ok: true,
      action,
      frame: frameSelector,
      selector: \`${selector}\`,
      value: \`${value}\`
    };
  }

  if (action === "click") {
    el.click();

    return {
      ok: true,
      action,
      frame: frameSelector,
      selector: \`${selector}\`
    };
  }

  throw new Error(\`unsupported action: \${action}\`);
}
`.trim();
}
