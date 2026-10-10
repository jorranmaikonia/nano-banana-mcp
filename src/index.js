// Nano Banana MCP — servidor MCP remoto (Streamable HTTP, stateless) para Cloudflare Workers.
// Expõe a ferramenta generate_image, que chama a API do Gemini (modelos de imagem "Nano Banana").
//
// Variáveis (Cloudflare → Worker → Settings → Variables and Secrets):
//   GEMINI_API_KEY  (secret)  chave do Google AI Studio
//   ACCESS_TOKEN    (secret)  token longo e aleatório; vai no caminho da URL: /mcp/<ACCESS_TOKEN>
//   DEFAULT_MODEL   (opcional) padrão: gemini-2.5-flash-image
// Binding opcional:
//   IMAGES (KV namespace) — se existir, cada imagem também ganha um link /img/<id> válido por 30 dias.

const SERVER_INFO = { name: "nano-banana-mcp", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MODELS = [
  "gemini-2.5-flash-image",          // Nano Banana
  "gemini-3.1-flash-image-preview",  // Nano Banana 2
  "gemini-3-pro-image-preview",      // Nano Banana Pro
];
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const IMG_TTL_SECONDS = 60 * 60 * 24 * 30;

const TOOLS = [
  {
    name: "generate_image",
    title: "Gerar imagem com Nano Banana (Gemini)",
    description:
      "Gera ou edita uma imagem com os modelos de imagem do Gemini (Nano Banana). " +
      "Para editar, passe uma ou mais URLs públicas de imagem em reference_image_urls e descreva a alteração no prompt.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Descrição detalhada da imagem ou da edição desejada." },
        model: { type: "string", enum: MODELS, description: "Modelo. Padrão: gemini-2.5-flash-image." },
        aspect_ratio: { type: "string", enum: ASPECT_RATIOS, description: "Proporção da imagem. Padrão: 1:1." },
        reference_image_urls: {
          type: "array",
          items: { type: "string" },
          maxItems: 3,
          description: "URLs públicas de imagens de referência/para editar (opcional).",
        },
      },
      required: ["prompt"],
    },
  },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    // Link público das imagens salvas no KV
    if (url.pathname.startsWith("/img/") && request.method === "GET") {
      if (!env.IMAGES) return new Response("Not found", { status: 404 });
      const id = url.pathname.slice(5).replace(/\.\w+$/, "");
      const { value, metadata } = await env.IMAGES.getWithMetadata(id, { type: "arrayBuffer" });
      if (!value) return new Response("Not found", { status: 404 });
      return new Response(value, {
        headers: { "content-type": metadata?.mimeType || "image/png", "cache-control": "public, max-age=86400" },
      });
    }

    if (!url.pathname.startsWith("/mcp/")) return new Response("Nano Banana MCP ativo.", { status: 200 });

    if (!env.ACCESS_TOKEN || !env.GEMINI_API_KEY) {
      return new Response("Configure ACCESS_TOKEN e GEMINI_API_KEY no Worker.", { status: 500 });
    }
    if (!safeEqual(url.pathname.slice(5).replace(/\/$/, ""), env.ACCESS_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    const ctx = { env, origin: url.origin };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m, ctx)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: cors() });
    }
    const out = await handle(body, ctx);
    return out ? json(out) : new Response(null, { status: 202, headers: cors() });
  },
};

async function handle(msg, ctx) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg ? rpcError(msg.id, -32600, "Invalid Request") : null;
  }
  const isNotification = !("id" in msg);
  if (isNotification) return null;

  const { id, method, params = {} } = msg;
  try {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "Use generate_image para criar ou editar imagens com o Nano Banana (Gemini).",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        if (params.name !== "generate_image") return rpcError(id, -32602, `Ferramenta desconhecida: ${params.name}`);
        return rpcResult(id, await generateImage(params.arguments || {}, ctx));
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, -32603, String(err?.message || err));
  }
}

async function generateImage(args, { env, origin }) {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return toolError("Informe um prompt.");

  const model = MODELS.includes(args.model) ? args.model : env.DEFAULT_MODEL || MODELS[0];
  const aspectRatio = ASPECT_RATIOS.includes(args.aspect_ratio) ? args.aspect_ratio : "1:1";

  const parts = [{ text: prompt }];
  for (const ref of (args.reference_image_urls || []).slice(0, 3)) {
    const r = await fetch(ref);
    if (!r.ok) return toolError(`Não consegui baixar a imagem de referência (${r.status}): ${ref}`);
    const mimeType = (r.headers.get("content-type") || "image/png").split(";")[0];
    if (!mimeType.startsWith("image/")) return toolError(`A URL não é uma imagem: ${ref}`);
    parts.push({ inline_data: { mime_type: mimeType, data: toBase64(await r.arrayBuffer()) } });
  }

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio } },
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return toolError(`Erro da API do Gemini (${resp.status}): ${data?.error?.message || "sem detalhes"}`);

  const outParts = data?.candidates?.[0]?.content?.parts || [];
  const images = outParts.map((p) => p.inlineData || p.inline_data).filter(Boolean);
  const texts = outParts.filter((p) => p.text).map((p) => p.text);

  if (!images.length) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || "desconhecido";
    return toolError(`O modelo não retornou imagem (motivo: ${reason}). ${texts.join(" ")}`.trim());
  }

  const content = [];
  const links = [];
  for (const img of images) {
    const mimeType = img.mimeType || img.mime_type || "image/png";
    content.push({ type: "image", data: img.data, mimeType });
    if (env.IMAGES) {
      const id = crypto.randomUUID();
      await env.IMAGES.put(id, fromBase64(img.data), { expirationTtl: IMG_TTL_SECONDS, metadata: { mimeType } });
      links.push(`${origin}/img/${id}.${mimeType.split("/")[1] || "png"}`);
    }
  }

  const summary = [`Modelo: ${model} · Proporção: ${aspectRatio}`];
  if (links.length) summary.push(`Link (30 dias): ${links.join(" , ")}`);
  if (texts.length) summary.push(texts.join("\n"));
  content.push({ type: "text", text: summary.join("\n") });

  return { content };
}

// ---------- utilitários ----------
function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors() } });
}
function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
  };
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
