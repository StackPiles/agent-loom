# Models, images and parallel inference

This guide describes Agent Loom 0.7.3. Loom connects to inference servers you operate or choose; it does not download models, launch a GPU engine, or change an engine's memory settings. See [installation](INSTALL.md) for the app and Docker networking.

## Three separate settings

| Setting            | What it controls                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Language model     | The streaming chat-completion endpoint, model, credentials, context/output limits and optional reasoning effort used by bot sessions.      |
| Image model        | A separate Images endpoint, model and credential used by the language model's `generate_image` tool and direct avatar-generation requests. |
| Inference capacity | How many eligible requests Loom may submit at once. It does not select the server's GPU batching algorithm.                                |

An app instance owns one data directory containing its rooms, bots and settings. A room's working folder controls its file tools and command execution. It does not select another application workspace or another model connection.

## Context and output budgets

The context window covers input, conversation history and generated output together. In **Settings → Inference settings**, context choices run from 2,048 to 2,097,152 tokens and output choices from 128 to 1,048,576 tokens. The selectors offer powers of two, label million-scale choices as **1M / 2M**, and also show their exact counts. Here **1M = 2^20 = 1,048,576 tokens**.

| Context choice | Exact context tokens | Largest power-of-two output choice | Exact output tokens |
| -------------- | -------------------: | ---------------------------------- | ------------------: |
| 1M (`2^20`)    |            1,048,576 | 512K (`2^19`)                      |             524,288 |
| 2M (`2^21`)    |            2,097,152 | 1M (`2^20`)                        |           1,048,576 |

Output must be strictly smaller than context. If a smaller context choice is disabled, lower the output limit first. The API also accepts other integers within these bounds, and existing custom values remain selectable without rounding. Upgrading does not raise saved budgets or change the conservative new-install defaults of **32,768 context / 4,096 output**.

Loom reserves room for the selected output when deciding when Pi should compact older history. The target reserve is the output limit plus a 4,096-token safety margin, bounded to retain input space for small contexts or unusually large custom output values. Pi can still lower a particular request's output limit to fit its estimated input and safety margin. The configured output is a ceiling, not a required response length or a guarantee of that many remaining tokens.

Choose budgets supported by both the model and the running server. Increasing Loom's setting does not enlarge the server's actual context, its output capability, or available memory. Full input and full output cannot each independently consume the same context window.

## Reasoning effort

Keep **Server default** when the inference server controls thinking through its model or chat template. Loom then omits `reasoning_effort`, including during context compaction.

Choose explicit **OpenAI-compatible** mode only when the endpoint accepts that field. The selectable wire values are:

| Selection  | Value sent |
| ---------- | ---------- |
| None       | `none`     |
| Minimal    | `minimal`  |
| Low        | `low`      |
| Medium     | `medium`   |
| High       | `high`     |
| Extra high | `xhigh`    |
| Maximum    | `max`      |
| Ultra      | `ultra`    |

The adapter sends the selected value literally. Its Pi thinking-level map preserves `xhigh` and `max` and maps the Ultra selection to the literal `ultra`; it does not silently send High instead. This mapping is an application compatibility mechanism, not a promise that all eight values work on every server.

Accepted efforts vary by model and provider. **Ultra is an explicit server extension, not a universal OpenAI API value.** A server may reject or ignore an unsupported parameter. If it rejects the request, use a supported level or Server default; check its documentation and request logs. See the [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) for the provider's own behavior.

Effort is a request hint, not a fixed reasoning-token count or guaranteed quality improvement. Context and output limits still apply. Loom displays only actual non-redacted reasoning supplied by the provider; changing the setting cannot make a model expose reasoning it does not return.

## Parallel inference

The global limit is **1–16 concurrent requests**, default **1**. It can change during active work. Raising it admits eligible waiters; lowering it leaves current streams intact and admits new requests only as slots become available. During that drain, active requests can temporarily exceed the new limit.

| Boundary            | Behavior                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global capacity     | Limits admitted text, compaction and shared image requests across the app.                                                                           |
| Room response order | Parallelism is off by default: one response request at a time in the room. Allow simultaneous responses for different bots to share available slots. |
| Bot × room session  | Always exclusive, so two tasks cannot concurrently mutate the same Pi transcript.                                                                    |

Room ordering covers a **model request**, not an entire multi-step task. If Aster waits for an ordinary tool or approval, Nova can take a response turn in the same room. A later Aster request rejoins the queue. Separate bots' tools can overlap; a shared working folder is not a transactional filesystem lock.

