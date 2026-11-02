# Agent Loom API contract

All JSON requests use `Content-Type: application/json`. API errors: `{error:string,code?:string}` with non-2xx status. Successful writes return the updated resource or `{ok:true}`; a mail send also requires inspecting the returned draft status, because HTTP 200 can represent a failed or uncertain send. GET /api/state returns Snapshot (src/shared/types.ts). All writes produce SSE `snapshot` events. Frontend can refetch after mutations. /api/events is SSE with JSON ServerEvent records; `message_delta` streams answer text, `message_reasoning_delta` streams provider-reported reasoning, and `message_updated` applies a persisted message patch. Idempotent GETs; room and task data persist.

- GET /api/health -> {ok,version,configured,demoMode}
- GET /api/auth -> {required:boolean,authenticated:boolean}; POST /api/auth {token}; DELETE /api/auth.
- GET /api/state -> Snapshot
- GET /api/events -> SSE (`data: JSON.stringify(ServerEvent)`). EventSource with same-origin session cookie.
- PUT /api/settings accepts partial Settings. Keys are write-only; an explicit empty string clears a key. Omitted `model.apiKey` and `images.apiKey` retain their respective saved keys only when that integration's origin (scheme, host, port) is unchanged; changing origin clears its key unless a replacement is explicitly supplied. The image and language-model keys are separate encrypted secrets. An omitted `search.apiKey` retains its saved value. Responses never include raw keys. Changes to language/image execution settings or credentials return 409 during active tasks or avatar jobs. Text-model or credential changes also return 409 during active system-prompt jobs. Demo-mode changes through either settings or the dedicated demo route return 409 during active bot tasks or prompt jobs. Default-folder changes return 409 when an active room uses that default. An unchanged full form can still update permissions, automatic learning and global inference capacity.
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
- POST /api/automations {name,kind,roomId,botId,prompt,intervalMinutes?,sourceUrl?,enabled?,schedule?,mailAccountId?:string|null,imap?:{host,port,secure,user,mailbox,password?}}; PATCH /api/automations/:id; DELETE /api/automations/:id; POST /api/automations/:id/run -> Automation. Running may establish a baseline, detect no change, or coalesce existing work without creating a task. Source edits reset the relevant baseline while retaining the prior task ID for overlap prevention. Disabling an assigned bot, removing it from the destination room, or archiving that room pauses affected enabled rules.
- `kind:'schedule'` requires a complete `schedule` object: `type:'once'` with `dateTime:'YYYY-MM-DDTHH:mm'`, `type:'daily'` with `time:'HH:mm'`, or `type:'weekly'` with `time` and nonempty `weekdays` (Sunday 0–Saturday 6). All variants require `timeZone` (IANA/UTC) and `missedRunPolicy:'run_once'|'skip'`. Calendar fields are strictly validated. Runtime-owned `nextRunAt`, `lastRunAt` and once-only `scheduleStatus:'fired'|'missed'` are returned but cannot be set by callers. Run now consumes an unconsumed one-time reservation; a consumed one returns 409. A new future instant is required to rearm it. Recurring manual runs stay clock-anchored and do not enable disabled rules. See [scheduled wake-up semantics](SCHEDULES.md).
- `kind:'imap'` remains the wire value for incoming email and now also accepts a provider-neutral `mailAccountId`. The linked account can use IMAP/SMTP, AgentMail or Resend Inboxes. It must exist and be assigned to the selected bot; an enabled rule requires an enabled account. Use the link instead of inline `imap` settings. Setting `mailAccountId:null` clears the link and requires a legacy IMAP configuration when keeping kind `imap`. Changing kind clears mail connection fields. Disabling/disconnecting a linked account or unassigning its bot pauses affected rules; changing the connection source resets their mail checkpoints and pending batch. The mail account itself is independent of the rule and room.
- IMAP rules may be saved disabled without a password; enabling requires one. `imap.password` is write-only. An omitted password is retained only for the same host (case-insensitive), port, TLS setting and exact trimmed username. A different account/endpoint clears the prior credential unless a replacement is supplied. An explicit empty string clears it. Gmail's grouped app-password whitespace is normalized only for `imap.gmail.com:993` with TLS. Changing away from IMAP removes its saved password.
- POST /api/mail/test {automationId?,imap:{host,port,secure,user,mailbox,password?}} -> {ok:true,host,user,mailbox}. Authenticated owner action; network Deny blocks it, Ask/Auto/Allow accept the explicit test. Omitted credentials are reused only from the given IMAP rule with the same account/endpoint. The connection opens a mailbox read-only and disconnects; it never reads messages, mutates a rule/baseline, saves a credential or starts a task. At most one test runs at a time, with a 25-second transport deadline and bounded logout. Failures return {error,code} with 400 (invalid_configuration, credentials_required, authentication_failed, mailbox_unavailable, connection_failed, timeout), 403 (network_denied), or 409 (busy). Raw provider diagnostics and passwords are not returned.
- POST /api/automations/:id/webhook-key -> {token,path}; explicit token creation, only webhook automations. POST /api/hooks/:id with bearer token + {text,eventId?} -> {ok,duplicate,queued,task?}. `task` identifies an immediately created task; `queued:true` means the event was saved for a later coalesced batch. Repeated event IDs return `duplicate:true`.
- POST /api/notifications/read {id?:string} marks one or all read.
- GET /api/images/:id -> authenticated binary PNG/JPEG/WebP attachment. Append `?download=1` for `Content-Disposition: attachment`; otherwise the response is inline. Images use `X-Content-Type-Options: nosniff` and private/no-store caching. IDs have the form `img_` followed by 64 lowercase hexadecimal characters. The endpoint serves only indexed app-managed image files, not caller-supplied filesystem paths or provider URLs.

