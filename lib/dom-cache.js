// DOM スナップショットのキャプチャとキャッシュ入出力

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import {
  DOM_CACHE_FILE,
  DOM_CACHE_SAVE_HTML,
  DOM_MAX_DEPTH,
  DOM_MAX_CHILDREN_PER_NODE,
  DOM_REMOVE_SELECTORS,
  DOM_REMOVE_ATTRIBUTES
} from "./config.js";
import { callTool } from "./mcp.js";
import { parseEvaluateResult } from "./mcp.js";
import { waitForDomReady } from "./browser-actions.js";

export function extractServiceKeyFromUrl(url) {
  try {
    const u = new URL(url);

    const basehost = (new URL(url)).hostname;
    if (u.hostname === basehost) {
      return "main";
    }

    const hostParts = u.hostname.split(".");

    // git.qa0290qa2...
    if (hostParts.length >= 3) {
      return hostParts[0]; // ← git,resolver,docsなど
    }

    return "main";
  } catch {
    return "main";
  }
}

export function normalizePathKeyFromUrl(url) {
  const u = new URL(url);

  const service = extractServiceKeyFromUrl(url);
  const path = u.pathname || "/";

  return `${service}:${path}`;
}

export function normalizePathKeyFromInput(input) {
  if (!input) return "main:/";

  // URLの場合
  if (input.startsWith("http")) {
    return normalizePathKeyFromUrl(input);
  }

  // "git:/sys_git" の形式
  if (input.includes(":")) {
    return input;
  }

  // pathだけ指定 → main扱い
  if (!input.startsWith("/")) {
    input = "/" + input;
  }

  return `main:${input}`;
}

