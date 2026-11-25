# Chrome control

Loom can let its bots operate **Google Chrome on the computer running the Loom server**. It bundles the official [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) server and connects it to Pi's normal tool loop. Install Loom with `npm ci`; no separate MCP configuration, Python service, browser-use account, or additional model endpoint is needed. This is not an integration of the separate Python `browser-use` agent.

Chrome is supplied by the operator. The bundled dependencies do not download a browser. Browser control is disabled by default, and ordinary startup or opening Settings does not connect to Chrome.

## Connect

Open **Settings → Chrome control** and enable it. Then open a bot's settings and choose **Dedicated Chrome**, **Shared Chrome**, or **Disabled** for that bot. Global browser permissions and capture-time screenshot settings apply to every bot.

### A browser for each room and bot

Dedicated Chrome is the default. Each room-and-bot combination has its own browser: the same bot in two rooms gets two separate profiles, and two bots in one room also get separate profiles. Bots start the correct browser automatically on first use; normal work does not require the operator to open Chrome. For optional direct sign-in, select the intended room in a bot's settings before using **Open / connect Chrome**. Only rooms containing that bot are available. Opening settings or reading status does not start Chrome.

Each dedicated browser has its own connection, operation queue, tabs, observed page states and persistent profile under `<LOOM_DATA_DIR>/browser-profiles/rooms/<room-id-hash>/<bot-id-hash>/`. Its profile key includes both the room ID and bot ID, so renaming either does not change the profile. Closing Chrome keeps its profile. New room-specific profiles require signing in and do not copy cookies or sign-ins from shared or older bot-only profiles. A missing or unavailable dedicated browser never falls back to shared Chrome.

**Maximum open browsers** defaults to 3 and can be set from 1–16, independently of model concurrency. It counts shared and room-and-bot browsers together. Profiles are saved separately without keeping every Chrome running. Browsers start only when needed. At capacity, Loom closes an idle browser to make room while retaining its profile; it does not close a browser held by active work. A task holds its browser from first use until it finishes or explicitly releases it at a safe checkpoint, including model thinking between actions and browser approvals. If all slots are in use, another room or bot waits and continues automatically when admitted. Lowering the limit reduces simultaneous browsers but can increase waiting; the setting is a browser-count limit, not a RAM limit, because memory use depends on sites and tabs. Separate dedicated browsers can operate concurrently. Browser separation isolates site sessions, not operating-system permissions.

### Autonomous cooperation and capacity

Normal bot work does not require **Open / connect Chrome** in Settings. `browser_use` acquires this task's trusted room-and-bot browser, starts it on demand and waits for a slot. Capacity and operation-queue waiting are separate from the browser action deadline. Admitted workflows can finish their current interactions while others wait; new tasks join the admission queue even when their profile is already open, so a stream of new same-profile tasks cannot jump older waiting profiles.

Ordinary worker scheduling preserves an admitted browser workflow, including partially completed login and form state. A task actually waiting for Chrome capacity lends its worker so the current Chrome owner can finish. Before using a newly granted browser slot, the waiting task must regain a worker; if readmission loses its turn, it returns the unused new browser reservation and retries. This avoids a worker/browser wait cycle even with one worker and one browser slot. An explicit room pause still releases that task's browser reservation at its operation boundary.

Bots can use `browser_release` at a completed or safely restartable workflow checkpoint before deferring to a teammate or a long external wait. It releases only the current task's reservation, with no website interaction or extra approval. Another task may then reclaim the Chrome window; the profile remains saved. Do not release during incomplete login, form entry, pending file submission, or an action whose result is uncertain. The server refuses release during an active/pending browser operation or interrupted-operation recovery. If another task also holds that browser, its reservation stays intact.

The next `browser_use` automatically acquires or starts the same profile again. It must list current tabs and take a fresh snapshot before acting; old page/state/element IDs are not a continuation contract. Bots coordinate by concrete requests, results and saved work, without borrowing another bot's browser or sharing cookies automatically. `send_message` still queues a teammate's task and returns immediately; it does not create an implicit wait or change existing work-completion routing. A completed task automatically releases its reservation even if it never called `browser_release`.

