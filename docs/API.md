# Agent Loom API contract

All JSON requests use `Content-Type: application/json`. API errors: `{error:string}` with non-2xx status. Successful writes return the updated resource or `{ok:true}`. GET /api/state returns Snapshot (src/shared/types.ts). All writes produce SSE `snapshot` events. Frontend can refetch after mutations. /api/events is SSE with JSON ServerEvent records; `message_delta` streams answer text, `message_reasoning_delta` streams provider-reported reasoning, and `message_updated` applies a persisted message patch. Idempotent GETs; room and task data persist.

- GET /api/health -> {ok,version,configured,demoMode}
- GET /api/auth -> {required:boolean,authenticated:boolean}; POST /api/auth {token}; DELETE /api/auth.
- GET /api/state -> Snapshot
- GET /api/events -> SSE (`data: JSON.stringify(ServerEvent)`). EventSource with same-origin session cookie.
- PUT /api/settings accepts partial Settings. Keys are write-only; an explicit empty string clears a key. Omitted `model.apiKey` and `images.apiKey` retain their respective saved keys only when that integration's origin (scheme, host, port) is unchanged; changing origin clears its key unless a replacement is explicitly supplied. The image and language-model keys are separate encrypted secrets. An omitted `search.apiKey` retains its saved value. Responses never include raw keys. Changes to language/image execution settings or credentials return 409 during active tasks or avatar jobs. Demo-mode changes return 409 during active bot tasks. Default-folder changes return 409 when an active room uses that default. An unchanged full form can still update permissions, automatic learning and global inference capacity.
- Model token limits are integers: `contextWindow` 2,048–2,097,152 and `maxOutputTokens` 128–1,048,576, with output strictly smaller than context. The API does not require powers of two. `reasoningMode:'server'|'openai'` defaults to `server`. `reasoningEffort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`, and defaults to `medium` in explicit mode. Server mode omits `reasoning_effort`; explicit mode sends the selected literal value without a silent downgrade. The endpoint must support it.
- `inference.maxConcurrentRequests` is an integer from 1 through 16, default 1. This setting can change during active work. Increases admit eligible waiters; reductions leave active requests running and delay new ones until capacity is available.
- `images` accepts the fields listed below. The image connection is optional and disabled by default; enabling it requires a base URL and model ID. `images.apiKeyConfigured` is read-only response metadata.
- `permissions.shell`, `permissions.fileWrite`, and `permissions.network` accept `ask`, `auto`, `allow`, or `deny`. `auto` applies the exact-operation policy and falls back to an approval request for operations outside its automatic set. Omitted categories keep their saved values.
- POST /api/settings/test {baseUrl,modelId?,apiKey?} -> {ok,models:string[],message:string}; read-only model discovery, no paid generation. An omitted key reuses the saved model key only for the saved origin. Testing another origin does not forward that key or change saved settings.
- POST /api/demo {enabled:boolean} -> Settings; explicit simulated mode, all answers labeled by UI; does not contact LLM.
- POST /api/bots {name,handle,role,systemPrompt,color,avatar,enabled?}; PATCH /api/bots/:id; DELETE /api/bots/:id (reject while tasks active).
- POST /api/rooms {name,description?,botIds,workspacePath?:string|null,parallelResponses?:boolean}; PATCH /api/rooms/:id {name?,description?,botIds?,workspacePath?:string|null,parallelResponses?,pinned?,archived?}. A path sets the room override; null resets to the global default. `parallelResponses` defaults to false and controls overlapping response requests from different bots in this room. A changed effective directory or parallel-response policy returns 409 while the room has active tasks. The same bot × room session remains exclusive regardless of this flag.
- GET /api/workspace-picker -> {available:boolean,platform:string,reason?:'remote'|'headless'|'unsupported'|'disabled',message?:string}; capability check without opening a dialog.
- POST /api/workspace-picker {initialPath?:string} -> {path:string|null}; opens a native folder chooser only for local, unforwarded loopback access on a supported desktop. Cancellation returns null. Selection does not save the room/settings form. Existing authentication and same-origin checks apply.
- POST /api/rooms/:id/messages {body,botIds?:string[]} -> {message,tasks}; @handles resolved server-side, default first enabled member. Client should POST once and not invent bot responses.
- POST /api/tasks/:id/stop; POST /api/tasks/:id/resume -> Task. Stop cancels pending approvals; explicit resume preserves the operation record and pinned workspace. Resume returns 409 if the room now uses a different folder; restore the prior folder or create a new task.
- POST /api/tasks/stop-all -> {ok:true}.
- POST /api/approvals/:id {decision:'approve'|'deny'} -> Approval.
- POST /api/skills {name,description,content,botId?:string|null} -> Skill candidate.
- PATCH /api/skills/:id {name?,description?,content?,status?:'candidate'|'active'|'archived',botId?}; POST /api/skills/:id/restore {version:number}; GET /api/skills/:id/export -> text/markdown.
- POST /api/memories {content,botId?:string|null}; PATCH /api/memories/:id {content}; DELETE /api/memories/:id.
- POST /api/automations {name,kind,roomId,botId,prompt,intervalMinutes?,sourceUrl?,enabled?,imap?:{host,port,secure,user,mailbox,password?}}; PATCH /api/automations/:id; DELETE /api/automations/:id; POST /api/automations/:id/run -> Automation. Running may establish a baseline, detect no change, or coalesce existing work without creating a task. Source edits reset the relevant baseline while retaining the prior task ID for overlap prevention. Disabling an assigned bot, removing it from the destination room, or archiving that room pauses affected enabled rules.
- POST /api/automations/:id/webhook-key -> {token,path}; explicit token creation, only webhook automations. POST /api/hooks/:id with bearer token + {text,eventId?} -> {ok,duplicate,queued,task?}. `task` identifies an immediately created task; `queued:true` means the event was saved for a later coalesced batch. Repeated event IDs return `duplicate:true`.
- POST /api/notifications/read {id?:string} marks one or all read.
- GET /api/images/:id -> authenticated binary PNG/JPEG/WebP attachment. Append `?download=1` for `Content-Disposition: attachment`; otherwise the response is inline. Images use `X-Content-Type-Options: nosniff` and private/no-store caching. IDs have the form `img_` followed by 64 lowercase hexadecimal characters. The endpoint serves only indexed app-managed image files, not caller-supplied filesystem paths or provider URLs.

