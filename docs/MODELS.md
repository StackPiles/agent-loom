# Models, images and parallel inference

This guide describes Agent Loom 0.1.3. Loom connects to inference servers you operate or choose; it does not download models, launch a GPU engine, or change an engine's memory settings. See [installation](INSTALL.md) for the app and Docker networking.

## Three separate settings

| Setting            | What it controls                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Language model     | The streaming chat-completion endpoint, model, credentials, context/output limits and optional reasoning effort used by bot sessions. |
| Image model        | A separate Images endpoint, model and credential called by the language model's `generate_image` tool.                                |
| Inference capacity | How many eligible requests Loom may submit at once. It does not select the server's GPU batching algorithm.                           |

An app instance owns one data directory containing its rooms, bots and settings. A room's working folder controls its file tools and command execution. It does not select another application workspace or another model connection.

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

### What the inference server owns

Loom sends separate HTTP requests. Continuous batching, prefill/decode scheduling, prompt/KV caching, model loading and GPU kernels belong to the inference engine. For example, [llama.cpp's server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) describes its serving options. Configure and measure them on the engine; changing Loom's limit does not change them.

Start an evaluation at **2 requests**:

1. Verify that the engine accepts simultaneous requests and has suitable context/memory capacity.
2. Compare the same two independent tasks with Loom at 1 and at 2. For two bots in one room, also allow simultaneous responses in that room.
3. Compare time to first text, time for both tasks to finish, per-response speed, memory use and cancellation behavior.
4. Increase the limit only when those observations support it. Reduce it if the engine queues internally, runs out of memory or becomes less responsive.

Throughput and individual reply latency are different measurements. This release does not include a benchmark proving a particular speedup on DGX Spark, Mac Studio or a specific model.

## Image generation

Enable the separate image integration in Settings and supply:

| Field                    | Default / scope                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| API base URL             | Your image server's base, such as `http://IMAGE_SERVER:PORT/v1`; do not append `/images/generations` yourself. |
| Model ID                 | The identifier recognized by that image server.                                                                |
| API key                  | Optional, encrypted separately from the language-model key.                                                    |
| Size                     | `1024x1024`; alternatively `auto` or `WIDTHxHEIGHT`, 64–8,192 per side and at most 16,777,216 pixels.          |
| Response format          | Auto omits the legacy field. Explicit Base64 sends `response_format: b64_json`.                                |
| Timeout                  | 120 seconds initially; configurable from 10 to 1,800 seconds after queue admission.                            |
| Share inference capacity | Enabled initially. Images use the same global limit as text requests.                                          |

The server must implement **OpenAI-compatible `POST /images/generations`** and return `data[0].b64_json` or `data[0].url`. Native ComfyUI workflow submission, node mapping and workflow-result polling are not implemented. Use a compatible Images endpoint or a separately provided adapter.

Auto response format works with APIs that return base64 by default and reject the legacy `response_format` option. A compatible local server may require explicit Base64 instead. Check the server's protocol rather than relying on its product name; see the [OpenAI Images reference](https://developers.openai.com/api/reference/resources/images/methods/generate).

### How a bot uses the model

Ask for an image in the room. A tool-capable language model can call `generate_image` with a prompt and optional size override. The tool returns a saved-image receipt to the model and attaches the actual image to the chat. It does not put a large base64 image into the next language-model request.

Image generation follows the network permission. Allow permits it; Deny blocks it. Ask and Smart auto-approve request review of the precise prompt, endpoint, model and size. Saving an app-managed attachment does not write into the room's working folder. Use the attachment's download control for a separate copy.

The current text adapter receives image metadata. A successful tool result confirms that a supported raster file was generated and saved; it does not confirm that the language model inspected the composition, text or visual quality.

### Sharing hardware

Image requests always run one at a time. With inference sharing enabled, an image also takes a global slot after approval. A global limit of 1 avoids simultaneous admitted image/text requests. A larger limit bounds the total but can permit overlap.

If image generation runs on independent hardware, disable sharing to permit image/text overlap. The image still uses its own one-at-a-time queue. Loom does not know the physical GPU topology or predict whether two loaded models fit; choose the setting to match the deployment.

### Persistence, keys and cancellation

PNG, JPEG and WebP outputs are saved in `generated-images` inside `LOOM_DATA_DIR`, capped at 20 MiB each. Chat records contain metadata, without provider URLs or base64. Clients derive authenticated same-origin `/api/images/:id` links to view images, or add `?download=1` for a download. Include image files in backups with SQLite, session data and `secret.key`.

The image key belongs to its configured URL origin, independently of the language-model key. An omitted key is retained only for the same scheme, host and port. Changing origin clears it unless a replacement is explicitly supplied. Keys are absent from API snapshots and are not forwarded to another origin when downloading a provider's image URL.

Completed exact tool operations are journaled. On resume, the same request restores its existing attachment to the new response without generating again. Failed, stopped or uncertain attempts are not automatically resubmitted. Check the remote server and start a new task if another attempt is appropriate. Aborting the client connection cannot guarantee that a remote engine stops computation it already accepted.

See [API.md](API.md) for field shapes and [VALIDATION.md](VALIDATION.md) for executed checks and their limits.
