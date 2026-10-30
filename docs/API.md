# Agent Loom API contract

All JSON requests use `Content-Type: application/json`. API errors: `{error:string}` with non-2xx status. Successful writes return the updated resource or `{ok:true}`. GET /api/state returns Snapshot (src/shared/types.ts). All writes produce SSE `snapshot` events. Frontend can refetch after mutations. /api/events is SSE with JSON ServerEvent records; message_delta gives text streaming. Idempotent GETs; room and task data persist.

- GET /api/health -> {ok,version,configured,demoMode}
- GET /api/auth -> {required:boolean,authenticated:boolean}; POST /api/auth {token}; DELETE /api/auth.
- GET /api/state -> Snapshot
- GET /api/events -> SSE (`data: JSON.stringify(ServerEvent)`). EventSource with same-origin session cookie.
- PUT /api/settings accepts partial Settings. Keys are write-only; an explicit empty string clears a key. An omitted model.apiKey keeps the saved key only when the model origin (scheme, host, port) is unchanged; moving to another origin clears it unless a new key is explicitly supplied. An omitted search.apiKey retains its saved value. Responses never include raw keys. During active tasks, changes to model execution settings/credentials, workspace, or demo mode return 409; an unchanged full form can still update permissions and automatic learning.
- POST /api/settings/test {baseUrl,modelId?,apiKey?} -> {ok,models:string[],message:string}; read-only model discovery, no paid generation. An omitted key reuses the saved model key only for the saved origin. Testing another origin does not forward that key or change saved settings.
- POST /api/demo {enabled:boolean} -> Settings; explicit simulated mode, all answers labeled by UI; does not contact LLM.
- POST /api/bots {name,handle,role,systemPrompt,color,avatar,enabled?}; PATCH /api/bots/:id; DELETE /api/bots/:id (reject while tasks active).
- POST /api/rooms {name,description?,botIds}; PATCH /api/rooms/:id {name?,description?,botIds?,pinned?,archived?}.
- POST /api/rooms/:id/messages {body,botIds?:string[]} -> {message,tasks}; @handles resolved server-side, default first enabled member. Client should POST once and not invent bot responses.
- POST /api/tasks/:id/stop; POST /api/tasks/:id/resume -> Task. Stop cancels pending approvals; resume explicit, preserves completed-operation record.
- POST /api/tasks/stop-all -> {ok:true}.
- POST /api/approvals/:id {decision:'approve'|'deny'} -> Approval.
- POST /api/skills {name,description,content,botId?:string|null} -> Skill candidate.
- PATCH /api/skills/:id {name?,description?,content?,status?:'candidate'|'active'|'archived',botId?}; POST /api/skills/:id/restore {version:number}; GET /api/skills/:id/export -> text/markdown.
- POST /api/memories {content,botId?:string|null}; PATCH /api/memories/:id {content}; DELETE /api/memories/:id.
- POST /api/automations {name,kind,roomId,botId,prompt,intervalMinutes?,sourceUrl?,enabled?,imap?:{host,port,secure,user,mailbox,password?}}; PATCH /api/automations/:id; DELETE /api/automations/:id; POST /api/automations/:id/run -> Automation. Running may establish a baseline, detect no change, or coalesce existing work without creating a task. Source edits reset the relevant baseline while retaining the prior task ID for overlap prevention. Disabling an assigned bot, removing it from the destination room, or archiving that room pauses affected enabled rules.
- POST /api/automations/:id/webhook-key -> {token,path}; explicit token creation, only webhook automations. POST /api/hooks/:id with bearer token + {text,eventId?} -> {ok,duplicate,queued,task?}. `task` identifies an immediately created task; `queued:true` means the event was saved for a later coalesced batch. Repeated event IDs return `duplicate:true`.
- POST /api/notifications/read {id?:string} marks one or all read.

Room content is shared, Bot private sessions are separate. UI maps statuses explicitly: queued / waiting_model / running / waiting_tool / awaiting_approval / stopped / interrupted / failed / completed. Never render all non-running statuses as stopped.
