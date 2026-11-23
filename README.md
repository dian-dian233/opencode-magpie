# opencode-magpie

OpenCode V2 server plugin that turns a [Magpie](https://github.com/yetone/magpie)
gateway into an OpenCode provider named `magpie`.

It reads the gateway model catalog (`GET /v1/models`, plus `GET /v1/models?kind=image`)
and maps each entry onto an OpenCode chat or image model.

- package: `opencode-magpie`
- plugin id: `opencode.magpie`
- provider / integration id: `magpie`

已在 OpenCode `v2.4.0` 上实测：chat、工具调用、`#variant` 推理等级，以及内置
`generate_image` 工具均可用。

## Install

从 GitHub 安装：

```bash
opencode plugin add https://github.com/laxtiz/opencode-magpie
```

这会把插件写进全局 `~/.config/opencode/opencode.json`，代码缓存到
`~/.cache/opencode/npm/`。

```bash
opencode plugin list      # opencode.magpie  <commit>  https://github.com/...
opencode plugin check     # 是否落后于 upstream
opencode plugin update    # 拉取最新 commit
opencode plugin remove https://github.com/laxtiz/opencode-magpie
```

需要改插件选项时，把配置项改成对象形式：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "https://github.com/laxtiz/opencode-magpie",
      "options": {
        "baseURL": "http://192.168.1.20:3425/v1",
        "includeImages": true
      }
    }
  ]
}
```

本地开发、隔离测试和发布流程见 [`AGENTS.md`](./AGENTS.md)。

## Options

`plugins[].options`（全部可选）：

| Option            | Type      | Default                     | Meaning |
| ----------------- | --------- | --------------------------- | ------- |
| `baseURL`         | `string`  | `MAGPIE_BASE_URL` 或 `http://127.0.0.1:3425/v1` | 网关地址。带不带 `/v1`、带不带 `http://` 都可以（自动补齐）。 |
| `apiKey`          | `string`  | `/login` 凭证或 `MAGPIE_API_KEY` | `Authorization: Bearer` 用的 key。不配置时不发该 header。 |
| `includeImages`   | `boolean` | `true`                      | 是否额外拉取并注册 `?kind=image` 的图片模型。 |
| `timeout`         | `number`  | `15000`                     | 单次目录请求超时，毫秒。 |

环境变量：

- `MAGPIE_BASE_URL`（优先级低于 `options.baseURL`）
- `MAGPIE_API_KEY`（作为 env connection，优先级高于 `options.apiKey`）

### 登录（`/login`）

插件注册了一个名为 **Magpie** 的 integration，包含两种方法：

```text
/login
  → Magpie
  → API key                      （保存到 OpenCode 凭证库）
  → Environment variable 方法    （读取 MAGPIE_API_KEY）
```

只用 key，不再额外问 baseURL——网关地址属于 provider 配置，不属于凭证：

```bash
export MAGPIE_BASE_URL=http://192.168.1.20:3425/v1   # 远程网关
```

或在插件 option 里写 `baseURL`。CLI 也可以登录：

```bash
opencode auth login magpie      # 交互式输入 key
opencode auth list              # Magpie  Magpie  stored
opencode auth logout magpie     # 退出
```

登录成功后 credential 存在 OpenCode 自己的凭证库里；插件监听 `credential.*` 事件，
立即用新 key 重拉模型，不需要重启。

凭证优先级（高 → 低，和 OpenCode 的 connection 解析一致）：

1. `/login` 保存的 Magpie credential
2. `MAGPIE_API_KEY`（env connection）
3. `options.apiKey`

`baseURL` 的优先级：

1. `options.baseURL`
2. `MAGPIE_BASE_URL`
3. `http://127.0.0.1:3425/v1`

插件不读取任何其他 agent 的凭证文件。

## Behavior