### Upgrading existing browser choices

The room-isolation upgrade changes existing **Shared Chrome** choices and omitted legacy choices to **Dedicated Chrome** once, before any task starts. Dedicated and disabled choices remain as configured. The previous browser choice, including whether it was absent, is retained in private migration records in the database. Existing shared and bot-only profile folders are left untouched; no live profile is copied or adopted as a new room's profile. Sign in to each new dedicated browser when first needed.

After this one-time migration, you can deliberately select **Shared Chrome** again. That choice survives restarts and data transfers. Shared Chrome is an exception to room isolation: every bot selecting it, in any room, can see its tabs and use its signed-in sessions. Chrome control and its permissions remain unchanged by the migration. A database transferred from an older release is migrated on startup; a transferred completed migration marker prevents reapplying the change. Data transfer includes Loom's dedicated Chrome profile folders; site logins may still need renewal on another operating system or user account. Ordinary existing-Chrome profiles outside the Loom data directory are not copied.

The connection modes below configure only this **shared** browser. They do not change the connection used by dedicated room-and-bot browsers.

### Existing Chrome

1. On the Loom server computer, open **Chrome 144 or newer** using the profile you want to control.
2. Open `chrome://inspect/#remote-debugging` in Chrome and enable remote debugging.
3. In Loom choose **Existing Chrome**, then **Save and connect**.
4. Accept the connection request displayed by Chrome. Return to Loom to see the connection state and available tabs.

