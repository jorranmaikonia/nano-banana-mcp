# Nano Banana MCP

Conector MCP remoto que gera e edita imagens com os modelos de imagem do Gemini (Nano Banana) direto no Claude.
Roda grátis no Cloudflare Workers; o código fica neste repositório.

## Ferramenta

`generate_image`
- `prompt` (obrigatório)
- `model`: `gemini-2.5-flash-image` (Nano Banana, padrão) · `gemini-3.1-flash-image-preview` (Nano Banana 2) · `gemini-3-pro-image-preview` (Nano Banana Pro)
- `aspect_ratio`: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`… (padrão `1:1`)
- `reference_image_urls`: até 3 URLs públicas para editar/usar como referência

A imagem volta direto no chat. Com o KV `IMAGES` ligado, também vem um link válido por 30 dias.

## Instalação (uma vez)

1. **Chave do Gemini** — gere em https://aistudio.google.com/apikey.
   Geração de imagem pela API costuma exigir faturamento ativo no projeto do Google Cloud.
2. **Deploy no Cloudflare** — em https://dash.cloudflare.com → Workers & Pages → Create → Import a repository →
   escolha `jorranmaikonia/nano-banana-mcp` (deploy automático a cada push).
3. **Secrets** — no Worker → Settings → Variables and Secrets, adicione como *Secret*:
   - `GEMINI_API_KEY` = sua chave
   - `ACCESS_TOKEN` = um texto longo e aleatório (ex.: gere em https://www.uuidgenerator.net e junte dois)
4. **Conectar no Claude** — claude.ai → Configurações → Conectores → Adicionar conector personalizado:
   ```
   https://nano-banana-mcp.<seu-subdominio>.workers.dev/mcp/<ACCESS_TOKEN>
   ```
5. Em qualquer conversa, ative o conector e peça: *"gera uma imagem de…"*.

## Segurança

- A chave do Gemini fica só nos Secrets do Cloudflare, nunca no código.
- Quem tiver a URL com o `ACCESS_TOKEN` consegue gerar imagens na sua conta — não compartilhe. Para revogar, troque o secret.