## External mail accounts

Mail account routes connect existing external mailboxes. They do not provision mail infrastructure, domains or provider accounts. All routes use owner authentication and the normal same-origin mutation checks. Canonical types are in `src/shared/mail-accounts.ts`; routes are in `src/server/account-routes.ts`.

`Snapshot.mailAccounts` contains public connection metadata; `Snapshot.serviceAccounts` contains public service registry metadata. Neither includes saved passwords, API keys or encrypted secret values. Email bodies and local drafts are fetched through the dedicated mail routes, not through those snapshot fields. The arrays are optional in the TypeScript shape for older clients/fixtures and are populated by the current server.

| Method and route                                   | Request                                                 | Response / behavior                                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mail/accounts`                           | None                                                    | `MailAccount[]`, including disabled connections.                                                                                                                                                                                 |
| `GET /api/mail/accounts/:id`                       | None                                                    | One public `MailAccount`; 404 if missing.                                                                                                                                                                                        |
| `POST /api/mail/accounts`                          | `MailAccountInput` without `expectedRevision`           | Saves a local connection; does not create a provider mailbox or test credentials.                                                                                                                                                |
| `PUT /api/mail/accounts/:id`                       | Full `MailAccountInput` with current `expectedRevision` | Returns the updated account; a stale revision returns 409. This is replacement configuration, not a partial PATCH.                                                                                                               |
| `DELETE /api/mail/accounts/:id?expectedRevision=N` | None                                                    | Disconnects locally, clears credentials, pauses linked rules and detaches linked service records. Keeps the provider mailbox and local draft/send audit records. The optional revision guards the connection the owner reviewed. |
| `POST /api/mail/accounts/test`                     | `{input:MailAccountInput,existingId?:string}`           | Tests unsaved settings without saving or sending; returns `{ok:true,provider,address,receive:true,send:boolean}`.                                                                                                                |

```ts
interface MailAccountInput {
  name: string;
  address: string;
  provider: 'imap' | 'agentmail' | 'resend';
  enabled?: boolean; // default true
  botIds?: string[]; // default []
  sendPolicy?: 'ask' | 'allow' | 'deny'; // default ask
  imap?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    mailbox: string;
    password?: string;
  };
  smtp?: { host: string; port: number; secure: boolean; user: string; password?: string };
  api?: { inboxId: string; apiKey?: string };
  expectedRevision?: number; // mandatory for PUT, omitted for create
}
```

For provider `imap`, supply `imap` and optionally `smtp`, with no `api`. For `agentmail` or `resend`, supply `api`, with no IMAP/SMTP configuration. API providers use their fixed official endpoints. The configured address must match the selected API inbox. Resend requires an existing **Inbox**; a sending-only domain is insufficient. `secure:true` uses TLS on connection; `secure:false` requires STARTTLS and never permits clear-text authentication. Account names allow 160 characters, addresses 254, endpoint hosts/users and mailbox names 250, inbox IDs 500, and credentials 4,096. Ports must be integers 1–65,535. `botIds` contains at most 100 existing bot IDs.

Credentials are write-only. On an update, an omitted password is retained only for the same provider/address and that endpoint's host, port, TLS setting and username; IMAP and SMTP credentials are independent. An omitted API key is retained only for the same provider/address/inbox ID. Identity changes clear an omitted credential; an explicit empty string clears it, and an explicit replacement is scoped to the new identity. Public responses substitute `passwordConfigured` / `apiKeyConfigured` and add `id`, `revision`, timestamps and optional safe `lastSyncAt` / `lastError` metadata. Do not copy those response-only fields into an input body. Service credentials use the separate rules below.

An unsaved test can reuse credentials only by supplying `existingId` and matching their identity. If `input.expectedRevision` is supplied, it must match that account. Tests with no `existingId` cannot reuse stored secrets. Testing IMAP opens the mailbox read-only and optionally verifies SMTP authentication; API tests verify inbox identity/access. `send:true` describes configured sending support, not proof of successful delivery or every provider-side sending permission. Network Deny blocks tests and remote mailbox operations. Account edits/disconnection return 409 while that connection has active remote operations.

### Messages and locators

| Method and route                                 | Query / response                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mail/accounts/:id/messages`            | Optional `query` (up to 256 characters), `limit` (integer 1–50, default 20), and `cursor`. Returns `{messages:MailMessageSummary[],nextCursor?:string}`. |
| `GET /api/mail/accounts/:id/messages/:messageId` | Returns `MailMessage`: a summary plus bounded plain-text `text`, `truncated`, optional `replyTo`, `references`, and attachment metadata.                 |