export async function loadDomCache() {
  if (!existsSync(DOM_CACHE_FILE)) {
    return {};
  }

  const raw = await readFile(DOM_CACHE_FILE, "utf-8");
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

export async function saveDomCache(cache) {
  await writeFile(DOM_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

export async function getCachedDomByUrl(url) {
  const cache = await loadDomCache();
  const key = normalizePathKeyFromUrl(url);
  return cache[key] ?? null;
}

export function isIframeAccessible(iframe) {
  try {
    return !!iframe.contentDocument;
  } catch {
    return false;
  }
}

export function buildDomCaptureFunction() {
  return `
() => {
  const REMOVE_SELECTORS = ${JSON.stringify(DOM_REMOVE_SELECTORS.filter(s => !s.startsWith("iframe")))};
  const REMOVE_ATTRIBUTES = ${JSON.stringify(DOM_REMOVE_ATTRIBUTES)};
  const MAX_DEPTH = ${DOM_MAX_DEPTH};
  const MAX_CHILDREN_PER_NODE = ${DOM_MAX_CHILDREN_PER_NODE};
  const SAVE_HTML = ${DOM_CACHE_SAVE_HTML};

  function shortText(value, maxLength = 160) {
    return String(value ?? "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function quoteAttr(value) {
    return String(value ?? "").replace(/'/g, "\\\\'");
  }

  function buildCssSelector(el) {
    if (!el || !el.tagName) {
      return "";
    }

    const tag = el.tagName.toLowerCase();

    if (el.id) {
      return "#" + CSS.escape(el.id);
    }

    const dataTestId = el.getAttribute("data-testid");
    if (dataTestId) {
      return tag + "[data-testid='" + quoteAttr(dataTestId) + "']";
    }

    const name = el.getAttribute("name");
    if (name) {
      return tag + "[name='" + quoteAttr(name) + "']";
    }

    const title = el.getAttribute("title");
    if (title) {
      return tag + "[title='" + quoteAttr(title) + "']";
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) {
      return tag + "[aria-label='" + quoteAttr(ariaLabel) + "']";
    }

    const parent = el.parentElement;
    if (!parent) {
      return tag;
    }

    const sameTagSiblings = Array.from(parent.children)
      .filter((child) => child.tagName === el.tagName);

    if (sameTagSiblings.length === 1) {
      const parentSelector = buildCssSelector(parent);
      return parentSelector ? parentSelector + " > " + tag : tag;
    }

    const index = sameTagSiblings.indexOf(el) + 1;
    const parentSelector = buildCssSelector(parent);

    return parentSelector
      ? parentSelector + " > " + tag + ":nth-of-type(" + index + ")"
      : tag + ":nth-of-type(" + index + ")";
  }

  function cleanupDocumentClone(root) {
    for (const selector of REMOVE_SELECTORS) {
      for (const el of Array.from(root.querySelectorAll(selector))) {
        el.remove();
      }
    }

    for (const el of Array.from(root.querySelectorAll("*"))) {
      for (const attr of REMOVE_ATTRIBUTES) {
        el.removeAttribute(attr);
      }

      if (el.tagName && el.tagName.toLowerCase() === "input") {
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "password") {
          el.setAttribute("value", "");
        }
      }
    }
  }

  function pickAttributes(el) {
    const attrs = {};
    const names = [
      "id",
      "class",
      "name",
      "type",
      "role",
      "aria-label",
      "aria-labelledby",
      "href",
      "src",
      "value",
      "placeholder",
      "title",
      "data-testid"
    ];

    for (const name of names) {
      if (!el.hasAttribute || !el.hasAttribute(name)) {
        continue;
      }

      let value = el.getAttribute(name);

      if (name === "value") {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();

        if (tag === "input" && type === "password") {
          value = "";
        }
      }

      if (value !== null && value !== "") {
        attrs[name] = shortText(value, 200);
      }
    }

    return attrs;
  }

  function serializeNode(node, depth = 0) {
    if (!node) {
      return null;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = shortText(node.textContent);
      if (!text) {
        return null;
      }

      return {
        type: "text",
        text
      };
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const tag = node.tagName.toLowerCase();

    const item = {
      type: "element",
      tag,
      attributes: pickAttributes(node)
    };

    const ownText = shortText(node.innerText || node.textContent);
    if (ownText) {
      item.text = ownText;
    }

    if (depth >= MAX_DEPTH) {
      return item;
    }

    const children = [];
    let count = 0;

    for (const child of Array.from(node.childNodes)) {
      if (count >= MAX_CHILDREN_PER_NODE) {
        break;
      }

      const serialized = serializeNode(child, depth + 1);
      if (serialized) {
        children.push(serialized);
        count++;
      }
    }

    if (children.length > 0) {
      item.children = children;
    }

    return item;
  }

  function getElementLabel(doc, el) {
    const id = el.id;
    if (id) {
      const label = doc.querySelector("label[for='" + CSS.escape(id) + "']");
      if (label) {
        return shortText(label.innerText || label.textContent);
      }
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) {
      return shortText(ariaLabel);
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) {
      return shortText(placeholder);
    }

    const title = el.getAttribute("title");
    if (title) {
      return shortText(title);
    }

    return shortText(el.innerText || el.value || el.textContent);
  }

  function collectInteractiveElements(doc, frameSelector = "") {
    const targets = Array.from(doc.querySelectorAll([
      "input",
      "textarea",
      "select",
      "button",
      "a[href]",
      "[role='button']",
      "[onclick]",
      "[contenteditable='true']"
    ].join(",")));

    return targets.map((el, index) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const selector = buildCssSelector(el);

      return {
        index,
        frame: frameSelector,
        tag,
        type,
        selector,
        label: getElementLabel(doc, el),
        text: shortText(el.innerText || el.textContent),
        name: el.getAttribute("name") || "",
        id: el.getAttribute("id") || "",
        href: el.getAttribute("href") || "",
        role: el.getAttribute("role") || "",
        placeholder: el.getAttribute("placeholder") || "",
        disabled: el.disabled === true,
        readonly: el.readOnly === true
      };
    }).filter((item) => item.selector);
  }

  function captureDocument(doc, frameSelector = "") {
    const clonedRoot = doc.documentElement.cloneNode(true);
    cleanupDocumentClone(clonedRoot);

    return {
      title: doc.title || "",
      domTree: serializeNode(clonedRoot),
      interactiveElements: collectInteractiveElements(doc, frameSelector),
      outerHTML: SAVE_HTML ? clonedRoot.outerHTML : undefined
    };
  }

  const mainCapture = captureDocument(document, "");

  const iframes = [];
  const allInteractiveElements = [
    ...mainCapture.interactiveElements
  ];

  for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
    const frameSelector = buildCssSelector(iframe);

    const frameInfo = {
      frame: frameSelector,
      selector: frameSelector,
      id: iframe.id || "",
      name: iframe.getAttribute("name") || "",
      title: iframe.getAttribute("title") || "",
      src: iframe.getAttribute("src") || "",
      accessible: false,
      crossOrigin: false,
      url: "",
      domTree: null,
      interactiveElements: []
    };

    try {
      const frameDoc = iframe.contentDocument;

      if (frameDoc && frameDoc.documentElement) {
        const captured = captureDocument(frameDoc, frameSelector);

        frameInfo.accessible = true;
        frameInfo.url = frameDoc.location?.href || "";
        frameInfo.title = captured.title;
        frameInfo.domTree = captured.domTree;
        frameInfo.interactiveElements = captured.interactiveElements;

        allInteractiveElements.push(...captured.interactiveElements);
      }
    } catch (err) {
      frameInfo.accessible = false;
      frameInfo.crossOrigin = true;
      frameInfo.error = String(err?.message ?? err);
    }

    iframes.push(frameInfo);
  }

  return {
    url: location.href,
    pathKey: location.pathname,
    title: document.title,
    capturedAt: new Date().toISOString(),
    domTree: mainCapture.domTree,
    iframes,
    interactiveElements: allInteractiveElements,
    outerHTML: SAVE_HTML ? mainCapture.outerHTML : undefined
  };
}
`.trim();
}

export async function captureAndSaveDom(client, reason) {
  await waitForDomReady(client);

  let lastError = null;

  for (let i = 0; i < 3; i++) {
    try {
      const result = await callTool(client, "browser_evaluate", {
        function: buildDomCaptureFunction()
      });

      const snapshot = parseEvaluateResult(result);

      //console.log("[DOM RAW]", extractJsonFromMcp(result));

      if (!snapshot || typeof snapshot !== "object") {
        throw new Error("Snapshot is not object");
      }

      if (!snapshot.url) {
        throw new Error("Snapshot missing url");
      }

      const key = normalizePathKeyFromUrl(snapshot.url);
      const cache = await loadDomCache();

      cache[key] = {
        key,
        service: extractServiceKeyFromUrl(snapshot.url), // ←追加
        path: new URL(snapshot.url).pathname,
        url: snapshot.url,
        title: snapshot.title,
        capturedAt: snapshot.capturedAt,
        reason,
        domTree: snapshot.domTree,
        iframes: snapshot.iframes ?? [],
        interactiveElements: snapshot.interactiveElements ?? []
      };

      await saveDomCache(cache);

      console.log(`[DOM CACHE] saved: ${key}`);
      console.log(`[DOM CACHE] service: ${extractServiceKeyFromUrl(snapshot.url)}`);
      return cache[key];

    } catch (err) {
      lastError = err;
      console.warn(`[DOM CACHE] retry ${i + 1} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  throw new Error(`Failed to capture DOM snapshot after retries: ${lastError}`);
}
