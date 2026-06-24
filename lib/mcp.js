// MCP ツール呼び出しと結果テキスト/JSON の抽出

export async function callTool(client, name, args) {
  return await client.callTool({
    name,
    arguments: args
  });
}

export async function listAvailableTools(client) {
  const toolsResult = await client.listTools();

  console.log("=== Tools ===");
  for (const tool of toolsResult.tools ?? []) {
    console.log(`- ${tool.name}: ${tool.description ?? ""}`);
  }

  return new Set((toolsResult.tools ?? []).map((t) => t.name));
}

export function extractToolText(result) {
  if (!result) return "";

  if (typeof result === "string") return result;

  if (Array.isArray(result.content)) {
    return result.content
      .map((c) => {
        if (typeof c?.text === "string") return c.text;
        return JSON.stringify(c);
      })
      .join("\n");
  }

  if (typeof result.text === "string") return result.text;

  if (result.structuredContent != null) {
    return JSON.stringify(result.structuredContent);
  }

  return JSON.stringify(result);
}

export function extractJsonFromMcp(result) {
  let text = "";

  if (Array.isArray(result.content)) {
    text = result.content.map(c => c?.text ?? "").join("\n");
  } else if (typeof result.text === "string") {
    text = result.text;
  } else {
    text = JSON.stringify(result);
  }

  // ✅ JSON部分を抽出
  const match = text.match(/### Result\s*([\s\S]*?)\s*###/);

  if (match && match[1]) {
    return match[1].trim();
  }

  return text.trim();
}

export function extractEvaluateResult(result) {
  if (!result) return "";

  let text = "";

  if (Array.isArray(result.content)) {
    text = result.content.map(c => c?.text ?? "").join("\n");
  } else if (typeof result.text === "string") {
    text = result.text;
  } else {
    text = JSON.stringify(result);
  }

  // ✅ "### Result" ブロックだけ抽出
  const match = text.match(/### Result\s*([\s\S]*?)\s*###/);

  if (match && match[1]) {
    return match[1].trim();
  }

  // fallback
  return text.trim();
}

export function parseEvaluateResult(result) {
  const raw = extractJsonFromMcp(result);

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("JSON parse failed:", raw);
    return null;
  }
}