Message summaries have `id`, `accountId`, `folder`, `subject`, `from`, `to`, optional `cc`, `date`, and optional `preview`, `unread`, `messageId` and `threadId`. Address fields are arrays of `{address,name?}`. The top-level `id` is the opaque Loom locator; the optional `messageId` is a mail header/provider identifier and is not a substitute. Pass locators and cursors back unchanged, URL-encode route/query values, and keep each scoped to its original account and source settings. Their maximum length is 24,000 characters; ordinary account/draft/service IDs are limited to 160. After a source change, discard old locators/cursors and list again. A thread read can return a concrete message locator different from the thread-list locator; use the detail response's `id` when drafting a reply.

Mailbox reads do not send mail or change read flags. Message bodies are limited to 65,536 characters, with truncation indicated; oversized source messages or provider responses can instead fail safely. Attachment entries contain `filename`, `contentType` and `size`, not file data or download URLs. Email is untrusted content: render the text as text, and do not execute HTML or load tracking resources. The API has no mailbox delete/archive/mark-read endpoint or attachment-upload route.

### Drafts, review and sending

| Method and route                     | Request                                                                      | Response / behavior                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/mail/drafts?accountId=...` | Optional account filter                                                      | Newest 200 local `MailDraft` records, including terminal attempts. This is not the provider's Drafts/Sent folder. |
| `GET /api/mail/drafts/:id`           | None                                                                         | One persisted draft or send record, including records retained after disconnection.                               |
| `POST /api/mail/drafts`              | `MailDraftInput` without `expectedRevision`                                  | Creates an unsent local draft; no provider call.                                                                  |
| `PUT /api/mail/drafts/:id`           | Full `MailDraftInput` with current `expectedRevision`                        | Updates only an unchanged `draft`; preserves the account ID. Other states are immutable.                          |
| `POST /api/mail/drafts/:id/send`     | `{requestId:string,expectedRevision:number,expectedAccountRevision?:number}` | Returns the updated `MailDraft`; inspect `status` even for HTTP 200.                                              |

```ts
interface MailDraftInput {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  replyToMessageId?: string; // concrete detail response's opaque id
  expectedRevision?: number;
}
```

Recipients are bare email addresses, not display-name strings; at least one To address is required and To/Cc/Bcc together may contain at most 50 addresses. Subject is a single line of at most 998 characters; text is at most 65,536 characters. The sender is derived from the connected account, never supplied by the caller. A saved draft records `from`, `accountRevision`, its own `revision`, `status`, timestamps, and optional originating `botId`; send results may add `requestId`, `providerMessageId`, `sentAt` or a safe error. Editing a draft increments its revision and binds it to the current account revision.

Review the persisted sender, all recipients, subject and text before sending. `requestId` must be a UUID that identifies one send attempt. `expectedRevision` must match the exact reviewed draft; supply `expectedAccountRevision` to bind the owner review explicitly as well. The server always checks the draft's stored account revision against the current account. Account or draft changes invalidate the earlier review. The direct owner send endpoint treats the concrete reviewed submission as consent; bot sends separately enforce their account's `ask` policy through an exact approval card. `sendPolicy:'deny'`, a disabled/disconnected account, missing SMTP configuration, or Network Deny prevent sending.

| Draft status | Required client behavior                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`      | Unsent and editable. Save the exact desired revision before review/send.                                                                                                      |
| `sending`    | A durable attempt is in progress. Do not start another send. Read its state.                                                                                                  |
| `sent`       | The provider accepted submission. Delivery and reading are not confirmed.                                                                                                     |
| `failed`     | The attempt failed without an uncertain delivery result. It remains a terminal audit record; any new attempt requires an explicitly created, reviewed new draft.              |
| `unknown`    | The provider may have accepted the email. Never automatically resend or convert this record back to a draft; inspect the provider history before deciding on another message. |

