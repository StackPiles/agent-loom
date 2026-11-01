# Mail and service accounts

This guide describes Agent Loom **0.2.0**. Mail hosting stays outside Loom: connect an existing mailbox, assign it to a bot, and use the same tools and incoming-mail automations across supported providers. Choosing a provider is optional; Loom works without a mail connection.

Loom manages connections, bot assignments, local drafts, reviewed sends, incoming-mail triggers and a service-account registry. Your mail provider remains responsible for addresses, mailbox creation, domains, DNS, delivery and its own access policies. Removing a connection or deleting a bot in Loom does not delete an external mailbox or service account.

## What is connected to what?

| Item                     | Purpose                                                   | Stored in Loom                                                                                        |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Mail account             | One existing external inbox and its sending identity      | Provider configuration, bot assignments, send policy and encrypted connection credentials             |
| Bot                      | An agent allowed to use selected accounts                 | References to existing account assignments; renaming a bot does not rename its mailbox                |
| Incoming-mail automation | A rule routing new mail to a bot in a room                | Account reference, instructions, interval, receive cursor and bounded pending events                  |
| Mail draft               | Exact content prepared for a possible send                | Sender, To/Cc/Bcc, subject, plain text, optional reply target, revisions and attempt status           |
| Service account          | A record of which identity is used at an external service | URL, login identifier, bot/mail links, status, notes and an optional encrypted, write-only credential |

An account can be assigned to more than one bot. Each assigned bot can read that account and prepare drafts; its sending policy applies to all of them. Assigning a mailbox does not isolate individual messages between those bots. Service records have a single optional bot owner. Room membership still determines where a bot may act, and learning-review tasks have no mail or service tools.

## Connect an account

1. Open **Mail & services → Email → Connect email**.
2. Enter a local display name and the external email address, then choose a connection type.
3. Add the connection details described below. Enter credentials in the account editor, never in a room message or system prompt.
4. Assign the account to the intended bot or bots. Keep **Review and approve each send** while establishing the workflow, or choose another policy deliberately.
5. Use **Test connection**, review its result, and save. Testing does not save the form, create a mailbox, send a message, or enable an automation.
6. Open the account's mail panel to list or search mail. Create an incoming-mail automation if a bot should react without a new chat message.

Network **Deny** blocks connection tests and remote mail operations. Explicit owner tests can run with network Ask; unattended watchers require Allow or Smart auto-approve. Saved credentials are not returned by the API or prefilled in password inputs: a configured indicator means a secret exists. Leaving a credential blank can preserve it only for the same identity and endpoint. Changing the provider, address, username, host or port can require re-entering credentials; the editor clears incompatible unsaved values.

### IMAP with optional SMTP

Choose **IMAP / SMTP** for an existing account on a provider or server that accepts the supported password-based protocols. The email address is the intended sender identity; an IMAP or SMTP login username may be different. Supply the host, port, username and password required by that server, and select a receiving folder such as `INBOX`.

| Connection setting    | Behavior                                                                             |
| --------------------- | ------------------------------------------------------------------------------------ |
| Implicit TLS enabled  | TLS starts when the connection opens; use the server's TLS port                      |
| Implicit TLS disabled | STARTTLS is required; this does not enable plaintext fallback                        |
| SMTP omitted          | Receiving and local drafts remain available; sending is unavailable                  |
| SMTP configured       | The selected sender is submitted through that server, subject to its own permissions |

IMAP folders are selected read-only. Listing, reading and intake do not change read flags, move messages or delete them. Receiving uses IMAP; sending uses Nodemailer SMTP with certificate validation. Custom hosts may be local or private hosts you operate, but this adapter does not provide a certificate-validation bypass.

