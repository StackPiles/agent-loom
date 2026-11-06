# Agent Loom API contract

All JSON requests use `Content-Type: application/json`. API errors: `{error:string,code?:string}` with non-2xx status. Successful writes return the updated resource or `{ok:true}`; a mail send also requires inspecting the returned draft status, because HTTP 200 can represent a failed or uncertain send. GET /api/state returns Snapshot (src/shared/types.ts). All writes produce SSE `snapshot` events. Frontend can refetch after mutations. /api/events is SSE with JSON ServerEvent records; `message_delta` streams answer text, `message_reasoning_delta` streams provider-reported reasoning, and `message_updated` applies a persisted message patch. Idempotent GETs; room and task data persist.

- GET /api/health -> {ok,version,configured,demoMode}
- GET /api/auth -> {required:boolean,authenticated:boolean}; POST /api/auth {token}; DELETE /api/auth.
- GET /api/state -> Snapshot
- GET /api/events -> SSE (`data: JSON.stringify(ServerEvent)`). EventSource with same-origin session cookie.
- PUT /api/settings accepts partial Settings. Keys are write-only; an explicit empty string clears a key. Omitted `model.apiKey` and `images.apiKey` retain their respective saved keys only when that integration's origin (scheme, host, port) is unchanged; changing origin clears its key unless a replacement is explicitly supplied. The image and language-model keys are separate encrypted secrets. An omitted `search.apiKey` retains its saved value. Responses never include raw keys. Changes to language/image execution settings or credentials return 409 during active tasks or avatar jobs, except for the fully paused bot-task image changes described below. Text-model or credential changes also return 409 during active system-prompt jobs. Demo-mode changes through either settings or the dedicated demo route return 409 during active bot tasks or prompt jobs. Default-folder changes return 409 when an active room uses that default. An unchanged full form can still update permissions, automatic learning and global inference capacity.
- Model token limits are integers: `contextWindow` 2,048–2,097,152 and `maxOutputTokens` 128–1,048,576, with output strictly smaller than context. The API does not require powers of two. `reasoningMode:'server'|'openai'` defaults to `server`. `reasoningEffort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`, and defaults to `medium` in explicit mode. Server mode omits `reasoning_effort`; explicit mode sends the selected literal value without a silent downgrade. The endpoint must support it.
- `model.responseTimeoutSeconds` and `model.idleTimeoutSeconds` are optional integers from 10 to 86,400, defaulting to 1,800 and 300 respectively. The response budget begins after local inference admission and ends at the first actual text, reasoning or tool-call output. The idle budget then resets on new output. Headers and keepalives do not count as output. Queued work uses neither budget; there is no total-duration cutoff while output continues. Both settings apply to chat, compaction and system-prompt assistance, and changing their effective values is blocked while model work is active.
- `model.imageInput` is an optional Boolean for image input to the configured conversation model. New installations default to `false`; legacy settings without the field inherit `browser.includeScreenshotsInModel`, or `false` if that is absent. An explicit value takes precedence, independently of whether Chrome is enabled. Settings responses expose the effective Boolean, and omitted updates retain it. Changing its effective value returns 409 while any active bot task is still executing or not in a paused room, or while a system-prompt/avatar job is active. Queued tasks in paused rooms and runtime-confirmed suspended tasks permit this flag change; rooms remain paused and resumed dispatch uses the new value. Enable it only for an endpoint/model that accepts image inputs; the setting does not install or discover vision support. See [image viewing](#image-viewing).
- `inference.maxConcurrentRequests` is an integer from 1 through 16, default 1. This setting can change during active work. Increases admit eligible waiters; reductions leave active requests running and delay new ones until capacity is available.
- `images` accepts the fields listed below. The image connection is optional and disabled by default; enabling it requires a base URL and model ID. `images.apiKeyConfigured` is read-only response metadata. Bot-only `images.permission` changes remain available during active work. All other image settings and credentials can change when every active bot task is queued in a paused room or runtime-confirmed suspended there, provided no avatar job is active. Draining work or any active room keeps those settings locked. See [image settings and tool protocol](#image-settings-and-tool-protocol).
- `permissions.shell`, `permissions.fileWrite`, and `permissions.network` accept `ask`, `auto`, `allow`, or `deny`. `auto` applies the exact-operation policy and falls back to an approval request for operations outside its automatic set. Omitted categories keep their saved values.
- POST /api/settings/test {baseUrl,modelId?,apiKey?} -> {ok,models:string[],message:string}; read-only model discovery, no paid generation. An omitted key reuses the saved model key only for the saved origin. Testing another origin does not forward that key or change saved settings.
- POST /api/demo {enabled:boolean} -> Settings; explicit simulated mode, all answers labeled by UI; does not contact LLM.
- POST /api/bots {name,handle,role,systemPrompt,color,avatar,enabled?}; PATCH /api/bots/:id; DELETE /api/bots/:id (reject while tasks active). `all` is reserved for room broadcasts and cannot be assigned to a new or renamed bot. A legacy bot with that handle is retained and may be edited without changing its handle; rename it for unambiguous inline addressing.
- POST /api/rooms {name,description?,botIds,workspacePath?:string|null,parallelResponses?:boolean}; PATCH /api/rooms/:id {name?,description?,botIds?,workspacePath?:string|null,parallelResponses?,pinned?,archived?}. A path sets the room override; null resets to the global default. `parallelResponses` defaults to false and controls overlapping response requests from different bots in this room. A changed effective directory or parallel-response policy returns 409 while the room has active tasks. The same bot × room session remains exclusive regardless of this flag.
- GET /api/workspace-picker -> {available:boolean,platform:string,reason?:'remote'|'headless'|'unsupported'|'disabled',message?:string}; capability check without opening a dialog.
- POST /api/workspace-picker {initialPath?:string} -> {path:string|null}; opens a native folder chooser only for local, unforwarded loopback access on a supported desktop. Cancellation returns null. Selection does not save the room/settings form. Existing authentication and same-origin checks apply.
- POST /api/rooms/:id/messages {body,botIds?:string[]} -> {message,tasks}; @handles are resolved server-side, case-insensitively. `@all` addresses every enabled member of this room exactly once, including when mixed with repeated or individual mentions; longer handles such as `@allison` are not broadcasts. A nonempty explicit `botIds` list takes precedence and is deduplicated and validated. Without matching mentions or explicit recipients, the first enabled member responds. Queue admission remains atomic for all recipients. Client should POST once and not invent bot responses.
- POST /api/tasks/:id/stop; POST /api/tasks/:id/resume -> Task. Stop cancels pending approvals; explicit resume preserves the operation record and pinned workspace. Resume returns 409 if the room now uses a different folder; restore the prior folder or create a new task.
- POST /api/tasks/stop-all -> {ok:true}.
- POST /api/approvals/:id {decision:'approve'|'deny'} -> Approval.
- POST /api/skills {name,description,content,botId?:string|null,roomId?:string|null,locked?:boolean,evidence?,reason?,sourceTaskId?} -> owner-created Skill candidate, fixed by default.
- PATCH /api/skills/:id {baseVersion:number,name?,description?,content?,status?:'candidate'|'active'|'archived',botId?,roomId?,locked?,evidence?,reason?,sourceTaskId?}; POST /api/skills/:id/restore {version:number,baseVersion:number}; GET /api/skills/:id/export -> text/markdown, including metadata.version.
- POST /api/memories {content,botId?:string|null,roomId?:string|null,locked?:boolean,evidence?,reason?,sourceTaskId?} -> Memory, fixed by default. PATCH /api/memories/:id {baseVersion:number,content?,botId?,roomId?,locked?,status?:'active'|'archived',evidence?,reason?,sourceTaskId?}; POST /api/memories/:id/restore {version:number,baseVersion:number}.
- POST /api/automations {name,kind,roomId,botId,prompt,intervalMinutes?,sourceUrl?,enabled?,schedule?,mailAccountId?:string|null,imap?:{host,port,secure,user,mailbox,password?}}; PATCH /api/automations/:id; DELETE /api/automations/:id; POST /api/automations/:id/run -> Automation. Running may establish a baseline, detect no change, or coalesce existing work without creating a task. Source edits reset the relevant baseline while retaining the prior task ID for overlap prevention. Disabling an assigned bot, removing it from the destination room, or archiving that room pauses affected enabled rules.
- `kind:'schedule'` requires a complete `schedule` object: `type:'once'` with `dateTime:'YYYY-MM-DDTHH:mm'`, `type:'daily'` with `time:'HH:mm'`, or `type:'weekly'` with `time` and nonempty `weekdays` (Sunday 0–Saturday 6). All variants require `timeZone` (IANA/UTC) and `missedRunPolicy:'run_once'|'skip'`. Calendar fields are strictly validated. Runtime-owned `nextRunAt`, `lastRunAt` and once-only `scheduleStatus:'fired'|'missed'` are returned but cannot be set by callers. Run now consumes an unconsumed one-time reservation; a consumed one returns 409. A new future instant is required to rearm it. Recurring manual runs stay clock-anchored and do not enable disabled rules. See [scheduled wake-up semantics](SCHEDULES.md).
- `kind:'imap'` remains the wire value for incoming email and now also accepts a provider-neutral `mailAccountId`. The linked account can use IMAP/SMTP, AgentMail or Resend Inboxes. It must exist and be assigned to the selected bot; an enabled rule requires an enabled account. Use the link instead of inline `imap` settings. Setting `mailAccountId:null` clears the link and requires a legacy IMAP configuration when keeping kind `imap`. Changing kind clears mail connection fields. Disabling/disconnecting a linked account or unassigning its bot pauses affected rules; changing the connection source resets their mail checkpoints and pending batch. The mail account itself is independent of the rule and room.
- IMAP rules may be saved disabled without a password; enabling requires one. `imap.password` is write-only. An omitted password is retained only for the same host (case-insensitive), port, TLS setting and exact trimmed username. A different account/endpoint clears the prior credential unless a replacement is supplied. An explicit empty string clears it. Gmail's grouped app-password whitespace is normalized only for `imap.gmail.com:993` with TLS. Changing away from IMAP removes its saved password.
- POST /api/mail/test {automationId?,imap:{host,port,secure,user,mailbox,password?}} -> {ok:true,host,user,mailbox}. Authenticated owner action; network Deny blocks it, Ask/Auto/Allow accept the explicit test. Omitted credentials are reused only from the given IMAP rule with the same account/endpoint. The connection opens a mailbox read-only and disconnects; it never reads messages, mutates a rule/baseline, saves a credential or starts a task. At most one test runs at a time, with a 25-second transport deadline and bounded logout. Failures return {error,code} with 400 (invalid_configuration, credentials_required, authentication_failed, mailbox_unavailable, connection_failed, timeout), 403 (network_denied), or 409 (busy). Raw provider diagnostics and passwords are not returned.
- POST /api/automations/:id/webhook-key -> {token,path}; explicit token creation, only webhook automations. POST /api/hooks/:id with bearer token + {text,eventId?} -> {ok,duplicate,queued,task?}. `task` identifies an immediately created task; `queued:true` means the event was saved for a later coalesced batch. Repeated event IDs return `duplicate:true`.
- POST /api/notifications/read {id?:string} marks one or all read.
- POST /api/notifications/:id/reply {body:string,requestId:string} posts one owner reply to the recorded sender in the originating room; see [notification senders and replies](#notification-senders-and-replies).
- GET /api/images/:id -> authenticated binary PNG/JPEG/WebP attachment. Append `?download=1` for `Content-Disposition: attachment`; otherwise the response is inline. Images use `X-Content-Type-Options: nosniff` and private/no-store caching. IDs have the form `img_` followed by 64 lowercase hexadecimal characters. The endpoint serves only indexed app-managed image files, not caller-supplied filesystem paths or provider URLs.

## Notification senders and replies

New `Notification` records include `sender: {kind:'bot',botId,name,handle} | {kind:'system'}`. Bot identities are supplied by the runtime's actual task and resolved by the controller, with the name and handle saved at sending time. `send_user_message` also records its exact `messageId`; standalone `notify_user` has no chat message. Notification deduplication includes source identities, so equal text from different bots is not collapsed. Missing `sender` remains legacy data: a valid same-room task can identify the responsible bot, and absent or contradictory provenance is never inferred from a title, mention or room member order.

`POST /api/notifications/:id/reply` uses a strict body `{body:string,requestId:string}`. The trimmed reply must contain 1–32,000 characters, and `requestId` is a UUID retained by the client for the same submission. The server resolves exactly one recipient from the notification, verifies the current bot and room, and applies the normal model, maintenance and queue admission checks. Explicit system notices, unknown senders, deleted/disabled/nonmember bots, unavailable/archived rooms and inconsistent source links cannot be replied to. Clients cannot supply a bot or room, and mentions in `body` do not add recipients.

Acceptance commits one user `Message`, one new root `chat` task, the read state and a reply receipt together. It returns `{message,tasks:[task],notification,duplicate:boolean}`. The same notice/request ID/body returns the saved result without creating more work, including after restart; reusing the request ID with different text returns 409. Failed admission leaves the notice unread and creates no partial reply. A paused room accepts the task into its held queue; replying does not resume the room or the original task.

The reply message and task both store `notificationReply: {notificationId,roomId,botId,senderName,senderHandle,title,body,createdAt,messageId?,taskId?}`. This is the original notification's quoted context, with a valid linked user-directed bot message used when available and a 12,000-character source limit. It remains available when the original item falls outside recent room history. The current user reply remains `Message.body` / `Task.prompt`; the original bot content does not become a user instruction or grant new permissions. Existing records may omit the new fields, and deleted historical source links remain historical rather than being replaced by another identity.

## Versioned learning records

From v0.8.0, all mutations of an existing memory or skill require the integer `baseVersion` returned by the snapshot. Missing/invalid versions return 400; a stale version returns 409 without changing the record. Read the current item and reconcile deliberately before retrying. Unknown input fields are rejected. Bot identity/authority is never accepted from owner-route JSON.

Both kinds support `botId:null` for shared records and `roomId:null` for all rooms. When creating a record or changing its scope, a non-null bot must exist and a room-scoped bot record must target a room that includes the bot. Existing orphaned records remain owner-maintainable without changing their scope. Owner-created records default to `locked:true`. Owners can edit fixed records or change their scope and fixed state. New bot-created skills are active and unlocked through the internal runtime capability; the owner POST route continues to create candidates, and existing candidates are not automatically activated.

Every real change increments `version` and retains the previous content in `revisions`. New revision metadata includes `actor`, `reason`, `evidence`, `sourceTaskId` when known, and scope/status/lock fields. Legacy revisions can omit information that was never recorded. Restoring content creates a new revision while preserving current `botId`, `roomId`, `locked`, and `status`.

- `DELETE /api/memories/:id {baseVersion:number}` archives the memory and returns `{ok:true,memory}`. It no longer physically removes its history. `PATCH` with `status:'archived'` is the explicit equivalent; an owner can reactivate with `status:'active'` and the current `baseVersion`.
- `POST /api/memories/merge {targetId,baseVersion,content,sources:[{id,baseVersion}],reason,evidence?,sourceTaskId?}` updates the target and archives the distinct sources in one transaction. The records must be active and share the same bot/room scope. Invalid ownership, scope, versions or sources reject the whole merge. Runtime bots also require every participant to be unlocked and owned by that bot.
- `Task.skillUses` stores the full snapshot first read by that task: `id`, `version`, `name`, `description`, `content`, `botId`, `roomId`, and `readAt`. It survives pause/restart and data transfer. Subsequent reads use the saved version after checking that the current skill is still active and visible. New tasks use the current version.

Runtime learning tools include `search_memories`, `read_memory`, `save_memory`, `archive_memory`, `merge_memories`, `search_skills`, `inspect_skill`, `propose_skill`, `update_skill`, and `read_skill`. Search is scoped text search with pagination; inactive records require an explicit maintenance option. `inspect_skill` reads the latest record without changing the execution version. Mutations require reasons and observed evidence. The runtime supplies the actual bot, room and source task; models cannot select another owner, unfix a record, grant permissions, or reactivate an archived record. See [learning maintenance](LEARNING.md).

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

An unsaved test can reuse credentials only by supplying `existingId` and matching their identity. If `input.expectedRevision` is supplied, it must match that account. Tests with no `existingId` cannot reuse stored secrets. Testing IMAP verifies mailbox access, recovers and validates missing UID metadata with STATUS if needed, and optionally verifies SMTP authentication. Identified Courier servers may first receive SELECT to initialize their mailbox namespace, followed by EXAMINE before any message retrieval; this can consume the transient Recent flag, but does not mark messages read, move or delete them; API tests verify inbox identity/access. `send:true` describes configured sending support, not proof of successful delivery or every provider-side sending permission. Network Deny blocks tests and remote mailbox operations. Account edits/disconnection return 409 while that connection has active remote operations.

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

Mail errors expose stable, sanitized codes where available: `invalid_configuration`, `invalid_request`, `credentials_required`, `authentication_failed`, `connection_failed`, `dns_failed`, `connection_refused`, `tls_failed`, `search_failed`, `message_fetch_failed`, `mailbox_unavailable`, `mailbox_metadata_unavailable`, `mailbox_identity_changed`, `provider_mismatch`, `message_too_large`, `account_disabled`, `account_unassigned`, `network_denied`, `send_disabled`, `not_found`, `stale_revision`, `busy`, `timeout`, `cancelled`, `send_uncertain`, and `rate_limited`. Known IMAP/SMTP failures also include optional `connectionStage: "imap" | "smtp"`; the browser uses it to identify receiving or sending. Classification reads structured transport error codes rather than parsing provider text; unknown causes retain `connection_failed`. `search_failed` means the mailbox opened but an IMAP search returned a failure; this is distinct from a connection or TLS failure. `mailbox_metadata_unavailable` means a selected mailbox still has missing, invalid or conflicting message-numbering/identity metadata after a bounded recovery attempt; no UID search or cursor advancement follows it. `message_fetch_failed` means the requested message UID was returned but usable message size or body data was missing; a genuinely absent UID remains `not_found`, and an excessive advertised or returned size remains `message_too_large`. `mailbox_identity_changed` is a 409 conflict when a message locator belongs to an older UIDVALIDITY namespace; reload the list. The UIDVALIDITY comparison is never bypassed. A service-wide timeout may have no stage. Raw provider diagnostics and credentials are not exposed. Common status mappings are 400 validation/provider errors, 403 permission/disabled-account errors, 404 missing records, 409 stale/busy/uncertain conflicts, 429 rate limits and 504 timeouts. The send result's terminal status takes precedence over assuming success from an HTTP code.

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
  includeScreenshotsInModel: boolean; // default false; include pixels immediately on capture
  maxConcurrentBrowsers?: number; // default 3, range 1–16
}
```

`Bot.browser?: { mode: 'dedicated' | 'shared' | 'disabled' }` selects the bot's browser. New bots default to dedicated; a missing choice on existing bots means shared. A bot mode change requires its active tasks to finish or be cancelled. Dedicated profiles are keyed by immutable bot ID, not the displayed name or tool arguments.

Omitted browser fields retain their saved values; old installations receive defaults without connecting. A mode change requires disconnection and no active bot tasks. Changing capture-time screenshot inclusion also requires no active bot tasks. These conflicts return 409 before saving. Permission and enabled changes remain available during tasks; disabling or denying disconnects immediately.

| Method and route              | Behavior                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/browser`            | Returns cached `BrowserStatus`. Never connects Chrome or calls a model.                                          |
| `POST /api/browser/connect`   | Explicitly connects using saved settings, then returns status. Connection errors return 400 with setup guidance. |
| `DELETE /api/browser/connect` | Cancels pending connection/work, disconnects, pauses implicit reconnection and returns status.                   |

The `/api/browser` routes refer to the shared browser. `GET /api/bots/:id/browser`, `POST /api/bots/:id/browser/connect`, and `DELETE /api/bots/:id/browser/connect` return/control the selected bot's browser. A bot selecting shared uses the same connection as the shared routes. Status can include `botMode`, `waiting`, and `pool: {active,limit,waiting}`. Dedicated browsers use independent connections and operation queues; the global pool limits open browsers and evicts only idle ones, retaining their profiles.

`BrowserStatus` has `state: 'disconnected' | 'connecting' | 'connected' | 'error'`, `mode`, `platform`, `busy`, `tabs: {pageId:number,url:string,title?:string,protected?:boolean}[]`, and optional `error`. A status poll uses the last observed tab list; a bot's `tabs` operation refreshes it. All routes use normal authentication and same-origin mutation checks. There is no HTTP route for directly executing browser commands.

The Pi `browser_use` tool accepts `operation: 'tabs' | 'open' | 'navigate' | 'snapshot' | 'click' | 'fill' | 'press_key' | 'scroll' | 'hover' | 'screenshot' | 'close' | 'dialog'` plus operation-specific `pageId`, `url`, `stateId`, `uid`, `text`, `key`, `direction` or `accept`. Mutations of existing tabs require the latest snapshot's opaque state ID; element operations also require its UID. Plans and approvals are bound to the current connection, URL and observed target. Repeated mutations use the task's operation journal; failed/uncertain records are not automatically retried.

Browser permission is independent of `permissions.network`. Auto permits only `tabs`, `snapshot` and `screenshot`. Screenshots are persisted as indexed `GeneratedImage` chat attachments and served by the existing authenticated image route. Capture-time image blocks are returned to Pi only when both effective `model.imageInput` and `browser.includeScreenshotsInModel` are enabled in the task's pinned and current settings, and the shared image-input budget has capacity. Otherwise the tool returns attachment metadata and text-snapshot guidance. With general image input enabled, `view_image` can inspect a saved current-room screenshot later even when capture-time inclusion is off. That browser toggle controls immediate inclusion, not access to an already attached image. See [image viewing](#image-viewing) and [Chrome behavior and limits](BROWSER.md).

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

`output` contains bounded partial text while generating and an editable candidate when completed. Only completed results are applicable in the UI. The model never writes a bot profile; normal bot POST/PATCH applies the user's final edited text. Requests use at most `min(model.maxOutputTokens, 4096)` tokens and final prompts at most 32,000 characters. Input/context validation is conservative and rejects rather than truncates. The saved model first-response and output-idle budgets start after acquiring capacity. Cancelled/failed/interrupted requests are never automatically repeated; explicitly create a new UUID to try again. Closing the editor does not cancel a server job. See [model behavior](MODELS.md#system-prompt-assistance).

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

The explicit Generate action authorizes the supplied prompt for network Ask, Auto or Allow, without a second bot-tool approval card. The bot-only `images.permission` setting does not change this direct consent. Network Deny returns 403 before admission. Network permission is rechecked after queueing; changing it to Deny, or to a different policy other than Allow, prevents dispatch. Language/image execution settings and their credentials cannot change while an avatar job is active; settings updates return 409. Permissions and the global inference limit can still change.

The jobs are stored separately from `Snapshot`; poll the list or individual GET endpoint for their state. Closing the editor stops its observer without cancelling the server job. Recent listing is limited to 20 records, but older jobs remain retrievable by ID. Completed job metadata repairs the image index on startup; previously active jobs become interrupted. Cancellation and restart never silently retry generation. Applying a result still requires saving the bot profile.

## Image settings tests

Image settings can be tested before saving. These authenticated routes generate one real image using a fixed, short prompt and the supplied image configuration. They do not call the text model, save settings, create a chat message, or add an image to the durable image index.

| Route                            | Input                          | Result                                                                                                                                                 |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/image-tests`          | `{requestId,settings,apiKey?}` | `ImageTestJob`; 202 when queued/generating, otherwise 200 for an existing terminal request.                                                            |
| `GET /api/image-tests/:id`       | UUID                           | Current job metadata; 404 if unknown. Use this to recover a lost POST response.                                                                        |
| `DELETE /api/image-tests/:id`    | UUID                           | Cancel pending work and discard its preview. An unknown ID receives a durable cancellation record, preventing a later disconnected POST from starting. |
| `GET /api/image-tests/:id/image` | UUID; optional `?download=1`   | Authenticated PNG/JPEG/WebP preview with no-store caching; 410 after expiry, cancellation or restart.                                                  |

`settings` requires `baseUrl`, `modelId`, `size`, `responseFormat`, `timeoutSeconds` and `shareInferenceSlot`, with the same validation as the image integration below. The server enables this one test independently of the saved integration toggle. The fixed prompt asks for one blue circle on a white background. It sends the selected size rather than substituting a potentially unsupported test size. A paid provider can charge for the request.

Omitting `apiKey` snapshots the saved image key only if the supplied base URL has the same origin as the saved image endpoint. An explicit string replaces it for this test only; an empty string means no key. The resolved value stays in memory and cannot fall back to a subsequently changed credential. Neither raw keys nor preview bytes enter a job receipt. The text-model key is never used.

Only one image settings test can be active at a time. It shares the image queue with chat/avatar generation and reserves a global inference slot when requested. Network Deny blocks admission, and network permission is checked again before dispatch. The explicit test action supplies consent under the other network modes, independently of the bot-only `images.permission`. The entered timeout starts after both local queues admit the request; queued jobs have no `deadlineAt`, and generating jobs publish their active deadline. Stop and server shutdown abort pending or active work. The provider may continue work it has already accepted. Remote provider waiting is part of the active timeout because the nonstreaming image API does not expose its queue state.

`ImageTestJob` exposes `id`, `status`, `baseUrl`, `modelId`, `size`, `createdAt`, `updatedAt`, `deadlineAt?`, `previewAvailable`, `previewExpiresAt?`, `image?`, `errorCode?` and a sanitized `error?`. Statuses are `queued`, `generating`, `completed`, `failed`, `cancelled` and `interrupted`. A successful result means the adapter accepted a supported raster; it is not a visual-quality assessment.

Preview bytes stay in process memory for at most **15 minutes**, with at most three previews retained and the normal 20 MiB per-image bound. Cancellation, leaving/editing the settings form, or server restart can remove them earlier. Receipts remain in the database to prevent accidental replay; previously active jobs become interrupted after restart. Within one process, replaying an identical POST returns the existing job, while changed inputs with the same UUID return 409. After a restart, recover through GET rather than replaying POST. A new generation always needs an explicit action with a new UUID.

## Image settings and tool protocol

| `images` field       | Default     | Accepted value / behavior                                                                                                                            |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | `false`     | Boolean; requires a valid base URL and nonempty model ID when true.                                                                                  |
| `permission`         | `inherit`   | Bot tool policy: `inherit`, `allow`, `ask`, or `deny`; Network Deny always takes precedence.                                                         |
| `baseUrl`            | Empty       | HTTP(S) base URL without embedded credentials, query or fragment; `/images/generations` is appended.                                                 |
| `modelId`            | Empty       | Image-provider model identifier, up to 250 characters.                                                                                               |
| `apiKey`             | Omitted     | Write-only credential, up to 4,096 characters; empty clears it. Never returned.                                                                      |
| `apiKeyConfigured`   | `false`     | Response-only Boolean indicating a saved image credential.                                                                                           |
| `size`               | `2048x2048` | Square 2K by default; `auto` or `WIDTHxHEIGHT`, each dimension 64–8,192, product at most 16,777,216. Provider-specific restrictions can be narrower. |
| `responseFormat`     | `auto`      | `auto` omits the legacy field; `b64_json` explicitly sends that `response_format`.                                                                   |
| `timeoutSeconds`     | `3600`      | Integer 10–86,400; the active generation/download deadline starts after queue admission.                                                             |
| `shareInferenceSlot` | `false`     | False permits independent image/text overlap. True makes images acquire global model capacity; images remain serialized.                             |

The LLM tool `generate_image({prompt,size?})` accepts a prompt of 1–16,000 characters and an optional size override using the same bounds. Omitting size uses the saved image setting. It posts `{model,prompt,n:1,size}` to the configured endpoint, plus `response_format` only when explicitly selected. A size of `auto` is sent literally rather than omitted. Sampling steps remain server-managed: the adapter sends neither `steps` nor `num_inference_steps`. The adapter accepts `data[0].b64_json` or `data[0].url`. It does not implement native ComfyUI workflow submission. Avatar jobs use this same image adapter and saved settings, with the direct consent described above.

Defaults apply to missing values; existing saved image settings are retained. The UI's 2K/60-minute/parallel preset sets only `size:'2048x2048'`, `timeoutSeconds:3600` and `shareInferenceSlot:false` in the draft; the ordinary settings save persists the changes. Independent image capacity permits overlap on the same machine as well as separate hardware; it does not increase image concurrency beyond one. Settings updates, test requests and archive imports use the same image timeout bounds, with missing legacy archive fields inheriting defaults.

For bot requests, `images.permission: 'inherit'` follows network Allow or Deny and maps network Auto/Ask to exact manual approval. Explicit `allow` skips approval only for image generation; `ask` always reviews a new request; `deny` blocks it. Network Deny overrides every image choice. Omitted permission fields retain saved choices; legacy settings without the field default to `inherit`, and an explicit `inherit` resets the override. Tests and avatar buttons retain direct owner consent.

Image permission edits remain live. Every other image setting, including credentials and enablement, can change when every active room task is queued in a paused room or independently confirmed suspended by the runtime. Draining work, an active room or an active avatar job keeps those settings locked; validation rejects the whole update before persisting settings or secrets. Same-origin credential retention and clearing on origin changes still apply.

New bot image calls after resume read the complete current configuration. Prepared, approval-waiting and queued calls retain an immutable snapshot of their endpoint, model, resolved size, response format, timeout and credential. Credentials are never included in the approval or operation journal. Sharing and the effective permission are checked again after both queues and before HTTP dispatch; disabling generation or a newly stricter policy prevents submission. Changing to Allow does not automatically approve an existing pending card.

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

`generate_image` returns a textual receipt with the saved image ID and metadata; generation alone does not send its pixels to the conversation model or establish that the bot inspected it. With image input enabled, the bot can explicitly inspect that result using `view_image` before making claims about composition, text or visual quality.

## Image viewing

The Pi tool `view_image` is available to ordinary bot tasks when effective `model.imageInput` is enabled. It is a read-only tool, not an HTTP route, a separate vision-model integration or another image-generation request. It accepts exactly one nonempty source and rejects unknown fields:

| Argument  | Accepted source                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `imageId` | An `img_` ID attached to a message in the current task's room, including the task's own current generation or screenshot. Other members' attachments in that room are also available. An ID known only from another room, an avatar job or the global image index is insufficient.                                 |
| `path`    | A PNG/JPEG/WebP file relative to the task's pinned workspace, such as `artwork/preview.png`. The tool schema limits this string to 1,000 characters. Absolute paths, Windows drive/UNC paths, URI schemes, external URLs, traversal outside the workspace and protected application/credential paths are rejected. |

Recent completed room messages and `room_context` expose bounded image references (`imageId`, filename and MIME type), with at most the last eight attachments per included message. Those references contain no pixels and are not proof of visual content. The bot can use them or a generation receipt to choose an image; `list_files` can discover workspace images. Loom does not inject every historical attachment automatically or download a URL supplied to `view_image`.

A successful call returns a short source/type/byte-count receipt and a real Pi image content block, `{type:'image',data:<base64>,mimeType}`. The provider adapter includes those pixels in the configured conversation-model request. The tool does not create a file, require image-generation approval or perform a network fetch. Existing generation and browser-action permissions still apply to creating new images or capturing new screenshots; they do not become additional approval requirements for reading an existing allowed image. Room pause, task cancellation, the normal tool-call limit and activity reporting still apply. Effective image-input permission is checked in both pinned and current settings before and after the read.

Each image is limited to **20 MiB**, **8,192 pixels per side** and **16,777,216 pixels total**. Validation checks PNG/JPEG/WebP signatures and dimension headers; it does not fully decode the codec or resize the image. Reads require regular files, enforce the existing workspace private-path/symlink boundary, compare canonical paths, ancestor/file identity and file metadata around bounded cancellable reads, and reject detected changes. Managed-image reads also recheck the current-room attachment and its metadata after I/O. These application-level checks are not an operating-system sandbox.

Explicit image reads and immediate screenshot inclusion share an **80 MiB budget per task execution**, measured as newly emitted raw raster bytes, excluding base64 expansion. Repeated reads count again. Room pause/resume and context compaction retain that counter; an explicit restart of a stopped task creates a new execution and counter. A rejected `view_image` emits no pixels; an over-budget screenshot stays attached in chat with a metadata-only result. This is not a bound on persisted history, bytes resent in subsequent model turns, total request size or provider context usage.

Disabling general image input removes `view_image` and prevents image blocks from being sent in later model requests, including blocks retained from earlier session history. It does not erase saved chat attachments or pixels already persisted in Pi session files, and re-enabling it can make retained context eligible again. Image content is untrusted task data; it cannot authorize actions or change permissions. A bot should claim visual inspection only after receiving image content and should identify unreadable or uncertain details.

## Inference queue

`Snapshot.queue` retains `active` and `waiting` and adds:

| Field            | Meaning                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `active`         | Requests currently holding the global inference gate, including shared image requests.                                                     |
| `waiting`        | Requests in the inference gate plus tasks waiting for a runtime/session worker. Tool-specific and approval waits are separate task states. |
| `capacity`       | Current global request limit; active can temporarily exceed it while a reduced limit drains.                                               |
| `modelWaiting`   | Requests waiting in the inference gate, including requests blocked by room order.                                                          |
| `sessionWaiting` | Pending tasks whose bot × room session is already active.                                                                                  |
| `waitingTasks`   | `{taskId,reason}` entries where reason is `inference`, `room`, `session`, `worker`, or `paused`.                                           |

The added fields are optional in the TypeScript shape for compatibility with older fixtures/clients; the current runtime populates them. A serial room reserves its turn for one model request, not an entire task. Ordinary tools and approvals release model capacity. Parallel rooms can admit different bots up to the global limit, but never mutate the same bot × room session concurrently. The external inference server determines its actual batching and execution strategy.

## Messages and execution state

### Room pause and resume

`POST /api/rooms/:id/pause` persists `Room.paused: true` and returns `{room}`. Each issued model/tool operation finishes, then the started task suspends before the next tool or model request, including individual calls within the same tool batch. Capacity waiters do not issue a request while paused. Pending approvals can be decided, but their actions wait for room resume. Tasks that have not started remain `queued`; manual requests and bot handoffs accepted after pause also queue without starting. `POST /api/rooms/:id/resume` clears the flag, readmits live continuations within the worker limit and starts eligible queued work. Both routes use the usual authentication and same-origin protection. Paused rooms and never-started queued work survive restart; started tasks use explicit task recovery after restart.

`QueueState.waitingTasks` reports `reason:'paused'` for held queued tasks and started continuations; the task's last execution status remains nonterminal. A resumed continuation waiting for a worker reports `reason:'worker'`. The header shows pausing only while a started active task has not reached a paused boundary. `/api/tasks/:id/stop` remains immediate per-task cancellation and does not resume the room. Automation run requests in a paused room return 409 with `code:'room_paused'`; recurring checks wait until resumption.

### Handoff settings

`PUT /api/settings` accepts `maxHandoffs: null | number`. `null` means unlimited count and depth and is the new-install default; `0` disables bot handoffs; integers 1–10,000 impose a finite originating-task budget. Omission preserves the saved choice. Import validation uses the same meanings and finite range. Changes apply to subsequent handoff attempts, including attempts from already-running tasks.

### Message state

Room content is shared, while bot private sessions are separate. Initial prompts and `room_context` include completed room messages, excluding streaming fragments and failed partial messages. Rooms may include an absolute `workspacePath` override. Tasks persist their effective `workspacePath` at admission, including inherited roots for handoffs and learning. Legacy tasks are pinned before path-setting changes. UI maps statuses explicitly: queued / waiting_model / running / waiting_tool / awaiting_approval / stopped / interrupted / failed / completed. Never render all non-running statuses as stopped.

`Message.targetUser?: boolean` marks an explicit bot-to-owner chat post. The `send_user_message` model tool accepts `{message:string,title?:string}` with nonempty text limited to 12,000 and 160 characters respectively. During a chat, handoff or automation task it creates a complete room-visible bot message with `targetUser:true` and the current `taskId`, plus an in-app notification linked to that room/task/message and the actual sender (notification body limited to 4,000 characters). It is unavailable to learning tasks. This tool uses the durable operation journal: a completed exact call is not replayed, and an uncertain/failed call is not automatically retried. It does not enqueue work, send externally or create a reply-waiting state. An idle bot still needs a task or configured automation to execute. The owner can use the inbox's notification reply route, or the usual room message route with the bot's mention.

`Message.targetBotIds` records actual directed requests: the owner's selected recipients or a bot's successful `send_message` handoff. Explicit user targeting is valid only for bot-authored messages without bot recipients; data transfer preserves the flag and rejects conflicting or invalid values. Directed posts retain their task link but are excluded from generation-attempt selection and do not own progress, approval or streaming controls.

Ordinary bot output has no implicit bot delivery, even when its text contains a mention. Its `taskId` can identify the source of the work: a well-formed root `chat` task is an owner request, a validated parent task identifies a requesting bot, and a root `automation` task identifies automatic work. Task ownership and room identity must agree before attributing a message; missing or inconsistent records remain general room sharing. A child task's output is visible in the room and does not automatically resume or notify its parent bot. These source labels are distinct from explicit user targeting and do not imply private delivery or a user-reply waiting state.

The message header and model context use the same source classification. Initial recent history and `room_context` retain structured audience/target/source metadata alongside quoted message text; current task prompts identify the request source. Bounded histories drop whole older entries rather than returning truncated JSON. Neither this metadata nor quoted bot messages grant additional tool permissions. `notify_user` creates an in-app notification linked to the room/task; it does not create a private chat, email or mobile push.

Messages may include `reasoning`, `reasoningStatus:'streaming'|'complete'|'interrupted'`, and `reasoningTruncated`. A `message_reasoning_delta` event carries `{messageId,delta,truncated}`. Reasoning is separate from `body`, persists across reloads, and is capped at 64,000 characters per message. Clients should apply `message_updated` events with `{messageId,patch}`, including body resets between intermediate updates and the final answer, and use a fresh snapshot to reconcile after reconnecting.

Activity records may carry `messageId` to associate a tool/status/progress event with a particular message attempt. Automatically approved operations have `kind:'approval'`, an `approvalRule` identifier, and a human-readable reason in `detail`. Intermediate assistant updates use `kind:'progress'`; they are not additional final answers.

## Application updates

`GET /api/updates` returns the current installation, available revision and update job. `POST /api/updates/check` refreshes the official main revision and its exact push/main CI result. `POST /api/updates/install` accepts `{commit, requestId}` with a 40-character SHA and a UUID, and returns the accepted job with HTTP 202. Repeating the same request ID returns its recorded job without a second installation. The normal authentication and same-origin checks apply; see [update requirements and recovery](UPDATES.md).

Unsafe active work returns HTTP 409 with `code:'update_busy'`. This includes unpaused active tasks, a paused room still draining its current model/tool operation, owner generation jobs, mail sends, transfers and in-flight API handlers. A queued task in a paused room is retained. A started task is eligible only when the runtime confirms it has actually suspended at a boundary in that paused room. The route rechecks work after remote target/CI verification and after maintenance admission and scheduler shutdown, then settles eligible paused executions into the durable queue before requesting the launcher. Rechecking after settlement prevents newly active work from being overlooked. `update_unavailable` remains the code for other update preconditions.

Paused rooms remain paused after restart. Prepared tasks retain their IDs, saved conversations and operation records and are recovered when the owner resumes the room. This is recovery from saved context, not restoration of the in-memory execution stack; pending approvals require renewed review, completed exact operations are restored and uncertain operations are not replayed. A definitive preparation/launcher rejection releases maintenance; an uncertain IPC result retains it until reconciled. Room resume, direct task resume and new-task admission are blocked while maintenance owns the installation.

## Data transfer

The managed application entrypoint enables encrypted copies between installations. `GET /api/data-transfer` returns `available`, `busy`, `maxArchiveBytes`, `chunkBytes` and, when present, the active or most recent retained `activeJob`. An embedded `createApp()` without a transfer manager reports `available:false`.

| Method and path                            | Behavior                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/data-transfer/export`           | Accept `{password,browserState?}` and return a queued export job with HTTP 202. Close the runtime after the response, write an encrypted copy, and restart.         |
| `POST /api/data-transfer/import`           | Accept `{size}` and create an upload job with HTTP 201.                                                                                                             |
| `PUT /api/data-transfer/jobs/:id/upload`   | Upload at most `chunkBytes` of `application/octet-stream`; `X-Loom-Offset` must equal `uploadedBytes`. Return the updated job.                                      |
| `POST /api/data-transfer/jobs/:id/inspect` | Accept `{password}`, decrypt and validate asynchronously, and return HTTP 202. A fully uploaded file can be checked again after a failed password or stale preview. |
| `GET /api/data-transfer/jobs/:id`          | Return job status, counts, preview, download size or retained backup path.                                                                                          |
| `GET /api/data-transfer/jobs/:id/download` | Download a ready export as an authenticated `.loom` attachment.                                                                                                     |
| `POST /api/data-transfer/jobs/:id/apply`   | Accept `{previewToken}` for the exact validated preview; return HTTP 202 before stopping and replacing the application. Reject a changed destination with HTTP 409. |
| `DELETE /api/data-transfer/jobs/:id`       | Discard a staged or finished job. Active work, uploads and downloads cannot be deleted mid-operation. Retained destination backups are separate.                    |

Job states are `queued`, `uploading`, `working`, `ready`, `applying`, `completed` and `failed`. Export and apply temporarily disconnect HTTP/SSE clients while the application is recreated on the same port. Poll across transient disconnections and HTTP 503; a disconnected client does not mean the accepted operation was cancelled. Read the job before retrying a chunk after a lost response.

Passwords appear only in JSON request bodies and are never stored in jobs, URLs or browser preferences. Portable browser state permits only `loom.drafts`, `loom.locale`, `loom.room`, `loom.mailAccount`, `loom.activity` and `loom.notifications`, with a 1MiB JSON limit. Binary uploads use an 8MiB route limit without enlarging ordinary API body limits. All transfer paths retain normal authentication, origin checks and `Cache-Control: no-store`.