Parallel peers receive completed room messages available when their prompts are built, not each other's streaming fragments. Their answers can therefore be independent. Ask one bot to review or synthesize completed results when that is the intended workflow; enabling parallelism does not add a consensus algorithm.

The queue distinguishes global inference capacity, room order, a busy bot × room session, and runtime workers. Each response retains its own thinking, progress, approvals and stop/resume controls. Cancelling one task releases its waits and slots without cancelling unrelated tasks.

### Waiting and timeouts

Waiting in Loom's inference, room, session or worker queue does not use a language-model response timeout. After a request is admitted, two independent limits apply under **Settings → Inference settings**:

| Setting                | Default                    | What it measures                                                                                                                                                 |
| ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First response timeout | 1,800 seconds (30 minutes) | Time after dispatch until the first text, reasoning or tool-call output. This includes waiting inside the inference server, model loading and prompt processing. |
| Output idle timeout    | 300 seconds (5 minutes)    | Time without further model output after output starts. New output resets this timer.                                                                             |

Both settings accept whole seconds from 10 to 86,400. Older configurations without these fields use the defaults. HTTP headers, role-only chunks and keepalives do not count as model output. A stream that keeps producing output may run longer than either interval; there is no separate five-minute total generation cap. These settings also cover context compaction and system-prompt assistance.

Timeouts fail the affected request, close its connection and release its inference slot. They do not automatically submit a replacement request. Manual task cancellation still interrupts waiting or active work. Connection establishment retains its separate ten-second limit. A provider or reverse proxy can enforce its own timeout independently; Loom cannot extend that remote limit. Match the concurrency limit to the server's actual capacity to avoid an unnecessary second queue there.

### What the inference server owns

