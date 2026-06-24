// 対話コマンドループとヘルプ表示

import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline";

import { BASE_URL, JSON_FILE } from "./config.js";
import { parseCommandLine, trimPromptSize } from "./utils.js";
import { callTool } from "./mcp.js";
import { waitForDomReady } from "./browser-actions.js";
import { loadDomCache, captureAndSaveDom } from "./dom-cache.js";
import {
  loadScenarioFile,
  resolveScenarioKey,
  executeScenario,
  generateScenarioTemplateFromCache
} from "./scenario.js";
import {
  askClaude,
  askClaudeWithDomCache,
  improveGeneratedScenarioWithClaude
} from "./claude.js";
import { runAgentMode } from "./agent.js";
import {
  resetSessionSteps,
  getSessionSteps,
  deleteSessionStep
} from "./session.js";

export function printHelp() {
  console.log(`
Commands:

  auto "<goal>" [url]
    - AIエージェントモード。DOMを見てClaudeで操作シナリオを生成し、そのまま実行する。

  run <scenario> [url]
    - シナリオ実行

  cache list
    - DOMキャッシュ一覧

  cache show <path>
    - DOMキャッシュ内容表示

  cache frames <path>
    - DOMキャッシュ内の iframe 一覧を表示

  gen <path> <name> [--run]
    - DOMからシナリオ生成

  ask "<question>"
    - Claudeに質問

  ask-dom <path> "<question>"
    - DOMを元にClaudeへ質問

  improve <file>
    - シナリオ改善

  scenarios
    - シナリオ一覧

  history
    - 実行済みステップ一覧

  history clear
    - セッション履歴をクリア

  history delete <index>
    - indexで指定されたhistoryを削除

  save-scenario <name>
    - セッション履歴からシナリオ生成

  merge-scenario <file>
    - opsidb.jsonへシナリオをマージ

  help
    - ヘルプ表示

  quit
    - 終了
`);
}

