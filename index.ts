/**
 * Magpie gateway provider for OpenCode V2.
 *
 * Discovers the model catalog of a Magpie gateway (`GET /v1/models`, plus
 * `GET /v1/models?kind=image` for image models and `X-Magpie-Deciders: 1`
 * for decision/System One models), maps every entry onto an OpenCode model,
 * and keeps it fresh:
 *
 * - registers a `magpie` provider through `ctx.provider.transform`
 * - fetches the catalog during setup, so models exist as soon as the plugin loads
 * - refetches when the credential changes (`/login`, `/logout`)
 * - keeps the previous in-memory catalog when a transient fetch fails
 *
 * Options (`opencode.json(c)`):
 *
 *   { "plugins": [{ "package": ".../magpie", "options": {
 *       "baseURL": "http://127.0.0.1:3425/v1",
 *       "apiKey": "{env:MAGPIE_API_KEY}",
 *       "includeImages": true,
 *       "includeDecisions": true
 *   }}]}
 *
 * Credentials come from the plugin options, the process environment, or a
 * credential saved by OpenCode itself through `/login` (`magpie` integration).
 * The plugin never reads another agent's credential store.
 */

import { Model, Plugin, Provider } from "@opencode/plugin"

const PROVIDER_ID = "magpie"
const PROVIDER_NAME = "Magpie"
// OpenCode resolves credentials by `provider.integrationID ?? provider.id`, so the
// integration uses the provider id and needs no separate value.
const INTEGRATION_ID = PROVIDER_ID
const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1"
const BASE_URL_ENV = "MAGPIE_BASE_URL"
const API_KEY_ENV = "MAGPIE_API_KEY"

const CATALOG_TIMEOUT_MS = 15_000
const MAX_CATALOG_PAGES = 20

const PACKAGE_OPENAI = "@opencode/ai/providers/openai-compatible"
const PACKAGE_IMAGES = "@opencode/ai/providers/openai-compatible/images"
const PACKAGE_DECISIONS = "@opencode/ai/providers/openai-compatible/decisions"

/** Catalog `kind`/`type` values that are never chat models. */
const NON_CHAT_KINDS = new Set(["image", "video", "decision", "classifier", "embedding", "rerank"])

/** `/v1/models` lists decision models only when the caller names the kinds it wants. */
const DECIDERS_HEADER = "X-Magpie-Deciders"

// =============================================================================
// Small parsing helpers (mirrors pi's extension)
// =============================================================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asPositiveNumber(value: unknown): number | undefined {
  const parsed = asNumber(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/** Trims trailing slashes and assumes http:// when the URL has no scheme. */
function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (!trimmed) return trimmed
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/** A gateway path, tolerating base URLs with or without the trailing `/v1`. */
function apiEndpoint(baseUrl: string, path: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  return normalized.endsWith("/v1") ? `${normalized}${path}` : `${normalized}/v1${path}`
}

function modelsEndpoint(baseUrl: string): string {
  return apiEndpoint(baseUrl, "/models")
}

// =============================================================================
// Credentials and configuration
// =============================================================================

interface Settings {
  baseURL: string
  apiKey?: string
  includeImages: boolean
  includeDecisions: boolean
  timeout: number
}

function optionString(options: Record<string, unknown>, key: string): string | undefined {
  return asString(options[key])
}

/** The API key from the active `/login` or environment connection. */
async function activeApiKey(ctx: any): Promise<string | undefined> {
  try {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    if (!connection) return undefined
    const credential = await ctx.integration.connection.resolve(connection)
    return credential?.type === "key" ? asString(credential.key) : undefined
  } catch (error) {
    console.warn("[magpie] could not read the active credential", error)
    return undefined
  }
}

/** Options and environment first; a `/login` credential is the last fallback. */
/** Same precedence OpenCode uses for requests: active connection first, then options. */
async function resolveSettings(
  ctx: any,
  options: Record<string, unknown>,
): Promise<Settings> {
  const settings = baseSettings(options)
  const key = await activeApiKey(ctx)
  return key ? { ...settings, apiKey: key } : settings
}

function baseSettings(options: Record<string, unknown>): Settings {
  const optionBaseUrl = optionString(options, "baseURL")
  const optionApiKey = optionString(options, "apiKey")

  const baseURL = normalizeBaseUrl(
    optionBaseUrl || asString(process.env[BASE_URL_ENV]) || DEFAULT_BASE_URL,
  )

  // Explicit plugin option wins, then the environment. No other source.
  const apiKey = optionApiKey || asString(process.env[API_KEY_ENV])

  const includeImages = asBoolean(options.includeImages) ?? true
  const includeDecisions = asBoolean(options.includeDecisions) ?? true
  const timeout = asPositiveNumber(options.timeout) ?? CATALOG_TIMEOUT_MS

  return { baseURL, apiKey, includeImages, includeDecisions, timeout }
}

function providerInfo(settings: Settings): Provider.Info {
  const info = Provider.Info.empty(Provider.ID.make(PROVIDER_ID))
  return {
    ...info,
    name: PROVIDER_NAME,
    activation: "enabled",
    package: PACKAGE_OPENAI,
    integrationID: INTEGRATION_ID,
    settings: {
      baseURL: settings.baseURL,
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    },
  }
}

// =============================================================================
// Catalog fetch
// =============================================================================

function extractModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const record = asRecord(payload)
  if (!record) return []
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.models)) return record.models
  return []
}