## Bot avatars

`Bot.avatar` remains a string. POST/PATCH bot requests accept these forms:

| Form                  | Example                                                      | Meaning                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled character     | `character:aster`                                            | One of `character:aster`, `character:nova`, `character:orbit`, `character:moss`, `character:luna`, `character:pip`, `character:sage`, or `character:bram`; rendered from bundled `/avatars/*.webp` files. |
| Generated image       | `image:img_` followed by 64 lowercase hexadecimal characters | References an existing indexed `GeneratedImage`; resolves to authenticated `/api/images/:id`. The referenced metadata must exist in the app's image index.                                                |
| Legacy icon or symbol | `sparkles`, `compass`, `🌿`                                  | Preserves short legacy values, up to 40 characters, excluding control characters and URL/path/markup delimiters.                                                                                          |

The outer field limit is 80 characters. Arbitrary remote URLs, data URLs, filesystem paths and SVG/HTML markup are not accepted as avatar references. Bot PATCH retains its normal active-task guard. Creating or selecting an image does not update a bot automatically: apply it with the ordinary bot POST/PATCH, for example `{ "avatar": "image:img_<64 lowercase hex characters>" }` using a real returned image ID.

New installs seed Aster and Nova with their corresponding characters. An upgrade replaces only their original `sparkles`/`compass` choices once. Customized avatars and deleted bots are preserved, and choosing an original icon again after migration survives later restarts. See [avatar usage and bundled artwork](AVATARS.md).

## Avatar generation jobs

Avatar generation is a durable user-initiated operation, separate from a bot task or chat message. It uses the saved `images` integration directly; it does not call a language model or require a room/bot ID.

