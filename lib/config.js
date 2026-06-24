// 実行時設定・定数の集約モジュール

export const BASE_URL = process.argv[3] ?? "http://192.168.1.100:8000/dist";

export const REQUESTED_KEY = process.argv[2] ?? "login";
export const JSON_FILE = "./scenario.json";
export const DOM_CACHE_FILE = "./dom-cache.json";
export const DOM_CACHE_INCLUDE_SEARCH = false;

export const SCENARIO_ALIASES = {
};

export const GENERATED_SCENARIO_FILE = "./generated-scenario.json";

export const DOM_CACHE_SAVE_HTML = false;
export const DOM_MAX_DEPTH = 8;
export const DOM_MAX_CHILDREN_PER_NODE = 80;

export const DOM_REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "meta",
  "svg",
  "canvas",
  "link[rel='stylesheet']",
  "link[as='style']"
];

export const DOM_REMOVE_ATTRIBUTES = [
  "style",
  "nonce",
  "integrity",
  "crossorigin",
  "srcset"
];

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-8";
export const CLAUDE_MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS ?? 16000);

export const CLAUDE_DEFAULT_OUTPUT_FILE = "./claude-answer.md";

export const MAX_INTERACTIVE_ELEMENTS = 80;
export const MAX_IFRAMES_FOR_CLAUDE = 10;

export const MAX_SCENARIOS = 5;
export const MAX_STEPS_PER_SCENARIO = 10;

export const ALLOWED_AGENT_ACTIONS = new Set([
  "click",
  "type",
  "select",
  "wait",
  "navigate",
]);
