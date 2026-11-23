# AGENTS.md

OpenCode V2 server plugin for a [Magpie](https://github.com/yetone/magpie) gateway.
One source file: `index.ts`. There is no build output and no installed dependencies —
`@opencode/plugin` and `@opencode/ai` are provided by the OpenCode runtime.

## The running plugin is not this folder

The live install comes from GitHub:

- config: `"plugins": ["https://github.com/laxtiz/opencode-magpie"]`
- `opencode plugin list` → `opencode.magpie <commit> https://github.com/laxtiz/opencode-magpie`
- code is cached under `~/.cache/opencode/npm/git-opencode-magpie-*/…/node_modules/opencode-magpie`

Editing this folder changes nothing at runtime. Ship changes with:

```sh
git add -A && git commit -m "..." && git push
opencode plugin check        # current vs upstream commit
opencode plugin update       # pull the pushed commit
```

Never edit the cache or `~/.config/opencode/plugins/` to test a change.

## Test in an isolated server

Do not restart, reconfigure, or edit the user's live OpenCode service. Use a throwaway
`HOME` and port:

```sh
T=/tmp/magpie-dev; rm -rf "$T"
mkdir -p "$T/home/.config/opencode" "$T/home/.local/share/opencode" "$T/proj"
printf '{"plugins":["%s"]}\n' "$PWD" > "$T/home/.config/opencode/opencode.json"
cd "$T/proj"
HOME="$T/home" MAGPIE_API_KEY=... nohup opencode serve --port 5114 --hostname 127.0.0.1 > "$T/server.log" 2>&1 &
HOME="$T/home" opencode api --server http://127.0.0.1:5114 get /api/model | jq .
```

- Startup takes ~20–30 s (OpenCode loads the well-known integrations). Poll
  `/api/integration` or `/api/model` until `magpie` appears.
- `opencode api` and `opencode run` must pass `--server http://127.0.0.1:5114`,
  otherwise they hit the user's live service.
- Kill the server PID and remove `$T` when done. There is no test suite.
- Syntax check: `bun build index.ts --outfile=/tmp/plugin.js --target=bun --external @opencode/plugin`
- A quick end-to-end check: `opencode run --server … --model magpie/auto/glm-5.3-flash "Reply with exactly: OK"`

## Invariants to preserve

- ids: package `opencode-magpie`, plugin `opencode.magpie`, provider and integration `magpie`
  (`INTEGRATION_ID = PROVIDER_ID`; OpenCode resolves credentials by `integrationID ?? provider.id`).
- setup fetches `GET /v1/models` plus `?kind=image`, maps entries to `Model.Info`, and registers
  them with `ctx.provider.transform`. No storage, timer, or custom command: `/models` reloads
  plugins and re-runs setup.
- all chat models use `@opencode/ai/providers/openai-compatible`; image models use
  `.../openai-compatible/images`. The gateway accepts `/v1/chat/completions` for every chat
  model, so do not reintroduce per-model adapter selection from `native_endpoints`.
- auth: integration methods `key` and env `MAGPIE_API_KEY`. Precedence is active connection
  (`/login` or env) over `options.apiKey`. baseURL is `options.baseURL` > `MAGPIE_BASE_URL` >
  `http://127.0.0.1:3425/v1`; it is not stored by `/login`.
- `/logout` without an env/option key must clear the in-memory model list.
- `pricing.*` is USD per token; OpenCode expects USD per million (`× 1_000_000`).
- model ids contain `/` (`auto/deepseek-v4.1-flash`); never split `provider/model`.

## Gateway facts

- upstream <https://github.com/yetone/magpie>, image `ghcr.io/yetone/magpie:stable`,
  default `http://127.0.0.1:3425/v1`.
- catalog requests need `Authorization: Bearer`; image models are not in `/v1/models` and only
  come from `?kind=image`.
- registering image models auto-enables OpenCode's built-in `generate_image` tool; tool calling
  works for chat models.

## Docs

`README.md` is user-facing (install, options, login, mapping); update it with behavior changes.