/** The next catalog page, for gateways that paginate. */
function nextCatalogPageUrl(url: string, payload: unknown): string | undefined {
  const record = asRecord(payload)
  if (record?.has_more !== true) return undefined
  const cursor = asString(record.last_id) ?? asString(record.next_cursor) ?? asString(record.after)
  if (!cursor) return undefined
  const next = new URL(url)
  next.searchParams.set("after", cursor)
  return next.toString()
}

/** The gateway's own error message, when it sends one. The raw body is never echoed. */
async function requestError(response: Response, url: string): Promise<Error> {
  let detail: string | undefined
  try {
    const payload = await response.json()
    const error = asRecord(payload)?.error
    detail = asString(asRecord(error)?.message) ?? asString(error)
  } catch {
    // Not JSON; the status is all we report.
  }
  const endpoint = new URL(url)
  const suffix = detail ? `: ${detail.slice(0, 300)}` : ""
  return new Error(
    `Magpie request failed (${response.status}) at ${endpoint.origin}${endpoint.pathname}${suffix}`,
  )
}

async function fetchJson(
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const headers = new Headers({ accept: "application/json" })
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`)
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value)

  const response = await fetch(url, { headers, signal })
  if (!response.ok) throw await requestError(response, url)
  return response.json()
}

/** Every page of a catalog listing, bounded by one deadline and a page cap. */
async function fetchCatalogEntries(
  baseUrl: string,
  apiKey: string | undefined,
  kind: "image" | undefined,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): Promise<unknown[]> {
  const endpoint = modelsEndpoint(baseUrl)
  const entries: unknown[] = []
  const seen = new Set<string>()
  const signal = AbortSignal.timeout(timeoutMs)
  let url: string | undefined = kind ? `${endpoint}?${new URLSearchParams({ kind })}` : endpoint

  for (let page = 0; url && page < MAX_CATALOG_PAGES; page++) {
    if (seen.has(url)) break
    seen.add(url)
    const payload = await fetchJson(url, apiKey, signal, extraHeaders)
    entries.push(...extractModelEntries(payload))
    url = nextCatalogPageUrl(url, payload)
  }
  return entries
}

// =============================================================================
// Entry classification
// =============================================================================

/** `kind` (Magpie) or `type` (OpenAI-style listings) of a catalog entry, lowercased. */
function catalogKind(raw: Record<string, unknown>): string | undefined {
  return (asString(raw.kind) ?? asString(raw.type))?.toLowerCase()
}

/** Output modalities the gateway advertises, lowercased. Empty when it advertises none. */
function outputModalities(raw: Record<string, unknown>): string[] {
  const modalities = asRecord(raw.modalities)
  const output =
    (modalities && Array.isArray(modalities.output) ? modalities.output : undefined) ??
    (Array.isArray(raw.output_modalities) ? raw.output_modalities : undefined) ??
    (Array.isArray(raw.outputModalities) ? raw.outputModalities : undefined)
  return (output ?? []).map((value) => (typeof value === "string" ? value.toLowerCase() : ""))
}

function isImageCatalogEntry(entry: unknown): boolean {
  const raw = asRecord(entry)
  if (!raw) return false
  const kind = catalogKind(raw)
  if (kind === "image") return true
  if (kind !== undefined && NON_CHAT_KINDS.has(kind)) return false
  return outputModalities(raw).includes("image")
}

/** Decision (System One) models are listed only under DECIDERS_HEADER. */
function isDecisionCatalogEntry(entry: unknown): boolean {
  const raw = asRecord(entry)
  return raw !== undefined && catalogKind(raw) === "decision"
}

function isChatCatalogEntry(entry: unknown): boolean {
  const raw = asRecord(entry)
  if (!raw) return false
  const kind = catalogKind(raw)
  if (kind !== undefined && NON_CHAT_KINDS.has(kind)) return false
  return !outputModalities(raw).includes("image")
}

// =============================================================================
// Entry -> OpenCode model
// =============================================================================

function inferReasoning(id: string, raw: Record<string, unknown>): boolean {
  const explicit =
    asBoolean(raw.reasoning) ??
    asBoolean(raw.supports_reasoning) ??
    asBoolean(raw.supportsReasoning) ??
    asBoolean(raw.supports_thinking) ??
    asBoolean(raw.supportsThinking)
  if (explicit !== undefined) return explicit
  const text = `${id} ${asString(raw.name) ?? ""} ${asString(raw.display_name) ?? ""} ${asString(raw.description) ?? ""}`.toLowerCase()
  return /\b(reason|thinking|o1|o3|o4|r1)\b/.test(text)
}

function inferInput(raw: Record<string, unknown>): string[] {
  const modalities = raw.modalities
  const record = asRecord(modalities)
  const advertised =
    (record && Array.isArray(record.input) ? record.input : undefined) ??
    (Array.isArray(raw.input_modalities) ? raw.input_modalities : undefined) ??
    (Array.isArray(raw.inputModalities) ? raw.inputModalities : undefined) ??
    (Array.isArray(modalities) ? modalities : undefined)

  // Like pi: text is always accepted; image/vision lifts the model to multimodal.
  const hasImage = (advertised ?? []).some(
    (modality) =>
      typeof modality === "string" && /image|vision/.test(modality.toLowerCase()),
  )
  if (hasImage) return ["text", "image"]
  if (asBoolean(raw.vision) || asBoolean(raw.supports_vision) || asBoolean(raw.supportsVision)) {
    return ["text", "image"]
  }
  return ["text"]
}

/** Reasoning levels the gateway advertises, from both field spellings. */
function reasoningLevels(raw: Record<string, unknown>): string[] {
  const levels = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) levels.add(value.trim().toLowerCase())
    const record = asRecord(value)
    if (record) add(record.effort ?? record.level ?? record.name ?? record.id)
  }
  if (Array.isArray(raw.reasoning_levels)) for (const level of raw.reasoning_levels) add(level)
  if (Array.isArray(raw.supported_reasoning_levels)) {
    for (const level of raw.supported_reasoning_levels) add(level)
  }
  return [...levels]
}

/** Magpie reports per-token decimal strings; OpenCode wants USD per million tokens. */
function parseCost(raw: Record<string, unknown>): Model.Info["cost"] {
  const pricing = asRecord(raw.pricing)
  const perMillion = (value: unknown): number => {
    const parsed = asNumber(value)
    if (parsed === undefined || parsed <= 0) return 0
    return Math.round(parsed * 1_000_000 * 1e6) / 1e6
  }
  if (!pricing) {
    return [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
  }
  return [
    {
      input: perMillion(pricing.prompt ?? pricing.input ?? pricing.input_price),
      output: perMillion(pricing.completion ?? pricing.output ?? pricing.output_price),
      cache: {
        read: perMillion(pricing.input_cache_read ?? pricing.cache_read ?? pricing.cacheRead),
        write: perMillion(pricing.input_cache_write ?? pricing.cache_write ?? pricing.cacheWrite),
      },
    },
  ]
}

function releaseTime(raw: Record<string, unknown>): number {
  const created = asPositiveNumber(raw.created)
  if (created !== undefined) return created * 1000
  const createdAt = asString(raw.created_at)
  if (createdAt) {
    const parsed = Date.parse(createdAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function entryId(raw: Record<string, unknown>): string | undefined {
  return asString(raw.id) ?? asString(raw.model) ?? asString(raw.name)
}

function entryName(raw: Record<string, unknown>, id: string): string {
  return asString(raw.display_name) ?? asString(raw.name) ?? asString(raw.magpie_label) ?? id
}

function toChatModel(raw: Record<string, unknown>): Model.Info | undefined {
  const id = entryId(raw)
  if (!id) return undefined

  const contextWindow =
    asPositiveNumber(raw.context_window) ??
    asPositiveNumber(raw.contextWindow) ??
    asPositiveNumber(raw.context_length) ??
    asPositiveNumber(raw.max_input_tokens) ??
    asPositiveNumber(raw.maxInputTokens) ??
    128_000
  const maxTokens =
    asPositiveNumber(raw.max_output_tokens) ??
    asPositiveNumber(raw.maxOutputTokens) ??
    asPositiveNumber(raw.max_tokens) ??
    asPositiveNumber(raw.maxTokens) ??
    Math.min(16_384, Math.max(1_024, contextWindow))

  const reportedOutputs = outputModalities(raw).filter(Boolean)
  const supportedParameters = Array.isArray(raw.supported_parameters)
    ? raw.supported_parameters.filter((entry): entry is string => typeof entry === "string")
    : undefined
  const tools =
    asBoolean(raw.tool_call) ?? asBoolean(raw.tools) ?? (supportedParameters ? supportedParameters.includes("tools") : true)
  const levels = inferReasoning(id, raw) ? reasoningLevels(raw) : []

  const model = {
    id: Model.ID.make(id),
    modelID: Model.ID.make(id),
    providerID: Provider.ID.make(PROVIDER_ID),
    type: "chat",
    name: entryName(raw, id),
    capabilities: {
      tools,
      input: inferInput(raw),
      output: reportedOutputs.length > 0 ? reportedOutputs : ["text"],
    },
    variants: levels.map((level) => ({
      id: Model.VariantID.make(level),
      settings: { reasoningEffort: level },
    })),
    time: { released: releaseTime(raw) },
    cost: parseCost(raw),
    status: "active",
    enabled: true,
    limit: { context: contextWindow, output: maxTokens },
  }

  return model as Model.Info
}

function toImageModel(raw: Record<string, unknown>): Model.Info | undefined {
  const id = entryId(raw)
  if (!id) return undefined

  const reportedOutputs = outputModalities(raw).filter(Boolean)
  const model = {
    id: Model.ID.make(id),
    modelID: Model.ID.make(id),
    providerID: Provider.ID.make(PROVIDER_ID),
    type: "image",
    name: entryName(raw, id),
    package: PACKAGE_IMAGES,
    capabilities: {
      tools: false,
      input: inferInput(raw),
      output: reportedOutputs.length > 0 ? reportedOutputs : ["image"],
    },
    variants: [] as Model.Info["variants"],
    time: { released: releaseTime(raw) },
    cost: parseCost(raw),
    status: "active",
    enabled: true,
    limit: { context: 0, output: 0 },
  }
  return model as Model.Info
}

/** A decision model answers System One questions at `/v1/systemone`, not chat. */
function toDecisionModel(raw: Record<string, unknown>): Model.Info | undefined {
  const id = entryId(raw)
  if (!id) return undefined

  const contextWindow =
    asPositiveNumber(raw.context_window) ??
    asPositiveNumber(raw.contextWindow) ??
    asPositiveNumber(raw.context_length) ??
    asPositiveNumber(raw.max_input_tokens) ??
    asPositiveNumber(raw.maxInputTokens) ??
    128_000
  const model = {
    id: Model.ID.make(id),
    modelID: Model.ID.make(id),
    providerID: Provider.ID.make(PROVIDER_ID),
    type: "decision",
    name: entryName(raw, id),
    package: PACKAGE_DECISIONS,
    capabilities: {
      tools: false,
      input: inferInput(raw),
      // OpenCode's own decision models say "decision", not a text reply.
      output: ["decision"],
      temperature: false,
    },
    variants: [] as Model.Info["variants"],
    time: { released: releaseTime(raw) },
    cost: parseCost(raw),
    status: "active",
    enabled: true,
    limit: { context: contextWindow, output: 0 },
  }
  return model as Model.Info
}

function dedupe<T extends { id: string }>(models: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const model of models) byId.set(model.id, model)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// =============================================================================
// Catalog fetch
// =============================================================================

async function fetchCatalog(settings: Settings): Promise<Model.Info[]> {
  const [listed, imageEntries] = await Promise.all([
    fetchCatalogEntries(
      settings.baseURL,
      settings.apiKey,
      undefined,
      settings.timeout,
      settings.includeDecisions ? { [DECIDERS_HEADER]: "1" } : undefined,
    ),
    settings.includeImages
      ? fetchCatalogEntries(settings.baseURL, settings.apiKey, "image", settings.timeout).catch(() => [])
      : Promise.resolve([]),
  ])

  const chat = listed
    .filter(isChatCatalogEntry)
    .map((entry) => toChatModel(asRecord(entry) ?? {}))
    .filter((model): model is Model.Info => model !== undefined)
  const decisions = settings.includeDecisions
    ? listed
        .filter(isDecisionCatalogEntry)
        .map((entry) => toDecisionModel(asRecord(entry) ?? {}))
        .filter((model): model is Model.Info => model !== undefined)
    : []
  const image = settings.includeImages
    ? imageEntries
        .filter(isImageCatalogEntry)
        .map((entry) => toImageModel(asRecord(entry) ?? {}))
        .filter((model): model is Model.Info => model !== undefined)
    : []

  return dedupe([...chat, ...decisions, ...image])
}

// =============================================================================
// Plugin
// =============================================================================

export default Plugin.define({
  id: "opencode.magpie",
  async setup(ctx) {
    const options = ctx.options as Record<string, unknown>
    let settings = await resolveSettings(ctx, options)
    if (!settings.apiKey) {
      console.warn("[magpie] no API key configured; run /login magpie or set MAGPIE_API_KEY")
    }
    // OpenCode owns the registered model list; this is just the last successful
    // fetch in this process.
    let models: Model.Info[] = []

    // `/login` lists every registered integration; the key method stores the
    // API key as an OpenCode credential owned by this plugin.
    await ctx.integration.transform((editor) => {
      editor.update(INTEGRATION_ID, (integration) => {
        integration.name = PROVIDER_NAME
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "key", label: "API key" },
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "env", names: [API_KEY_ENV] },
      })
    })

    await ctx.provider.transform((editor) => {
      editor.add({ info: providerInfo(settings), models })
    })

    let syncing = false
    let disposed = false

    // Re-resolve the credential (it can change without a config change) and
    // fetch the catalog. A transient failure keeps the previous list.
    const sync = async (): Promise<void> => {
      if (disposed || syncing) return
      syncing = true
      try {
        settings = await resolveSettings(ctx, options)
        try {
          const next = await fetchCatalog(settings)
          if (next.length === 0) throw new Error("the gateway returned no models")
          models = next
          console.log(`[magpie] catalog loaded: ${next.length} models from ${settings.baseURL}`)
        } catch (error) {
          if (!settings.apiKey) {
            // Logged out and no option/env key: these models are not callable.
            models = []
          }
          console.warn("[magpie] catalog fetch failed; keeping the previous list", error)
        }
        if (!disposed) await ctx.provider.reload()
      } finally {
        syncing = false
      }
    }

    // React to /login and /logout as soon as OpenCode records the credential.
    const events = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["credential.updated", "credential.switched", "integration.updated"],
          signal: events.signal,
        })) {
          const data = event.data as { integrationID?: string } | undefined
          if (data?.integrationID && data.integrationID !== INTEGRATION_ID) continue
          await sync()
        }
      } catch (error) {
        if (!events.signal.aborted) {
          console.warn("[magpie] credential events stopped; reload the plugin to reconnect", error)
        }
      }
    })()

    await sync().catch(() => {})

    return () => {
      disposed = true
      events.abort()
    }
  },
})
