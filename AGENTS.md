# AGENTS.md

OpenCode V2 server plugin for a [Magpie](https://github.com/yetone/magpie) gateway.
One source file: `index.ts`. There is no build output and no installed dependencies —
`@opencode/plugin` and `@opencode/ai` are provided by the OpenCode runtime.

No lint, format, typecheck, or test config exists; `index.ts` is the entire implementation.
The only automated check is the `bun build` syntax check below.

## The running plugin is not this folder

The live install comes from GitHub:

- install: `opencode plugin add https://github.com/laxtiz/opencode-magpie`
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
- Kill the server PID and remove `$T` when done.
- Syntax check: `bun build index.ts --outfile=/tmp/plugin.js --target=bun --external @opencode/plugin`
- A quick end-to-end check: `opencode run --server … --model magpie/auto/glm-5.3-flash "Reply with exactly: OK"`

## Invariants to preserve

- ids: package `opencode-magpie`, plugin `opencode.magpie`, provider and integration `magpie`
  (`INTEGRATION_ID = PROVIDER_ID`; OpenCode resolves credentials by `integrationID ?? provider.id`).
- setup fetches `GET /v1/models` plus `?kind=image`, maps entries to `Model.Info`, and registers
  them with `ctx.provider.transform`. No storage, timer, or custom command: `/models` reloads
  plugins and re-runs setup.
- refresh lives in `sync()`: it re-resolves the credential, refetches, then calls
  `ctx.provider.reload()`. It also runs on `credential.updated` / `credential.switched` /
  `integration.updated` events, so `/login` and `/logout` take effect without a restart.
- an empty catalog is treated as a failure (keeps the last good list); with no key at all
  (e.g. after `/logout`) it clears the in-memory list. Image-catalog fetch failures are
  swallowed and never fail setup.
- all chat models use `@opencode/ai/providers/openai-compatible`; image models use
  `.../openai-compatible/images`. The gateway accepts `/v1/chat/completions` for every chat
  model, so do not reintroduce per-model adapter selection from `native_endpoints`.
- auth: integration methods `key` and env `MAGPIE_API_KEY`. Precedence is active connection
  (`/login` or env) over `options.apiKey`. baseURL is `options.baseURL` > `MAGPIE_BASE_URL` >
  `http://127.0.0.1:3425/v1`; it is not stored by `/login`.
- `pricing.*` is USD per token; OpenCode expects USD per million (`× 1_000_000`).
- decision models are not in `/v1/models` unless the request carries `X-Magpie-Deciders: 1`;
  `?kind=decision` is a 400 from the gateway. They are `kind: "decision"` entries in the same
  `data` array and use `@opencode/ai/providers/openai-compatible/decisions`, which posts to
  `baseURL + /systemone` (magpie's `/v1/systemone`).
- video models (`?kind=video`) are deliberately not registered: this OpenCode version has no
  generic openai-compatible video adapter. Do not fake one with the image package.
- model ids contain `/` (`auto/deepseek-v4.1-flash`); never split `provider/model`.

## Gateway facts

- upstream <https://github.com/yetone/magpie>, image `ghcr.io/yetone/magpie:stable`,
  default `http://127.0.0.1:3425/v1`.
- catalog requests need `Authorization: Bearer`; image models are not in `/v1/models` and only
  come from `?kind=image`; decision models only come with the `X-Magpie-Deciders: 1` header.
- registering image models auto-enables OpenCode's built-in `generate_image` tool; tool calling
  works for chat models.

## Docs

`README.md` is user-facing and written in Chinese (install, options, login, mapping); update it
with behavior changes. It links here for the dev and release workflow.