| Method and route                     | Request                            | Response / behavior                                                                                                                |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/avatar-generations`       | `{requestId:string,prompt:string}` | `AvatarGeneration`; 202 while queued/generating, 200 when returning an existing terminal job.                                      |
| `GET /api/avatar-generations`        | None                               | Up to 20 most recently created jobs, newest first, including their statuses and any completed image metadata.                      |
| `GET /api/avatar-generations/:id`    | None                               | One persisted `AvatarGeneration`; 404 if absent.                                                                                   |
| `DELETE /api/avatar-generations/:id` | None                               | Cancels an active job and returns its final record. A terminal job is returned unchanged. This does not erase the record or image. |

`requestId` and route IDs must be valid UUID strings and are normalized to lowercase. The prompt is trimmed and must contain 1–16,000 characters; the profile UI uses a smaller 4,000-character input limit. Avatar requests use the saved image size; they do not take a per-request size, model, endpoint or credential override.

```ts
interface AvatarGeneration {
  id: string; // Normalized request UUID
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  prompt: string;
  image?: GeneratedImage;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

| Status        | Meaning                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`      | Persisted and waiting for image capacity or, when sharing is enabled, global inference capacity.                                                                     |
| `generating`  | Admitted to its required queues; provider generation/download and local validation/storage are in progress.                                                          |
| `completed`   | A supported raster was saved and indexed; `image` contains its metadata.                                                                                             |
| `failed`      | Validation, permission recheck, provider, timeout or storage failure after job admission; inspect `error`. Invalid requests rejected before admission create no job. |
| `cancelled`   | The user cancelled an active local job. The provider may still finish work it already accepted.                                                                      |
| `interrupted` | Shutdown or restart interrupted a nonterminal job. It is not automatically resubmitted.                                                                              |

Repeat a POST with the same UUID and the same trimmed prompt to recover the existing record without issuing another image request. Reusing the UUID with a different prompt returns 409. Terminal states remain terminal, including failed, cancelled and interrupted jobs; a deliberate new attempt needs a new UUID. This prevents local replay of the same request, but cannot guarantee exactly-once execution at the remote provider when a connection or process fails.

Only **one avatar job may be queued or generating across the app**. A different new request while one is active returns 409. Chat-image tools and avatar jobs also share the same serialized image queue. `images.shareInferenceSlot:true` additionally reserves global inference capacity; a runtime unable to provide that slot returns 503 instead of bypassing the limit.

The explicit Generate action authorizes the supplied prompt for Ask, Auto or Allow, without a second bot-tool approval card. Network Deny returns 403 before admission. Permission is rechecked after queueing; changing it to Deny, or to a different policy other than Allow, prevents dispatch. Language/image execution settings and their credentials cannot change while an avatar job is active; settings updates return 409. Permissions and the global inference limit can still change.

The jobs are stored separately from `Snapshot`; poll the list or individual GET endpoint for their state. Closing the editor stops its observer without cancelling the server job. Recent listing is limited to 20 records, but older jobs remain retrievable by ID. Completed job metadata repairs the image index on startup; previously active jobs become interrupted. Cancellation and restart never silently retry generation. Applying a result still requires saving the bot profile.

## Image settings and tool protocol

| `images` field       | Default     | Accepted value / behavior                                                                                                      |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`            | `false`     | Boolean; requires a valid base URL and nonempty model ID when true.                                                            |
| `baseUrl`            | Empty       | HTTP(S) base URL without embedded credentials, query or fragment; `/images/generations` is appended.                           |
| `modelId`            | Empty       | Image-provider model identifier, up to 250 characters.                                                                         |
| `apiKey`             | Omitted     | Write-only credential, up to 4,096 characters; empty clears it. Never returned.                                                |
| `apiKeyConfigured`   | `false`     | Response-only Boolean indicating a saved image credential.                                                                     |
| `size`               | `1024x1024` | `auto` or `WIDTHxHEIGHT`; each dimension 64–8,192, product at most 16,777,216. Provider-specific restrictions can be narrower. |
| `responseFormat`     | `auto`      | `auto` omits the legacy field; `b64_json` explicitly sends that `response_format`.                                             |
| `timeoutSeconds`     | `120`       | Integer 10–1,800; the active generation/download deadline starts after queue admission.                                        |
| `shareInferenceSlot` | `true`      | Images acquire global model capacity. False permits independent image/text overlap; images themselves remain serialized.       |

The LLM tool `generate_image({prompt,size?})` accepts a prompt of 1–16,000 characters and an optional size override using the same bounds. It posts `{model,prompt,n:1,size}` to the configured endpoint, plus `response_format` only when explicitly selected. The adapter accepts `data[0].b64_json` or `data[0].url`. It does not implement native ComfyUI workflow submission. Bot-tool generation uses the network permission; Auto falls back to exact manual approval. Avatar jobs use this same image adapter and saved settings, with the direct consent described above.

Images are raster PNG/JPEG/WebP files, bounded to 20 MiB, 8,192 pixels per side and 16,777,216 pixels total. Metadata uses this shape:

```ts
interface GeneratedImage {
  id: string;
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  filename: string;
  byteLength: number;
  prompt: string;
  model: string;
  createdAt: string;
}
```

`Message.attachments?: GeneratedImage[]` is persisted and delivered by `message_updated` and snapshots. Clients derive a same-origin `/api/images/:id` URL; no provider URL or base64 image is placed in the snapshot. A completed exact image operation reattaches its result to a resumed message without another generation request. Started/failed operations require inspection and a new task before retrying. Local cancellation may not stop computation already accepted by the provider.

## Inference queue

`Snapshot.queue` retains `active` and `waiting` and adds:

| Field            | Meaning                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `active`         | Requests currently holding the global inference gate, including shared image requests.                                                     |
| `waiting`        | Requests in the inference gate plus tasks waiting for a runtime/session worker. Tool-specific and approval waits are separate task states. |
| `capacity`       | Current global request limit; active can temporarily exceed it while a reduced limit drains.                                               |
| `modelWaiting`   | Requests waiting in the inference gate, including requests blocked by room order.                                                          |
| `sessionWaiting` | Pending tasks whose bot × room session is already active.                                                                                  |
| `waitingTasks`   | `{taskId,reason}` entries where reason is `inference`, `room`, `session`, or `worker`.                                                     |

The added fields are optional in the TypeScript shape for compatibility with older fixtures/clients; the current runtime populates them. A serial room reserves its turn for one model request, not an entire task. Ordinary tools and approvals release model capacity. Parallel rooms can admit different bots up to the global limit, but never mutate the same bot × room session concurrently. The external inference server determines its actual batching and execution strategy.

## Messages and execution state

Room content is shared, while bot private sessions are separate. Initial prompts and `room_context` include completed room messages, excluding streaming fragments and failed partial messages. Rooms may include an absolute `workspacePath` override. Tasks persist their effective `workspacePath` at admission, including inherited roots for handoffs and learning. Legacy tasks are pinned before path-setting changes. UI maps statuses explicitly: queued / waiting_model / running / waiting_tool / awaiting_approval / stopped / interrupted / failed / completed. Never render all non-running statuses as stopped.

Messages may include `reasoning`, `reasoningStatus:'streaming'|'complete'|'interrupted'`, and `reasoningTruncated`. A `message_reasoning_delta` event carries `{messageId,delta,truncated}`. Reasoning is separate from `body`, persists across reloads, and is capped at 64,000 characters per message. Clients should apply `message_updated` events with `{messageId,patch}`, including body resets between intermediate updates and the final answer, and use a fresh snapshot to reconcile after reconnecting.

Activity records may carry `messageId` to associate a tool/status/progress event with a particular message attempt. Automatically approved operations have `kind:'approval'`, an `approvalRule` identifier, and a human-readable reason in `detail`. Intermediate assistant updates use `kind:'progress'`; they are not additional final answers.