HTTP 200 with `failed` or `unknown` is a handled send outcome, not a successful delivery. Preflight validation/policy errors use non-2xx statuses. Repeating a request UUID after it has settled returns the same attempt's current record without dispatching again; conflicting draft/revision reuse is rejected and a still-running attempt can return 409. Changing only the UUID cannot resend a terminal draft. A lost HTTP response, cancellation, or restart does not establish that dispatch was prevented. Interrupted `sending` records become `unknown` on startup. Use the read endpoints to reconcile; there is no automatic send retry or retry endpoint. SMTP submission does not append a copy to the provider's Sent folder; Loom keeps its own send history.

Mail errors expose stable, sanitized codes where available: `invalid_configuration`, `invalid_request`, `credentials_required`, `authentication_failed`, `connection_failed`, `mailbox_unavailable`, `provider_mismatch`, `message_too_large`, `account_disabled`, `account_unassigned`, `network_denied`, `send_disabled`, `not_found`, `stale_revision`, `busy`, `timeout`, `cancelled`, `send_uncertain`, and `rate_limited`. Raw provider diagnostics and credentials are not exposed. Common status mappings are 400 validation/provider errors, 403 permission/disabled-account errors, 404 missing records, 409 stale/busy/uncertain conflicts, 429 rate limits and 504 timeouts. The send result's terminal status takes precedence over assuming success from an HTTP code.

## Service account registry

Service records describe externally managed identities. These endpoints do not sign up for services, log in, provision a mailbox, buy anything, inject credentials into Chrome, or create per-bot browser profiles.