export async function interactiveLoop(client) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "mcp> "
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    const args = parseCommandLine(input);

    try {
      if (args[0] === "quit" || args[0] === "exit") {
        console.log("bye.");
        break;
      }

      if (args[0] === "help") {
        printHelp();
      }

      else if (args[0] === "scenarios") {
        const scenarioFile = await loadScenarioFile(JSON_FILE);
        console.log("Available scenarios:");
        console.log(Object.keys(scenarioFile.web_scenario ?? {}));
      }

      // =========================
      // run
      // =========================
      else if (args[0] === "run") {
        const [, scenarioKey, url] = input.split(" ");

        const baseUrl = url ?? BASE_URL;

        console.log(`Running: ${scenarioKey} @ ${baseUrl}`);

        await callTool(client, "browser_navigate", { url: baseUrl });
        await waitForDomReady(client);

        await captureAndSaveDom(client, "interactive-run");

        const scenarioFile = await loadScenarioFile(JSON_FILE);
        const resolved = resolveScenarioKey(scenarioKey, scenarioFile.web_scenario);

        if (!resolved) {
          console.log("Scenario not found");
        } else {
          await executeScenario(client, resolved, scenarioFile.web_scenario[resolved]);
        }
      }

      // =========================
      // cache list
      // =========================
      else if (args[0] === "cache" &&  args[1] === "list") {
        const cache = await loadDomCache();
        console.log(Object.keys(cache));
      }

      // =========================
      // cache show
      // =========================
      else if (args[0] === "cache" && args[1] === "show") {
        const key = args[2];
        const cache = await loadDomCache();

        if (!cache[key]) {
          console.log("Not found:", key);
        } else {
          console.log(JSON.stringify(cache[key], null, 2));
        }
      }

      // =========================
      // cache frames
      // =========================
      else if (args[0] === "cache" && args[1] === "frames") {
        const key = args[2] ?? "";
        const cache = await loadDomCache();

        if (!cache[key]) {
          console.log("Not found:", key);
        } else {
          const frames = cache[key].iframes ?? [];

          if (frames.length === 0) {
            console.log("No iframes.");
          } else {
            for (const [index, frame] of frames.entries()) {
              console.log(`\n[${index}]`);
              console.log(`  frame: ${frame.frame}`);
              console.log(`  src: ${frame.src}`);
              console.log(`  title: ${frame.title}`);
              console.log(`  name: ${frame.name}`);
              console.log(`  accessible: ${frame.accessible}`);
              console.log(`  interactiveElements: ${(frame.interactiveElements ?? []).length}`);
            }
          }
        }
      }

      // =========================
      // gen
      // =========================
      else if (args[0] === "gen") {
        const path = args[1];
        const name = args[2] ?? "generated";
        const autoRun = args.includes("--run");

        const template = await generateScenarioTemplateFromCache(path, name);

        console.log(`[GEN] scenario generated: ${name}`);

        if (autoRun) {
          console.log("[GEN] running generated scenario...");

          await executeScenario(
            client,
            name,
            template.web_scenario[name]
          );
        }
      }

      // =========================
      // ask claude
      // =========================
      else if (args[0] === "ask") {
        const question = input.replace(/^ask\s+/, "");

        const safeQuestion = trimPromptSize(question);
        const result = await askClaude(safeQuestion);
        console.log(result.answer);
      }

      // =========================
      // ask-dom
      // =========================
      else if (args[0] === "ask-dom ") {
        const parts = input.match(/^ask-dom\s+(\S+)\s+(.+)/);

        if (!parts) {
          console.log("Usage: ask-dom <path> <question>");
        } else {
          const [, path, question] = parts;

          const result = await askClaudeWithDomCache(path, question);
          console.log(result.answer);
        }
      }

      // =========================
      // improve
      // =========================
      else if (args[0] === "improve ") {
        const file = input.replace("improve ", "").trim();

        await improveGeneratedScenarioWithClaude(file);
      }

      // =========================
      // auto
      // =========================
      else if (args[0] === "auto") {
        const goal = args[1] ?? "";
        const url = args[2] ?? "";

        if (!goal) {
          console.log('Usage: auto "<goal>" [url]');
        } else {
          await runAgentMode(client, goal, url);
        }
      }

      // =========================
      // history
      // =========================
      else if (args[0] === "history") {
        if (args[1] === "clear") {
          resetSessionSteps();
          console.log("History cleared.");
        }
        else if (args[1] === "delete") {
          deleteSessionStep(Number(args[2]) - 1);
        }
        else {
          const sessionExecutedSteps = getSessionSteps();
          if (sessionExecutedSteps.length === 0) {
            console.log("No executed steps.");
          } else {
            sessionExecutedSteps.forEach((s, i) => {
              console.log(`[${i+1}] ${s.action} ${s.selector || ""} frame=${s.frame || ""}`);
            });
          }
        }
      }

      // =========================
      // save-scenario
      // =========================
      else if (args[0] === "save-scenario") {
        const name = args[1] ?? `scenario-${Date.now()}`;

        const sessionExecutedSteps = getSessionSteps();

        if (sessionExecutedSteps.length === 0) {
          console.log("No steps to save.");
          return;
        }

        const scenario = {
          web_scenario: {
            [name]: sessionExecutedSteps.map(step => ({
              selector: step.selector || "",
              frame: step.frame || "",
              action: step.action,
              value: step.value || "",
              is_jump: step.is_jump === true,
              purpose: step.purpose || "",
              expect: step.expect || "",
              expect_check: step.expect_check || "",
              question: "",
              answer: "",
              result: "",
              screenshot_path: ""
            }))
          }
        };

        const fileName = `generated-${name}.json`;

        await writeFile(fileName, JSON.stringify(scenario, null, 2), "utf-8");

        console.log(`[SCENARIO] saved: ${fileName}`);
      }

      // =========================
      // merge-scenario
      // =========================
      else if (args[0] === "merge-scenario") {
        const file = args[1];

        if (!file) {
          console.log("Usage: merge-scenario <file>");
          return;
        }

        const newScenario = JSON.parse(await readFile(file, "utf-8"));
        const existing = await loadScenarioFile(JSON_FILE);

        existing.web_scenario = {
          ...(existing.web_scenario ?? {}),
          ...(newScenario.web_scenario ?? {})
        };

        await writeFile(JSON_FILE, JSON.stringify(existing, null, 2), "utf-8");

        console.log("[SCENARIO] merged into opsidb.json");
      }

      else {
        console.log("Unknown command. type 'help'");
      }

    } catch (err) {
      console.error("Error:", err.message);
    }

    rl.prompt();
  }

  rl.close();
}