The IMAP test authenticates and opens the selected folder. When SMTP is configured, the test also calls SMTP verification without sending mail. Successful verification does not establish that the server accepts a particular sender or that a message will be delivered; see [Nodemailer's verification documentation](https://nodemailer.com/smtp#verifying-the-configuration).

SMTP submission does **not** append a copy to an IMAP Sent folder. A provider may save its own copy; Loom stores a local send receipt. Do not assume that a missing Sent-folder copy means the message was not submitted.

### Gmail convenience settings

**Use Gmail connection settings** fills in:

| Transport | Host             | Port | Security     |
| --------- | ---------------- | ---: | ------------ |
| Receiving | `imap.gmail.com` |  993 | Implicit TLS |
| Sending   | `smtp.gmail.com` |  465 | Implicit TLS |

Enter the account's applicable Google app password separately for the receiving and sending connection. Loom removes grouping whitespace for the Gmail IMAP preset and for Gmail SMTP on port 465 with TLS or 587 with required STARTTLS. Other providers' passwords remain literal.

The preset is a connection form convenience. It does not sign in to Google, issue an app password, change the Google account's security settings, or implement Google OAuth. If that account cannot use app passwords and requires OAuth, use another supported connection or wait for a dedicated authentication integration. Google's own [app-password settings](https://myaccount.google.com/apppasswords) determine availability for the account.

### AgentMail

Choose **AgentMail**, then enter the address, existing inbox ID and API key. Loom connects to the fixed origin `https://api.agentmail.to` and the **`/v0/inboxes/...`** API. It verifies that the inbox's reported address matches the address saved in Loom.

Loom uses existing inbox metadata, received-message listing/search, message reading and sending. It does not create or delete AgentMail inboxes, domains or API keys. The relevant primary references are [Get Inbox](https://docs.agentmail.to/api-reference/inboxes/get), [List Messages](https://docs.agentmail.to/api-reference/inboxes/messages/list) and [Send Message](https://docs.agentmail.to/api-reference/inboxes/messages/send).

The connection test checks inbox access and identity. It does not send mail or prove sending permission, delivery, quota availability or recipient acceptance. API operations and any charges remain subject to the external account's configuration.

### Resend Inboxes

Choose **Resend Inboxes**, then enter the address, existing inbox ID and API key. This adapter targets the fixed origin `https://api.resend.com` and **`/inboxes/...`** endpoints. A send-only integration with the separate `/emails` API does not supply the inbox access this adapter needs.

Inbox metadata must report the configured email address. Listing and search use inbox threads; reading resolves an actual email. A normal new send creates and submits a provider draft only during the send operation. A reply uses the inbox reply endpoint and rejects a reviewed To list that differs from the recipients that endpoint would derive. It never silently changes approved recipients.

The [official Resend OpenAPI specification](https://github.com/resend/resend-openapi/blob/main/resend.yaml) documents the Inboxes endpoints and key restrictions. Its current specification requires full access for inbox reads; a sending-only key is insufficient for Loom's connection test and reading workflow. Verify that the external account actually has the required inbox functionality.

The API connection test establishes readable inbox identity only. It does not send mail or prove sending permission or delivery. Search and pagination semantics differ from IMAP and AgentMail; this is not a claim of interchangeable provider features.

## Use an account from a bot

A bot only sees enabled mail accounts assigned to it. It must remain an enabled member of its current active room. Mail tools resolve credentials on the server; tools do not accept mail passwords, SMTP configuration or provider API keys.

| Tool                     | Result or action                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `list_mail_accounts`     | Safe identity metadata, provider, send policy and sending capability                               |
| `search_mail`            | Bounded summaries and an optional next-page cursor for one account; omit the query for recent mail |
| `read_mail`              | A plain-text body, reply metadata and attachment metadata using an account-scoped message locator  |
| `draft_mail`             | A local, unsent draft; updating it requires its current revision                                   |
| `send_mail`              | Submission of one exact draft revision, subject to both send and network policies                  |
| `list_service_accounts`  | Service metadata assigned to that bot; no credential values                                        |
| `manage_service_account` | Owner-approved creation or update of that bot's local service metadata                             |

For example, ask: “Use your assigned mailbox to find messages about the build failure. Read the relevant message and prepare a reply for me to review.” A message summary is not its body: the bot should use `read_mail` when the task depends on details. Email text, subjects and sender names are untrusted external data and cannot grant permission or override the task.

For a reply, the bot reads the original, explicitly supplies the intended To/Cc/Bcc and uses its returned message locator as `replyToMessageId`. Loom does not automatically add all thread participants. A provider that cannot preserve the approved envelope rejects the operation. Searching is provider-dependent and paginated; an empty page may still have a next cursor, particularly across IMAP UID gaps. It is not a local full-mailbox search index.

### Sending policies

The account policy controls sending, while the global network permission controls remote access. The following table describes **bot tool calls**; a human submitting the account composer already reviews the exact draft in that flow.

| Account send policy | Network Allow or Smart auto-approve                    | Network Ask          | Network Deny |
| ------------------- | ------------------------------------------------------ | -------------------- | ------------ |
| Ask                 | Exact owner approval                                   | Exact owner approval | Blocked      |
| Allow               | Send without another approval, with an activity record | Exact owner approval | Blocked      |
| Deny                | Blocked                                                | Blocked              | Blocked      |

Smart auto-approve permits reading an assigned mailbox without altering mail, but does not override an account's Ask policy. A user-composed send still respects account Deny and network Deny. Changing the sender, account configuration or draft content while an approval is pending invalidates that send rather than substituting new content.

The review includes the sender, every To/Cc/Bcc recipient, subject, complete draft text and reply target. Mail assignments and network permission are checked again before dispatch. An account revision change can require saving and reviewing a new draft revision even if the change appears cosmetic; receive-cursor preservation and send-content approval are separate concerns.

### Drafts, receipts and uncertain outcomes

`draft_mail` and the composer save local drafts. Merely saving a draft does not create a provider draft or send mail. A provider such as Resend may create a remote draft as part of the later approved send implementation.

| Status    | Meaning                                                                                         | Automatic retry                                                               |
| --------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `draft`   | Saved and unsent; can be edited with its current revision                                       | No submission has started                                                     |
| `sending` | A durable attempt record exists and submission is in progress                                   | Concurrent duplicate sends are rejected                                       |
| `sent`    | The adapter recorded provider acceptance and a provider message identifier                      | A repeated request returns its saved receipt                                  |
| `failed`  | The attempt ended with a classified failure                                                     | Terminal for that attempt; no automatic resend                                |
| `unknown` | The provider may have accepted the message, or the process stopped before confirming the result | Terminal for that attempt; inspect externally before deciding on any new send |

`sent` does not prove delivery, inbox placement or reading. SMTP partial acceptance is treated as uncertain to avoid resending to recipients who may already have received it. A stop or timeout cannot recall a message the remote service has already accepted.

Each owner send request uses a UUID and exact draft/account revisions. A bot's operation journal maps a stable tool operation to a stable request UUID. Reusing an accepted request does not submit it again. A crash between saving the provider receipt and completing the tool journal can recover the receipt without sending. Unsettled `sending` attempts become `unknown` on restart. These local protections do not provide a distributed exactly-once delivery guarantee across arbitrary providers or new user-created drafts.

## React to incoming mail

Create an **Incoming email** automation, choose the destination room and bot, select an account assigned to that bot, and give the bot a concrete condition and action. For example:

> Read new messages from the project service. Notify me in this room when an approval or a reply is required. Prepare replies as drafts for my review.

A direct chat request can also use `list_automations` and `manage_automation` to propose the rule. Those tools require exact owner approval and are unavailable to scheduled, learning and bot-handoff tasks. The account must already exist and be assigned to the selected bot. The persisted trigger kind remains `imap` for compatibility, including AgentMail and Resend rules; `mailAccountId` selects the provider-neutral connection.

### Timing and buffering

- The Loom server must remain running. Due rules are scanned every five seconds, but their polling interval is the configured number of minutes. This is periodic polling, not instantaneous push or IMAP IDLE.
- Intake does not reserve an inference slot. It continues while the previous automation task is generating, queued, using a tool or awaiting approval.
- Each poll retrieves at most **20 new summaries**. Each rule can persist up to **100 pending events**. The scheduler gives a task at most 20 events and may use fewer to keep its prompt bounded.
- When the pending buffer is full, the scheduler stops polling that source and does **not** advance its receive cursor. Messages remain at the provider until later checks can resume. Deletions or retention at the provider can still make a message unavailable.
- Provider cursors retain unfinished page scans. Further checks continue that bounded scan; a large mailbox or backlog can require several polling intervals. The current scheduler does not immediately drain all remaining provider pages in one run.
- Overlapping API scans are deduplicated by account-source message identity within the rule. Cursor advancement, duplicate detection and pending-event persistence commit together. Task persistence and removal from the pending queue also commit together.
- A rule keeps only one active automation task at a time. Once it settles, buffered mail can be admitted on a later scheduler tick. A failed/interrupted task remains a task to inspect and resume; the same event is not automatically reissued as a new task.

A first connected-account poll uses **rule creation time** as its cutoff. Changing the receive source uses **source-edit time**. Mail arriving after that cutoff but before the first poll is eligible, including signup or verification messages. Poll results marked as a baseline can therefore still contain new messages. Arrival filtering uses provider ingestion timestamps or IMAP internal dates, rather than trusting the sender's Date header alone.

IMAP cursors also track UIDVALIDITY. If a previously observed mailbox namespace changes, the adapter establishes a new high-UID baseline instead of replaying reindexed history, and Loom notifies the owner. Old and new UIDs cannot safely be compared: messages already present at that reset are not classified as new arrivals and need direct inspection. Old message locators can then be invalid; use a new search. Legacy watchers keep their earlier baseline behavior as described below.

Account receive-source edits discard old pending events and old cursors. Renaming an account, rotating its credentials or changing its sending policy does not itself change the receive source. Results from a connection that was changed while a poll was in flight are not delivered to the new source. Disabling or unassigning an account pauses affected rules; re-enabling the account does not silently re-enable those rules.

Automatic URL and mail checks require network **Allow** or **Smart auto-approve**. Ask cannot be satisfied by an unattended watcher, and Deny blocks it. Repeated identical errors are kept on the rule without creating an identical notification on every check. `notify_user` writes a Loom notification; email delivery uses the separate mail tools.

## Upgrade existing IMAP automations

Startup migration runs locally before the runtime and scheduler start. It does not connect to a mail provider.

Existing IMAP rules whose login username is a valid email address can become entries in Accounts. Rules with the same receive endpoint, username, folder and stored credential can share a migrated connection, with their target bots assigned to it. Migrated connections are **receive-only** until you explicitly configure SMTP; the migration never invents SMTP settings or grants automatic sending.

Existing matching UIDVALIDITY and last-UID state is carried forward through the internal `legacyMailAccountId` marker. The first provider-neutral poll consumes that cursor instead of treating already-observed mail as a new baseline. The marker also survives an unrelated rule edit before that first poll. Once the generic cursor is saved, the transitional UID marker is removed. The old inline configuration and encrypted legacy credential may remain during compatibility migration; editing or removing the old rule can remove that legacy copy. Disconnecting the linked mail account also clears these compatibility credentials. Changing a migrated rule back to a different inline connection creates a separate account on a later migration rather than overwriting the original account.

A username such as `team-login` cannot safely be guessed into a sender address. Those rules remain on the working legacy IMAP path. The automation editor still offers **Legacy IMAP connection** for compatibility. Legacy rules fetch envelopes only, baseline existing mail on their first poll, and cannot use `read_mail` without a separately connected and assigned account. To move one, create the account with its actual email address and transport username, then select that account on the rule. That is a source change and uses the edit-time cutoff.

Keep the normal Loom data-directory backup before upgrading. The database and encryption key belong together; migrating metadata does not replace an external mailbox backup.

## Track service identities

The **Services** tab records the external services a bot uses, independently of the mail provider. A record can contain a service name and URL, login identifier, owning bot, associated mail account, status (`pending`, `active`, or `disabled`) and notes. Linking a mail account records the identity relationship; it does not create a new mailbox or configure forwarding.

The owner may also store a separate credential value. It is encrypted by the same local secret store as mail connection passwords and API keys. The API and bot tools return only `credentialConfigured`; the stored value is write-only through the editor/API. Leaving the field blank preserves it for the same service origin and login, while changing that identity clears an omitted credential. An explicit clear option removes it.

This version does not retrieve or inject that credential into a browser. A registry entry does not sign up, perform automatic login, establish an OAuth session, create a dedicated browser profile, provision a service or prove that a remote account is active. Status is a locally maintained label. Bot-driven `manage_service_account` changes require exact approval, stay with that bot's records, and cannot supply a credential field.

Credential values belong in the separate credential field, not URLs, login labels, notes, chat, memories or skills. Service metadata, drafts, received text copied into tool results and ordinary task/session history are not encrypted as secrets. Protect the application data directory and consider the configured model server when deciding which mail to read into a room.

Deleting a bot or disconnecting mail removes relevant local assignments without deleting the external service identity. Disconnecting a service removes its local registry entry and stored credential; it does not close the account at that service. These are independent lifecycle operations.

## Limits and compatibility

| Boundary                  | Current limit or behavior                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| IMAP MIME source read     | 1,000,000 bytes; larger messages are rejected before full parsing                           |
| HTTP API response         | 2,000,000 bytes per response                                                                |
| Returned plain-text body  | At most 65,536 characters, with truncation metadata                                         |
| Composer / bot draft body | At most 64,000 characters; server draft API has a 65,536-character ceiling                  |
| Search query              | At most 256 characters; provider search syntax/coverage varies                              |
| Listing page              | At most 50 summaries; a next-page cursor may be returned                                    |
| Intake batch              | At most 20 new summaries per poll; unfinished scans retain their cursor                     |
| Pending intake            | At most 100 events per automation; full buffers stop cursor advancement                     |
| Recipients                | Server maximum 50 across To/Cc/Bcc; bot tools also cap each individual list at 20           |
| Attachments               | Metadata only; no download, model ingestion, attachment sending or automatic opening        |
| Content                   | Plain text; HTML is converted to inert text, without loading remote images, styles or links |

A MIME source can contain embedded attachment bytes, so its total size counts against the bounded source read even though only attachment metadata is returned. The reader does not fetch a separate attachment URL or execute its content. Message and cursor locators are opaque, source-scoped values; use the values returned by Loom rather than constructing provider IDs manually.

This release does not implement provider-specific OAuth, Exchange/Graph mail, POP3, remote folder management, message deletion, automatic read-flag updates, rich HTML composition, attachment sending, mail forwarding rules, spam filtering or mail-server provisioning. A provider advertising IMAP or SMTP may still require authentication or server behavior this adapter does not support. Connection tests and synthetic tests do not establish universal compatibility.

Provider-specific details also matter: Resend inbox listing is thread-oriented, AgentMail listing is message-oriented, and IMAP search can continue through UID windows. The common interface normalizes identities, bounded summaries, body reads, drafts and submission receipts; it does not erase those underlying differences.

## Troubleshooting

| Symptom                                               | What to check                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The bot lists no mail accounts                        | Enable the connection, assign that bot, and confirm it is enabled in an active room                                                             |
| A watcher will not run unattended                     | Set network permission to Allow or Smart auto-approve, and confirm the rule itself is enabled                                                   |
| Connection succeeds but sending fails                 | Check SMTP setup or external sending permissions, sender authorization, provider limits and the account send policy; the test did not send mail |
| The address does not match the API inbox              | Confirm both the external inbox ID and its actual email address; Loom does not choose an arbitrary From address                                 |
| The model is busy and mail has not appeared in chat   | Intake can still be collecting; the rule waits for its prior task to settle before handing off the next bounded batch                           |
| A large history takes time to scan                    | Pagination continues over subsequent checks; the interval, provider response and pending buffer affect latency                                  |
| An approval becomes stale                             | Inspect the updated account/draft and save a newly reviewed revision; old approval does not authorize changed content                           |
| A send is `unknown`                                   | Inspect the external inbox/provider status before considering any new draft; resuming must not repeat the uncertain send                        |
| A stored credential disappears after an identity edit | Re-enter credentials for that new identity; secrets do not follow an unrelated host, address or service login automatically                     |
| An IMAP reply cannot find the original                | Search again for a current locator; deleted mail, a changed receiving folder or a UIDVALIDITY reset can invalidate it                           |
| A message is too large                                | Use the external mail client to inspect it; Loom's current reader does not raise its bound or download attachments automatically                |

Errors shown to the UI and model use fixed categories instead of returning raw transport diagnostics that may contain credentials or message content. Provider-side delivery diagnostics remain with that provider. Network cancellation and application shutdown abort active transports; remote actions already accepted may finish independently.

## Extend the provider layer

The extension point is repository code, not an MCP connection or a dynamically discovered plugin. Main implementation references:

| File                                                                          | Responsibility                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`src/shared/mail-accounts.ts`](../src/shared/mail-accounts.ts)               | Serializable accounts, drafts, summaries, body reads, cursors and error/result types                              |
| [`src/server/mail-accounts.ts`](../src/server/mail-accounts.ts)               | Validation, encrypted credential resolution, assignment/network checks, draft revisions and durable send receipts |
| [`src/server/mail-providers/types.ts`](../src/server/mail-providers/types.ts) | `MailProviderAdapter`, checked operation context, opaque locators, shared limits and fixed errors                 |
| [`src/server/mail-providers/http.ts`](../src/server/mail-providers/http.ts)   | Fixed-origin HTTPS transport, response bounds and safe error conversion                                           |
| [`src/server/runtime/mail-tools.ts`](../src/server/runtime/mail-tools.ts)     | Model-facing scope, validation, approvals and the operation journal                                               |
| [`src/server/scheduler.ts`](../src/server/scheduler.ts)                       | Per-rule polling, cursor checkpoints, deduplication, pending queues and task admission                            |
| [`src/server/service-accounts.ts`](../src/server/service-accounts.ts)         | Separate local service registry and write-only credential storage                                                 |

To add a provider:

1. Extend the provider union, account validation, secret-retention rules and editor fields. Keep public metadata separate from credential values, and bind reused secrets to the same external identity.
2. Implement `MailProviderAdapter.test`, `list`, `read`, `send` and `poll`. Return the shared types; keep provider IDs inside bounded, source-scoped locators. A custom adapter should be registered through `MailServiceAdapters.providers` and the production provider map.
3. Call `context.check()` before each remote request and `context.beforeSend()` immediately before the action capable of delivering email. Preserve the exact reviewed sender and recipient lists. If the provider derives recipients differently, reject the mismatch instead of silently broadening the envelope.
4. Bound response bytes, pages, MIME input and body text. Require secure transport, honor cancellation and deadlines, keep API origins fixed or explicitly validated, and convert raw provider errors to `MailAccountError`. Do not let provider content enter credential fields or approval policy.
5. Make `poll` return a bounded set of new summaries and a resumable cursor. A first baseline may contain arrivals since the supplied cutoff. Use provider arrival/ingestion evidence, retain pagination progress, and expose `hasMore` where applicable. Leave durable deduplication and checkpoint commits to the scheduler; do not mark an event consumed before the caller can persist it.
6. Implement only supported reply semantics and document limitations. The core owns durable send attempts; an adapter must not retry a potentially accepted send or promise a stronger idempotency/delivery guarantee than the provider supplies.
7. Add deterministic tests for identity matching, permissions, cursor continuation, overlap duplicates, message limits, cancellation, exact recipient preservation, accepted receipts, uncertain outcomes and secret redaction. Registering a provider does not justify a live send in the test suite.

The application-level API is documented in [API.md](API.md). Runtime, storage and queue boundaries are described in [ARCHITECTURE.md](ARCHITECTURE.md); deployment assumptions and local-secret limits are in [SECURITY.md](../SECURITY.md).

## Verification status

The release is checked with temporary stores, fake provider transports and local application requests, including UI review flows and restart/cancellation behavior. **No live user mailbox was connected and no real email was sent during implementation validation.** See [VALIDATION.md](VALIDATION.md) for the release evidence. Confirm the particular external account with the connection test and a deliberate owner-reviewed trial before relying on its workflow.