| Method and route                                      | Request / behavior                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/service-accounts`                           | Returns public `ServiceAccount[]`.                                                                                                                      |
| `GET /api/service-accounts/:id`                       | Returns one public record; 404 if missing.                                                                                                              |
| `POST /api/service-accounts`                          | Full `ServiceAccountInput`, without `expectedRevision`.                                                                                                 |
| `PUT /api/service-accounts/:id`                       | Full input with current `expectedRevision`; stale versions return 409.                                                                                  |
| `DELETE /api/service-accounts/:id?expectedRevision=N` | Removes only the local registry entry and its credential. The optional revision guards the owner's reviewed record. External accounts remain unchanged. |

```ts
interface ServiceAccountInput {
  name: string;
  url: string;
  login: string;
  botId: string | null;
  mailAccountId: string | null;
  status: 'active' | 'pending' | 'disabled';
  notes: string;
  credential?: string; // write-only
  expectedRevision?: number;
}
```

Names allow 160 characters, URLs 2,000, logins 320, notes 8,000 and credentials 16,384. URLs must use HTTP(S), without embedded credentials or credential-like query parameters. The chosen bot and mailbox must exist; when both are set, the mailbox must already be assigned to that bot. `status` is owner/bot-maintained registry metadata, not proof of a live external login.

An omitted `credential` retains the saved value only when the service URL's origin and login are unchanged. Changing that identity clears it unless an explicit replacement is supplied; an empty string clears it. Credentials are encrypted separately and never returned. Public `ServiceAccount` responses contain the nonsecret fields plus `id`, `credentialConfigured`, `revision`, `createdAt` and `updatedAt`. Keep secrets out of URLs, login names and notes. Bot tools list only assigned metadata and require approval for registry changes; they cannot retrieve or write the dedicated credential through those tools.

## Chrome control

`Settings.browser` accepts partial updates through `PUT /api/settings`:

```ts
interface BrowserSettings {
  enabled: boolean; // default false
  mode: 'existing' | 'dedicated'; // default existing
  permission: 'auto' | 'ask' | 'allow' | 'deny'; // default auto
  includeScreenshotsInModel: boolean; // default false
}
```

Omitted browser fields retain their saved values; old installations receive defaults without connecting. A mode change requires disconnection and no active bot tasks. Changing screenshot model input also requires no active bot tasks. These conflicts return 409 before saving. Permission and enabled changes remain available during tasks; disabling or denying disconnects immediately.

| Method and route              | Behavior                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/browser`            | Returns cached `BrowserStatus`. Never connects Chrome or calls a model.                                          |
| `POST /api/browser/connect`   | Explicitly connects using saved settings, then returns status. Connection errors return 400 with setup guidance. |
| `DELETE /api/browser/connect` | Cancels pending connection/work, disconnects, pauses implicit reconnection and returns status.                   |

`BrowserStatus` has `state: 'disconnected' | 'connecting' | 'connected' | 'error'`, `mode`, `platform`, `busy`, `tabs: {pageId:number,url:string,title?:string,protected?:boolean}[]`, and optional `error`. A status poll uses the last observed tab list; a bot's `tabs` operation refreshes it. All routes use normal authentication and same-origin mutation checks. There is no HTTP route for directly executing browser commands.

The Pi `browser_use` tool accepts `operation: 'tabs' | 'open' | 'navigate' | 'snapshot' | 'click' | 'fill' | 'press_key' | 'scroll' | 'hover' | 'screenshot' | 'close' | 'dialog'` plus operation-specific `pageId`, `url`, `stateId`, `uid`, `text`, `key`, `direction` or `accept`. Mutations of existing tabs require the latest snapshot's opaque state ID; element operations also require its UID. Plans and approvals are bound to the current connection, URL and observed target. Repeated mutations use the task's operation journal; failed/uncertain records are not automatically retried.