Loom sends separate HTTP requests. Continuous batching, prefill/decode scheduling, prompt/KV caching, model loading and GPU kernels belong to the inference engine. For example, [llama.cpp's server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) describes its serving options. Configure and measure them on the engine; changing Loom's limit does not change them.

Start an evaluation at **2 requests**:

1. Verify that the engine accepts simultaneous requests and has suitable context/memory capacity.
2. Compare the same two independent tasks with Loom at 1 and at 2. For two bots in one room, also allow simultaneous responses in that room.
3. Compare time to first text, time for both tasks to finish, per-response speed, memory use and cancellation behavior.
4. Increase the limit only when those observations support it. Reduce it if the engine queues internally, runs out of memory or becomes less responsive.

Throughput and individual reply latency are different measurements. This release does not include a benchmark proving a particular speedup on DGX Spark, Mac Studio or a specific model.

## Bot handoffs

**Settings → Learning and handoffs → Bot handoffs** offers **Unlimited** (the default for new installations), **Set a limit** (1–10,000), and **Disable bot handoffs**. The saved/API value is `null` for unlimited, a positive integer for a finite limit, or `0` for disabled. Existing saved choices are retained on upgrade; zero is never reinterpreted as unlimited.

A finite limit counts directed bot requests within one originating task, not full round trips: A → B uses one handoff and B → A another. Branches share the same total, and the chain depth is bounded by the same setting. The originating user request and background learning reviews are not counted. Reaching the limit prevents further handoffs without cancelling existing tasks. A new user message starts another originating task; when several bots are explicitly addressed, each initial task has its own budget.

Unlimited removes both the handoff count and depth cap. It does not automatically wake bots for every room message: the sender must explicitly request a concrete contribution. Inference capacity, queue capacity, tool permissions and individual operation timeouts still apply, but do not bound the lifetime of a sequential handoff chain.

### Pause a room

The room header's **Pause after current work** action immediately prevents new tasks from starting. Each running generation or tool finishes, then the task waits before its next tool or model request. This also applies between several tool calls returned in one response. Model/image capacity waits release their queue reservations, and approving a pending action does not issue it while paused. **Resume room** continues the in-memory session without replaying completed tools. Independently running bots each reach their own boundary; the UI shows **Pausing** until they have all finished their current actions, then **Paused**.

The pause state and never-started queue survive an application restart. Started suspended tasks use explicit task recovery after restart; their live continuations are not silently replayed. Scheduled runs are not started while paused; schedule missed-run policies apply on resumption, and pending webhook/mail work is retained. Individual task cancellation remains available for an unresponsive or unwanted task; it immediately interrupts that task and is separate from the room's ordinary pause control.

## System prompt assistance

The bot editor's **Help write** panel calls the configured language model through Pi's OpenAI-compatible streaming adapter. It uses the saved endpoint, model, API key, temperature and explicit reasoning mapping. No separate subscription, image model, room session, tool execution or approval card is involved. Like ordinary language-model inference, the connection is independent of the network permission used for agent tools.

A helper request takes a slot from the same global inference gate as chat. Only one prompt-assistance job may be queued or generating across the app at a time, even if multiple chat slots are available. It does not acquire a bot × room session or alter a profile. Text-model settings, its credential, and demo mode cannot change while a helper job is active; live concurrency changes remain possible.

For this short editing task, output is capped at the smaller of the saved output budget and **4,096 tokens**, with at most **32,000 characters** in the resulting prompt. High reasoning effort can use much of that token allowance. If the provider truncates its reply or returns no answer text, the draft fails visibly; request a shorter draft or lower reasoning effort. A small configured output limit can also be increased up to the helper cap.

Input is checked conservatively using UTF-8 bytes plus message overhead because arbitrary local models do not share a tokenizer. Inputs that do not fit alongside the helper output budget are rejected before generation; existing instructions are never silently cut. Long Japanese text may need a larger configured context window or a shorter request. The saved first-response and output-idle timeouts start after a slot is acquired, and Stop cancels a queued or active request.

Completed drafts are editable and apply only after an explicit **Use this draft → Save teammate** action. The server retains jobs and returns the newest 20 in history. Closing the panel stops polling, not generation; restart/shutdown interrupts active jobs without replay. Generated-draft quality depends on the selected model. Demo mode is disabled for this feature rather than producing a simulated prompt.

## Chrome and image input

Chrome control uses the same configured language model and Pi tool loop as other bot work. It does not start a second autonomous agent. OpenAI-compatible streaming tool calling is required; a text-only model can operate the page accessibility snapshot.

**Settings → Chrome control → Send screenshots to the model** explicitly enables image input for screenshot tool results. Leave it off for text-only models. Screenshots are still displayed and retained in chat when this setting is off, but their pixels are not included in new tool responses sent to the model. When enabled, the endpoint and model must support OpenAI-compatible image content. Changing the setting requires stopping active bot tasks and does not erase previously stored session content.

The Chrome operation queue admits one action at a time independently of the model request limit. Model requests can run in parallel while browser operations remain serialized across all rooms and bots. See [Chrome connection, permissions and limits](BROWSER.md).

## Image generation

Enable the separate image integration in Settings and supply:

| Field                    | Default / scope                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| API base URL             | Your image server's base, such as `http://IMAGE_SERVER:PORT/v1`; do not append `/images/generations` yourself. |
| Model ID                 | The identifier recognized by that image server.                                                                |
| API key                  | Optional, encrypted separately from the language-model key.                                                    |
| Bot image permission     | Follow network permission (`inherit`) initially; optionally Allow without approval, Ask every time, or Deny.   |
| Size                     | `1024x1024`; alternatively `auto` or `WIDTHxHEIGHT`, 64–8,192 per side and at most 16,777,216 pixels.          |
| Response format          | Auto omits the legacy field. Explicit Base64 sends `response_format: b64_json`.                                |
| Timeout                  | 120 seconds initially; configurable from 10 to 1,800 seconds after queue admission.                            |
| Share inference capacity | Enabled initially. Images use the same global limit as text requests.                                          |

The server must implement **OpenAI-compatible `POST /images/generations`** and return `data[0].b64_json` or `data[0].url`. Native ComfyUI workflow submission, node mapping and workflow-result polling are not implemented. Use a compatible Images endpoint or a separately provided adapter.

Auto response format works with APIs that return base64 by default and reject the legacy `response_format` option. A compatible local server may require explicit Base64 instead. Check the server's protocol rather than relying on its product name; see the [OpenAI Images reference](https://developers.openai.com/api/reference/resources/images/methods/generate).

### Test before saving

The image settings form can generate **one test image from the current unsaved fields**. It uses a short fixed prompt and the selected model, size, response format, timeout and inference-sharing option. The button identifies the real generation action; normal provider charges apply. A supported raster preview establishes that generation and image decoding worked, without saving the draft settings or posting a message to a room.

An untouched saved image key is reused only for the same endpoint origin. A newly typed key is used for that test; explicitly clearing the key sends no key. The text-model key is never substituted. Changing the form invalidates the result and cancels its active test. Leaving the form also cancels it. A lost response can be checked using the same request ID without starting another provider request; only an explicit new test starts a new generation.

Tests share the same serialized image queue as chat and avatar generation, plus the global inference gate when enabled. Network Deny blocks testing. The direct test action authorizes that single request under the other network modes; the separate bot image permission does not change this owner consent. Local cancellation cannot guarantee that the provider stops work it already accepted.

The test's generation timeout starts only after both local queues admit it. Waiting does not consume the budget, and a queued test can still be stopped. The image API does not report when its own internal queue ends, so the timeout after dispatch covers remote waiting, generation and image download.

### How a bot uses the model

Ask for an image in the room. A tool-capable language model can call `generate_image` with a prompt and optional size override. The tool returns a saved-image receipt to the model and attaches the actual image to the chat. It does not put a large base64 image into the next language-model request.

**Settings → Image generation model → Bot image generation** controls the bot's image tool separately from other network operations:

| Choice                                | Behavior                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Follow network permission (`inherit`) | Default, including older saved settings. Network Allow permits generation; Ask and Smart auto-approve require exact approval. |
| Allow without approval (`allow`)      | Generate images without an approval card, without granting other network operations.                                          |
| Ask every time (`ask`)                | Review the precise prompt, endpoint, model and size for each new image request.                                               |
| Deny (`deny`)                         | Block bot image generation.                                                                                                   |

Network Deny overrides all four choices. This setting applies only to bot tool calls; image-test and avatar Generate buttons retain direct owner consent. The permission can change during active work, while image connection settings and credentials remain pinned. Requests recheck the effective policy after queueing, and a newly stricter policy prevents dispatch. Changing to Allow does not automatically approve an already-pending card.

Saving an app-managed attachment does not write into the room's working folder. Use the attachment's download control for a separate copy.

The current text adapter receives image metadata. A successful tool result confirms that a supported raster file was generated and saved; it does not confirm that the language model inspected the composition, text or visual quality.

### Sharing hardware

Image requests from chat tools and the avatar editor share the same one-at-a-time image queue. With inference sharing enabled, an image also takes a global slot after approval or the user's direct Generate action. A global limit of 1 avoids simultaneous admitted image/text requests. A larger limit bounds the total but can permit overlap.

If image generation runs on independent hardware, disable sharing to permit image/text overlap. The image still uses its own one-at-a-time queue. Loom does not know the physical GPU topology or predict whether two loaded models fit; choose the setting to match the deployment.

### Character avatars

The eight bundled characters need no model connection. To generate another character, open **Bots → Profile**, enter an appearance description in the image panel, and choose **Generate**. This calls the configured image endpoint directly, without a language-model request. It uses the saved size, response format, timeout, credentials and inference-sharing option. Preview the result, select it, then save the bot profile to apply it.

The Generate action is direct consent for that request, so network Ask or Smart auto-approve does not add a second chat-tool approval card. The separate bot image permission does not change this action. Network Deny still blocks generation, and network permission is checked again after queueing. Only one avatar job can be active across the app; it shares image capacity with chat generation. Closing the editor leaves the server job running. Jobs and completed results persist, but cancelled, failed or interrupted jobs are never automatically regenerated. See [avatar usage and artwork](AVATARS.md) and the [avatar job API](API.md#avatar-generation-jobs).

### Persistence, keys and cancellation

PNG, JPEG and WebP outputs are saved in `generated-images` inside `LOOM_DATA_DIR`, capped at 20 MiB each. Chat and avatar-job records contain metadata, without provider URLs or base64. Clients derive authenticated same-origin `/api/images/:id` links to view images, or add `?download=1` for a download. Include image files in backups with SQLite, session data and `secret.key`.

The image key belongs to its configured URL origin, independently of the language-model key. An omitted key is retained only for the same scheme, host and port. Changing origin clears it unless a replacement is explicitly supplied. Keys are absent from API snapshots and are not forwarded to another origin when downloading a provider's image URL.

Completed exact tool operations are journaled. On resume, the same request restores its existing attachment to the new response without generating again. Failed, stopped or uncertain attempts are not automatically resubmitted. Check the remote server and start a new task if another attempt is appropriate. Aborting the client connection cannot guarantee that a remote engine stops computation it already accepted.

See [API.md](API.md) for field shapes and [VALIDATION.md](VALIDATION.md) for executed checks and their limits.