This connects to the active default Chrome profile and can see its open windows and signed-in pages. Chrome controls whether to allow the debugging connection. Loom cannot accept that Chrome consent prompt itself. See the upstream [automatic connection instructions](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#automatically-connecting-to-a-running-chrome-instance).

### Shared dedicated Chrome

Choose **Dedicated Chrome** and **Save and connect**. Loom opens the installed stable Chrome in a visible desktop window with its own persistent profile at `<LOOM_DATA_DIR>/browser-profile`. Sign into sites in that window when necessary. This profile is separate from your ordinary Chrome profile.

Disconnecting closes this dedicated Chrome process but retains its profile. Disconnecting existing Chrome detaches Loom without closing the user's browser. Stop Loom before copying or backing up the profile.

### Dedicated Chrome startup and ownership

From 0.15.1, Loom starts installed stable Chrome directly as a normal visible desktop process, then connects the bundled MCP through DevTools. This also applies to room-and-bot browsers and the shared dedicated browser. No manual debugging-port setup is needed. Restart Loom after updating; the room-isolation upgrade uses the new dedicated profiles described above.

Each process receives its own explicit nonzero debugging port bound to `127.0.0.1`. Loom reads the exact WebSocket endpoint from that child's startup output and verifies the browser process ID before allowing MCP page operations. It does not discover or adopt another browser from a shared port. If the profile is already open elsewhere, close that window before reconnecting; Loom never kills a browser based on an old profile record.

Dedicated startup does not use `--enable-automation`, `--remote-debugging-pipe`, a zero debugging port, headless mode, a disabled sandbox or JavaScript overrides of browser identity. This avoids the previous automation launch configuration; it does not guarantee compatibility with a site's registration or abuse-prevention systems. A successful click or HTTP response does not establish that email verification or account creation completed.

The local DevTools endpoint grants control of that Chrome profile to software that can reach it. Keep it on the local computer and do not expose or forward its port. Bot profile separation protects site sessions from accidental sharing; it is not isolation from other software running under the same operating-system account.

### Where Chrome runs

The browser and Loom's Node server must run on the **same computer and desktop session**. Opening Loom's web UI on Windows does not let a remote Linux server control that Windows Chrome. A normal Docker or headless installation does not include Chrome or a desktop and cannot use this feature as supplied.

For example, run Loom and Chrome on Windows, then point Loom's language-model URL at your separate GPU machine. The inference server can remain remote; browser control and local file operations stay on Windows.

## What a bot can do

The `browser_use` tool supports:

| Operation            | Behavior                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| Tabs                 | List Chrome tabs and their page IDs.                                         |
| Open / navigate      | Open an HTTP(S) URL in a new tab or navigate an observed tab.                |
| Snapshot             | Read a bounded accessibility tree with element IDs and page state.           |
| Click / fill / hover | Operate an element from the latest snapshot.                                 |
| Upload file          | Attach verified workspace files to an observed file input or chooser button. |
| Keys / scroll        | Send page keys or scroll in a chosen direction.                              |
| Screenshot           | Save a viewport screenshot as a chat attachment.                             |
| Dialog               | Accept or dismiss an observed page dialog.                                   |
| Close                | Close an observed tab.                                                       |

Try: “List the Chrome tabs, then summarize the article in the tab titled ….” For a new page: “Open https://example.com and summarize it.” The second request includes a navigation action and therefore asks for approval under the default policy.

The model must support OpenAI-compatible tool calls. A **text-only local LLM can use snapshots**, click controls, fill fields and attach files; image input is not required. Canvas-only content and controls absent from the accessibility tree may be difficult to operate. Arbitrary JavaScript execution, browser/DevTools shortcuts, cookie extraction, raw network-header inspection, extension installation and direct filesystem navigation are not exposed by this tool.

### Text replacement

`fill` replaces the selected text field's full value, including an empty string to clear it. Loom checks visibility, editable state and focus, applies the native field setter, notifies the page through input/change events, and verifies the exact resulting value after rendering. This avoids clearing a controlled field without notifying the page and then appending text to a value restored by its framework. Native select, date and range controls retain the pinned MCP's behavior.

The fixed internal DOM adapter does not expose JavaScript execution to the model. Its DOM events are not trusted keyboard events; a site that requires native keystrokes or transforms the value can still reject a fill. Rejected, changed or interrupted inputs return an error without automatically repeating a write. Take a fresh snapshot and inspect the field and next control before continuing. Field verification confirms the input value, not a later submission, email delivery or remote registration.

### Saved service credentials

The service editor lets you choose a **Room scope**, **Managing bot** and multiple **Shared bots**. A currently enabled room member with either bot assignment can use a saved credential in Chrome only when the service is available in that room; only the manager can change the service through bot tools. New registrations default to the current room, and all-room sharing requires an explicit choice. For example, ask: “Use the saved account for this service to sign in.” The bot first reads the current service reference through `list_service_accounts`, opens its `loginUrl` when sign-in is needed and inspects a fresh page snapshot. It then requests:

```json
{
  "operation": "fill",
  "serviceId": "service_example",
  "expectedRevision": 3,
  "pageId": 7,
  "stateId": "the-current-snapshot-state-id",
  "uid": "the-observed-password-field-uid"
}
```

Use the actual IDs and revision returned by Loom and omit `text`. Loom retrieves the saved value only when the reviewed action is about to execute and applies it directly to the password field. The model receives an operation result, not the secret. For an assigned saved password, **Auto** and **Allow** permit this fill without another approval; explicit **Ask** requires review and **Deny** blocks it. Disabled Chrome also blocks it. This exception uses an internal validated service binding and does not automatically allow ordinary text entry, clicks or form submissions. The approval identifies the service, login, revision, destination and observed field without showing the value.

Both the top page and the input's frame must match the service's resolved credential origin: scheme, host and port. An unrelated authentication host, cross-origin iframe or ordinary visible text field cannot receive the saved value through this operation. The bot must remain enabled and authorized in the current room, the service must be in that room or deliberately shared across rooms, it must not be disabled, and its revision must still match when the action executes. These checks occur again immediately before reading the stored value. Changing the service's room or sharing while approval is pending invalidates the old request. Service sharing does not grant mail access or change Chrome permission.

The working service URL and authentication destination are separate. Gmail (`https://mail.google.com`) automatically uses `https://accounts.google.com`; Amazon Associates Japan (`https://affiliate.amazon.co.jp`) starts at its official `/login` entry and uses `https://www.amazon.co.jp` for password input. Exact HTTPS origins are used, not domain suffix matching or arbitrary redirect discovery. Existing registrations receive this metadata at startup without reading or rewriting saved encrypted values. Other services retain their original origin unless a separate login entry is deliberately registered. Working-URL edits preserve that entry.

Credential failures include a safe structured code, next action and whether input was issued. A destination mismatch occurs before input and is not a missing or incorrect password. Stale service references need a new service listing; stale page state needs a fresh snapshot. An input result marked uncertain must be observed before any retry. Diagnostics contain public service references and origins, never raw adapter exceptions or password values.

Service room scope and Chrome profile scope are separate controls. Dedicated Chrome now separates the same bot's cookies and signed-in sessions by room. Explicit **Shared Chrome** still shares site sessions across rooms, even though saved service credentials remain room-scoped. The historical v0.18.0 service migration did not modify browser profiles; see [existing service registrations](MAIL.md#existing-service-registrations) for the registry and credential boundaries.

The stored value is omitted from tool arguments, activities, approvals, operation records and the fill receipt. During the current browser-control lifetime, Loom also redacts known applied values from subsequent textual snapshots, tab metadata and diagnostics. The destination site receives the value and may process it immediately; this does not control that site's handling of it or redact arbitrary screenshots. This operation is limited to password-field application. It does not expose a plaintext-reading tool, inject API authorization headers or submit the form automatically. Inspect the resulting page before the next action; a verified field value is not proof of a successful login.

### File uploads

Ask, for example: “Attach `reports/monthly.pdf` from this room's working folder to the upload form in the open tab.” The bot uses `browser_use` with `operation: "upload_file"`, an observed `pageId`, `stateId` and `uid`, and workspace-relative `filePaths`. A file input or a visible button that opens its file chooser can be targeted. Writing a path with `fill` does not attach a file.

Files must exist, be readable regular files and contain at least one byte. The task's current workspace boundary and existing private-file exclusions apply, including symlink checks. Absolute paths, URLs, credentials and files from another workspace are rejected before approval. This operation does not accept chat image IDs; save the intended file in the working folder first.

#### Upload limits

Set the following under **Settings → Chrome control → File uploads**. One MiB is 1,048,576 bytes.

| Setting                  | Stored browser field |  Default | Allowed range |
| ------------------------ | -------------------- | -------: | ------------: |
| Maximum files per upload | `uploadMaxFiles`     |       10 |         1–100 |
| Maximum file size        | `uploadMaxFileMiB`   |  256 MiB |    1–1024 MiB |
| Maximum total per upload | `uploadMaxTotalMiB`  |  512 MiB |    1–2048 MiB |
| Temporary upload storage | `uploadStorageMiB`   | 2048 MiB |   1–32768 MiB |

Values must be whole numbers and satisfy **file size ≤ total per upload ≤ temporary storage**. The storage budget is shared across browser sessions under the same Loom data directory and includes retained copies. Older settings that omit these fields inherit the defaults; explicit saved values survive unrelated settings changes and data transfers. Invalid values are rejected rather than rounded or silently replaced.

These limits can change while tasks are active. Loom uses the current limits for new requests and checks them again immediately before issuing an upload that waited for approval or browser access. A lower limit may therefore refuse an already reviewed upload. Completed operation receipts are returned without sending the files again, even when limits or source files have since changed.

The current reader holds the reviewed bytes in memory while approval is pending. Raising the file or total limit, or allowing several large pending uploads, increases RAM use. The temporary storage budget bounds disk copies; it is not a cap on total process memory.

The approval shows the destination page, element label, relative paths, filenames, byte sizes and content hashes. Smart auto-approve requests review for uploads; Allow follows the existing browser permission without another approval. Loom checks both the page and the original files again after waiting. Changed files or workspace settings require a fresh operation. File bytes and private staging paths do not enter approval cards or the operation journal.

#### Temporary copies and cleanup

Loom gives Chrome **one private immutable copy per file** so later changes to the source cannot corrupt a pending form submission. Copies under `<LOOM_DATA_DIR>/browser-uploads/` remain available for later page reads and submit clicks. The adapter negotiates access to this private directory without exposing the workspace root or disabling filesystem restrictions.

Cleanup depends on evidence that Chrome has ended. Normal dedicated-browser disconnect and application shutdown close Chrome and reclaim its copies when termination is confirmed. Loom can also reclaim an owned session after its dedicated Chrome has actually exited even if the MCP connection remains open. For existing Chrome, a process ID obtained through public CDP allows the same later exit check; detaching Loom alone leaves that browser running and does not qualify for cleanup.

Loom checks for reclaimable copies at startup and every 30 seconds. The periodic timer does not keep the server process alive. After an abnormal shutdown, a session is reclaimed only when its recorded Loom owner and MCP processes are gone **and every recorded Chrome generation has termination evidence**. An MCP close event by itself is insufficient.

Live processes, unknown identity, permission errors when checking a process (`EPERM`), incomplete records and legacy 0.12 sessions without this proof are retained and counted against the storage budget. If space is insufficient, Loom refuses a new attachment; it does not evict a copy that Chrome might still need. Finish pending submissions and close the relevant Chrome, or review the configured budget. Older or unidentifiable copies may need manual cleanup: after the associated submissions are finished or cancelled and the browsers have exited, stop Loom before removing the corresponding session files. Keep copies whose ownership or browser lifetime is still uncertain.

Some websites send files as soon as they are selected; others require a separate submit action. A successful `upload_file` result confirms file selection, **not final delivery**. The bot must inspect the site's result before continuing. Completed upload operations are restored from the journal rather than repeated; a failed or uncertain result is not automatically retried.

The production `upload_file` action has a **five-minute timeout** to allow larger files to be prepared and selected. This is the browser operation's deadline, not a promise to wait for the website's eventual upload or submission to finish. Other browser action timeouts are unchanged.

#### Japanese filenames on Linux

Version 0.12.0 fixes a launch-locale problem reproduced with real Chrome on Linux: the MCP child environment omitted locale settings, and a Japanese-named file disappeared from a two-file selection while the ASCII-named file remained. Waiting ten seconds did not restore the missing file. Passing the locale settings to the child process fixed the same sandbox-enabled browser check, including actual multipart submission. See the [before-and-after validation](VALIDATION.md#historical-validation-version-0120).

Loom now inherits `LANG`, `LANGUAGE`, `LC_ALL` and `LC_CTYPE` through its explicit environment allowlist. If `LANG`, `LC_ALL` and `LC_CTYPE` are all absent on Linux, it supplies `LANG=C.UTF-8`. Explicit locale values remain unchanged, including an explicitly selected non-UTF-8 locale.

After updating and restarting Loom, disconnect and reconnect the affected bot's **Dedicated Chrome** so Chrome starts with the new environment. Complete or cancel pending form submissions before closing that browser, then take a fresh snapshot and inspect the newly selected files. Reconnecting to **Existing Chrome** does not restart its external process or change the locale with which it was launched.

### Screenshot image input

Screenshots are shown and saved in chat regardless of image-input support. To include their pixels immediately, enable both **Settings → Model connection → Enable image input** and **Settings → Chrome control → Send screenshots to the model when captured**. Both are off for new installations. The conversation model and its serving endpoint must support OpenAI-compatible image input; neither setting adds vision support to a text-only model.

The Chrome setting controls capture-time inclusion only. When it is off, a bot with general image input enabled can still call `view_image` with the saved screenshot's `imageId` to inspect it later. `room_context` exposes references to older images in the same room. General image input also supports PNG, JPEG and WebP in the task's working folder with Chrome disabled; see [image input sources and limits](MODELS.md#image-input). Images are selected explicitly, not all included automatically.

Older settings without `model.imageInput` inherit the saved screenshot opt-in; an explicit model-wide choice takes precedence. Turning general image input off filters tool-image pixels from later model requests, including previously stored results in a continued bot session. It does not delete attachments or existing Pi session files. After context compaction, a textual image receipt can guide another explicit read of the saved source when image input is enabled.

## Permissions and visible actions

Chrome has its own permission setting, separate from ordinary HTTP/search network permissions:

| Setting            | Behavior                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Smart auto-approve | Automatically permits tab lists, snapshots and screenshots. Other operations request approval. |
| Ask                | Requests approval for every browser operation.                                                 |
| Allow              | Permits browser operations without individual approval cards.                                  |
| Deny               | Disconnects Chrome and refuses browser operations.                                             |

Approval cards include the operation, page URL, element label where available, and exact arguments such as typed text. Page labels and content are untrusted website data. Enter can submit a form, and some sites save a field immediately after typing. Loom shows these actions in the same activity stream as other bot tools.

Browser interaction is serial within each browser, independently of the configured LLM concurrency. Bots explicitly selecting shared Chrome share its operation queue and sign-in across rooms. Dedicated room-and-bot browsers have independent queues. Routing uses the task's trusted room ID and bot ID; the model cannot choose another room's or bot's profile. Loom rechecks room membership and availability before use. Each interaction requires a fresh snapshot state; Loom checks the tab URL and relevant element or focus again before acting. A changed page produces an error and requires another snapshot instead of applying an old approval to a new target. These checks reduce stale actions; they cannot make a changing website transactional or guarantee exactly-once effects.

Loom's own control pages are protected from browser tools. This helps prevent a bot from using the browser to approve its own requests. Browser operations otherwise use the permissions and signed-in sessions of the selected Chrome profile; they are not an OS sandbox.

## Stop, disconnect and recovery

**Disconnect** cancels connection attempts and waiting browser work for the selected browser. Disconnecting a dedicated browser affects only that room-and-bot combination, including when the same bot is active in another room. Disconnecting shared Chrome affects every bot using it. After an explicit disconnect, tools cannot reconnect until you explicitly connect again, or disable and re-enable browser control. Disabling the feature or selecting Deny disconnects every browser. Merely polling connection status never starts Chrome or calls a language model.

Deleting a room closes its dedicated browsers without disconnecting other rooms' dedicated browsers. Its saved Chrome profiles and site logins are retained. Disabling or deleting a bot releases its browsers across rooms. Neither action undoes operations already sent to a website.

Pausing a room does not immediately disconnect browsers or abort their current operations. At the next operation boundary, the task pauses and releases its browser reservation; an idle Chrome can then be reclaimed for other work. Ordinary worker scheduling is different: it retains that reservation so another task's turn cannot discard an unfinished form. Individual task cancellation may reset that task's browser connection, and already-issued website actions are not rolled back.

Changing connection mode requires disconnecting first and stopping active bot tasks. Finish or interrupt active bot tasks before changing general image input or capture-time screenshot inclusion; pausing a room alone keeps its active task settings pinned. General image input also stays pinned during prompt-assistance and avatar-generation jobs. Permissions and the browser-enabled switch can be changed while work is active; a queued operation checks permission again before issuance. An operation already sent to a website may have taken effect when cancellation arrives.

Completed actions return a historical receipt during recovery instead of issuing the same operation again. That receipt does not include the old page content, tab ID or snapshot state, and explicitly says that the current page has not been observed. Use `tabs` and a fresh `snapshot` to inspect what is present now; a previous successful action does not establish the current page state.

A new `open` call can visit the same URL again within a task or a later work continuation. Recovering the same tool call does not open another tab. Older completed URL-based receipts do not block a new visit. Failed or uncertain opens still require outcome review before another attempt, including through a new tool call. Clicks, uploads and other interactions retain their existing duplicate protections. Opening a page still follows the current Chrome permission and requests approval under Smart auto-approve.

Since 0.22.1, a dedicated Chrome has an owner process separate from its replaceable MCP connection. A recoverable operation timeout or MCP failure stops the old MCP before reconnecting to the same verified Chrome process. Tabs, session state and issued upload copies remain available while that Chrome is alive. The connection generation and observed states are invalidated, so a late result or old element ID cannot become a new approved action. A subsequent read automatically reattaches; a lost read of the tab list has a bounded retry. Website mutations are never replayed automatically.

An action whose MCP call returned but whose following page capture failed returns an **action receipt with observation unavailable**, not a fresh page state or proof of website success. The bot must read tabs and a fresh snapshot to establish the result. A failure while a mutation is in flight remains an uncertain outcome and requires inspection before another action. Diagnostics distinguish the current phase, operation outcome and elapsed time. Immutable timeout errors retain their timeout identity when sanitized.

Explicit disconnect, idle capacity reclamation and application shutdown still close an owned dedicated Chrome and retain its profile. The owner watches its parent connection and cancels startup or closes Chrome if Loom exits. Graceful browser closure has bounded termination fallbacks; unknown exit evidence never authorizes deleting upload copies. A manually closed or crashed Chrome invalidates the connection and its observed states; a new process cannot preserve unsaved page state. The adapter has finite connection/action timeouts and bounded snapshots and viewport images, and runs the pinned installed package without `npx`, runtime downloads, package configuration discovery, usage statistics, CrUX requests or update checks. Websites retain their ordinary network behavior.

Operation guards read current settings and the affected room, bot, task and service directly, rather than rebuilding all conversation history for each MCP call. Checks still run before issuance and after waits; permission, membership or service-revision changes are not hidden behind a long-lived cache.

## Troubleshooting

- **Existing Chrome cannot connect:** check Chrome's version, the remote-debugging switch, the selected desktop profile and the Chrome consent prompt. Close another conflicting debugging connection, then reconnect.
- **Dedicated Chrome cannot start:** install stable Google Chrome on the Loom server computer and start Loom in an active desktop session. The supplied container does not provide that environment.
- **A dedicated profile is already in use:** close that profile's other Chrome window, then reconnect. Keep ordinary personal Chrome open; it uses a different profile. Do not delete profile locks while a Chrome process may still be running.
- **A filled email does not advance:** update to 0.15.1 or later, restart Loom and reopen dedicated Chrome. Check the exact field value, enabled state and resulting screen with a fresh snapshot. The launch and replacement fixes do not prove a particular site's registration succeeded.
- **A page state is stale:** ask the bot to take a new snapshot before choosing the next action. Another bot or manual user interaction may have changed the tab.
- **Opening a page returns an old result after a wake-up:** update to 0.16.1 or later and restart Loom. A new open call can revisit the URL; recovered operation receipts no longer present old page snapshots as current. Use a fresh tab list and snapshot to inspect the page.
- **A file is empty, missing or changed:** place a complete, nonempty file in the task's working folder and take a fresh page snapshot before choosing it again. Typing its path into a file field does not select it.
- **An upload exceeds a limit or storage is full:** review all four upload settings and their file ≤ total ≤ storage relationship. Finish pending submissions and close their Chrome to release provably unused copies. Lowering a limit does not delete retained copies; legacy or unidentified sessions may require the [manual cleanup](#temporary-copies-and-cleanup) described above.
- **Large pending uploads consume too much RAM:** reduce the individual/combined limits or the number of simultaneous pending uploads. Increasing the temporary disk budget does not reduce the memory used by approval buffers.
- **A Japanese filename disappears on Linux:** update to 0.12.0 or later, restart Loom and reconnect the affected dedicated Chrome. The [locale fix](#japanese-filenames-on-linux) addresses the reproduced Linux case. If a different site or manual selection still fails, inspect its selected filenames, byte sizes and error; the synthetic browser check does not identify that environment's cause.
- **A connection or action times out:** the bot first reads tabs and a fresh snapshot so Loom can recover the operation connection while retaining a live Chrome. Use the reported phase and outcome to distinguish an unissued action from an uncertain submission or unavailable observation. Do not repeat a submission just because its result could not be captured. An explicit disconnect closes the owned Chrome and should not be the first recovery step.
- **The model cannot see a screenshot:** use snapshots with a text model, or select an image-capable model and server and enable general image input. Enable capture-time screenshot inclusion to send it immediately, or ask the bot to inspect the saved image explicitly. Check the [image limits](MODELS.md#image-input) if a capture is saved without pixels being sent.
- **A tool is missing after upgrading:** stop Loom, run `git pull --ff-only`, `npm ci`, and `npm run build`, then restart.

## Maintenance

The Chrome lifecycle and input shims wrap internal browser-management and locator APIs in the pinned **`chrome-devtools-mcp` 1.12.0** package. Updating that dependency requires reviewing these hooks and rerunning the input, process-proof, storage and real Chrome checks; the wrapper cannot be assumed compatible with a different package layout. Existing-Chrome process identification uses public CDP, and missing process evidence keeps cleanup conservative.

The [validation record](VALIDATION.md) distinguishes deterministic tests, the real Chrome CI smoke check, and the interactive environments not verified by those tests.