Browser permission is independent of `permissions.network`. Auto permits only `tabs`, `snapshot` and `screenshot`. Screenshots are persisted as indexed `GeneratedImage` chat attachments and served by the existing authenticated image route. Image blocks are returned to Pi only with explicit screenshot model input enabled; text-only mode returns attachment metadata and snapshot guidance. See [Chrome behavior and limits](BROWSER.md).

## Bot avatars

`Bot.avatar` remains a string. POST/PATCH bot requests accept these forms:

| Form                  | Example                                                      | Meaning                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled character     | `character:aster`                                            | One of `character:aster`, `character:nova`, `character:orbit`, `character:moss`, `character:luna`, `character:pip`, `character:sage`, or `character:bram`; rendered from bundled `/avatars/*.webp` files. |
| Generated image       | `image:img_` followed by 64 lowercase hexadecimal characters | References an existing indexed `GeneratedImage`; resolves to authenticated `/api/images/:id`. The referenced metadata must exist in the app's image index.                                                |
| Legacy icon or symbol | `sparkles`, `compass`, `🌿`                                  | Preserves short legacy values, up to 40 characters, excluding control characters and URL/path/markup delimiters.                                                                                          |

The outer field limit is 80 characters. Arbitrary remote URLs, data URLs, filesystem paths and SVG/HTML markup are not accepted as avatar references. Bot PATCH retains its normal active-task guard. Creating or selecting an image does not update a bot automatically: apply it with the ordinary bot POST/PATCH, for example `{ "avatar": "image:img_<64 lowercase hex characters>" }` using a real returned image ID.

New installs seed Aster and Nova with their corresponding characters. An upgrade replaces only their original `sparkles`/`compass` choices once. Customized avatars and deleted bots are preserved, and choosing an original icon again after migration survives later restarts. See [avatar usage and bundled artwork](AVATARS.md).

## System-prompt generation jobs

These authenticated jobs call the configured text model directly without a bot task, room session, tool calls or automatic profile changes. They share the global inference gate; only one prompt job may be queued/generating across the app. Demo mode rejects generation with 400.

| Method and route                     | Request                                                      | Response / behavior                                                                                           |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/prompt-generations`       | `{requestId,name?,role?,instructions,currentPrompt?,locale}` | `PromptGeneration`; 202 while queued/generating, 200 for settled idempotent replay.                           |
| `GET /api/prompt-generations`        | None                                                         | Newest 20 persisted jobs, including partial output and terminal errors.                                       |
| `GET /api/prompt-generations/:id`    | None                                                         | One persisted job; 404 if absent.                                                                             |
| `DELETE /api/prompt-generations/:id` | None                                                         | Cancel a queued/active job and return its final record; settled jobs stay unchanged. Does not delete history. |

IDs are lowercase-normalized UUIDs. `name` and `role` default to an empty string and allow up to 160 characters each; `instructions` is trimmed and must contain 1–6,000 characters; optional `currentPrompt` is trimmed and limited to 32,000 characters. `locale` must be `ja` or `en`. Identical normalized content with the same ID reuses the job; different content returns 409. Empty and omitted current prompts are equivalent. There are no per-request endpoint, credential or model overrides.

```ts
interface PromptGenerationRequest {
  name: string;
  role: string;
  instructions: string;
  currentPrompt?: string;
  locale: 'ja' | 'en';
}
interface PromptGeneration {
  id: string;
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  request: PromptGenerationRequest;
  output: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

`output` contains bounded partial text while generating and an editable candidate when completed. Only completed results are applicable in the UI. The model never writes a bot profile; normal bot POST/PATCH applies the user's final edited text. Requests use at most `min(model.maxOutputTokens, 4096)` tokens and final prompts at most 32,000 characters. Input/context validation is conservative and rejects rather than truncates. A ten-minute generation deadline starts after acquiring capacity. Cancelled/failed/interrupted requests are never automatically repeated; explicitly create a new UUID to try again. Closing the editor does not cancel a server job. See [model behavior](MODELS.md#system-prompt-assistance).

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