- **启动**：插件 setup 时直接拉一次目录并注册 provider；拉不到就是 0 个模型，不会用旧数据凑数。网关不可达时会先等一次 `timeout`（默认 15s），然后以 0 模型启动。
- **刷新**：OpenCode 的 `/models` 会重新加载插件，setup 因此重新拉一次上游目录；登录/退出（credential 变化）也会立即重拉。插件自己不设定时器、不提供刷新命令。
- **退出登录**：`opencode auth logout magpie` 后如果没有 `options.apiKey` / `MAGPIE_API_KEY`，内存里的 `magpie/*` 会立即清空，直到重新登录或配置 key。
- **失败保留**：有可用凭证时，运行中拉取失败/超时/空目录会保留本次进程内上一次成功的结果；没有凭证时清空。进程重启后都不保留。
- **无本地缓存**：模型列表由 OpenCode 的 provider registry 管理，插件不写 storage、不写磁盘；只在进程内保存最近一次拉取结果。

## Field mapping

| Magpie catalog field | OpenCode `Model.Info` |
| -------------------- | --------------------- |
| `id` / `model`       | `id` + `modelID`（保留原始 `/`、`:`） |
| `display_name` / `name` / `magpie_label` | `name` |
| `kind` / `type` / `modalities.output` | chat 或 image 分类 |
| `modalities.input` / `input_modalities` / `vision` | `capabilities.input`（`text`，命中 image/vision 时加 `image`） |
| `supported_parameters` / `tool_call` / `tools` | `capabilities.tools` |
| `context_window` / `context_length` / `max_input_tokens` | `limit.context`（默认 128000） |
| `max_output_tokens` / `max_tokens` | `limit.output` |
| `pricing.prompt` / `pricing.completion` / `pricing.input_cache_read` / `pricing.input_cache_write` | `cost[]`，**每 token 美元 × 1,000,000 → 每百万 token 美元** |
| `reasoning` + `reasoning_levels` / `supported_reasoning_levels` | `variants[]`，每个 level 一个 `{ id, settings: { reasoningEffort } }` |
| `created` / `created_at` | `time.released` |

chat 模型统一使用 `@opencode/ai/providers/openai-compatible`（实测这个网关的
`coarena/*`、`stepfun-cn/*` 等模型都能通过 `/v1/chat/completions` 调用）。
图片模型（`?kind=image`）的 `package` 设为
`@opencode/ai/providers/openai-compatible/images`。注册了图片模型后，OpenCode 内置的
`generate_image` 工具会自动启用；也可以直接调 `POST /api/experimental/generate/image`。

## Verify

```bash
# chat 模型
opencode models | grep '^magpie/'

# 图片模型（注意：opencode models 只列 chat）
opencode api get '/api/model?types=image' | jq -r '.data[]|select(.providerID=="magpie")|.id'

# 登录
/login                       # Magpie -> API key
# 或
opencode auth login magpie

# 聊天
opencode run --model 'magpie/auto/glm-5.3-flash' "Reply with exactly: PONG"

# 推理等级
opencode run --model 'magpie/auto/deepseek-v4.1-flash#high' "Reply with exactly: PONG"

# 图片：直接让 agent 用内置 generate_image（会自动选到 magpie 的图片模型）
# 或调 API：
opencode api post /api/experimental/generate/image --data '{
  "model": { "providerID": "magpie", "id": "loomy/doubao-seedream-5-lite" },
  "prompt": "A red cube on a white background"
}'
```

## Known limitations

- **模型 id 含 `/`**：例如 `auto/deepseek-v4.1-flash`、`vercel/meta/muse-ember`。通过
  `providerID + "/" + id` 拼出来的字符串会有歧义，脚本里请用 `providerID`/`id` 两个字段，
  不要 `split("/")` 反解。
- `opencode models` 只列 chat 模型；图片模型用 `/api/model?types=image` 查。
- 图片模型注册为 `type: "image"`，聊天面板不会出现；用内置 `generate_image` 工具或 generate API 调用。
- 网关没有广告 reasoning level 时就不生成 variant（避免凭空发明参数）。
- 输入模态统一收敛为 `text` / `text+image`；`video` 等其它模态不会出现在 `capabilities.input` 里。
- 有凭证时，网关返回空目录视为异常并保留上一次结果；无凭证时模型列表为空。

## License

MIT
