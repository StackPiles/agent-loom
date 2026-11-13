# Chrome control

Loom can let its bots operate **Google Chrome on the computer running the Loom server**. It bundles the official [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) server and connects it to Pi's normal tool loop. Install Loom with `npm ci`; no separate MCP configuration, Python service, browser-use account, or additional model endpoint is needed. This is not an integration of the separate Python `browser-use` agent.

Chrome is supplied by the operator. The bundled dependencies do not download a browser. Browser control is disabled by default, and ordinary startup or opening Settings does not connect to Chrome.

## Connect

Open **Settings → Chrome control** and enable it. Then open a bot's settings and choose **Dedicated Chrome**, **Shared Chrome**, or **Disabled** for that bot. Global browser permissions and capture-time screenshot settings apply to every bot.

### A browser for each bot

New bots, including the initial teammates on a new installation, default to their own dedicated Chrome. Existing bots without a browser choice keep using the shared browser, preserving their previous sign-in. Save the bot's setting, then use its **Open Chrome** control to sign into sites manually. Bots also start their browser lazily when they first use it.

Each dedicated browser has its own connection, operation queue, tabs and persistent profile under `<LOOM_DATA_DIR>/browser-profiles/<bot-id-hash>/`. Renaming a bot does not change its profile. The same bot uses the same profile across rooms. Closing the browser keeps the profile; a new dedicated profile does not copy the shared browser's cookies or sign-ins.

**Maximum open browsers** defaults to 3 and can be set from 1–16, independently of model concurrency. It counts shared and bot-specific browsers together. At capacity, Loom closes an idle browser to make room while keeping its profile. A task holds its browser from first use until it finishes, including model thinking between actions and browser approvals; if all slots are in use, the next bot waits. Separate bot browsers can operate concurrently. Browser separation isolates site sessions, not operating-system permissions.

The connection modes below configure the **shared** browser used by bots that explicitly select Shared Chrome.

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

From 0.15.1, Loom starts installed stable Chrome directly as a normal visible desktop process, then connects the bundled MCP through DevTools. This applies to bot-specific browsers and the shared dedicated browser. The saved profile paths and first-use automatic startup remain the same; no manual debugging-port setup is needed. Restart Loom and reopen dedicated Chrome after updating.

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

The service editor lets you choose a **Managing bot** and multiple **Shared bots**. Any currently enabled bot with either assignment can use a saved credential in Chrome; only the manager can change the service through bot tools. For example, ask: “Use the saved account for this service to sign in.” The bot first reads the current service reference through `list_service_accounts`, opens the service and inspects a fresh page snapshot. It then requests:

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

Use the actual IDs and revision returned by Loom and omit `text`. Loom retrieves the saved value only when the reviewed action is about to execute and applies it directly to the password field. The model receives an operation result, not the secret. The normal Chrome permission applies: **Auto** and **Ask** require review for this fill, **Allow** permits it, and **Deny** blocks it. The approval identifies the service, login, revision, destination and observed field without showing the value.

Both the top page and the input's frame must match the service URL's origin: scheme, host and port. A different login host, cross-origin iframe or ordinary visible text field cannot receive the saved value through this operation. The bot must remain enabled and authorized, the service must not be disabled, and its revision must still match when the action executes. Editing or revoking sharing while approval is pending invalidates the old request. Service sharing does not share browser cookies or profiles, grant mail access, or change Chrome permission.

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

Browser interaction is serial within each browser, independently of the configured LLM concurrency. Bots selecting the shared browser share its operation queue and sign-in. Dedicated bot browsers have independent queues. Routing uses the task's trusted bot ID; the model cannot choose another bot's profile. Each interaction requires a fresh snapshot state; Loom checks the tab URL and relevant element or focus again before acting. A changed page produces an error and requires another snapshot instead of applying an old approval to a new target. These checks reduce stale actions; they cannot make a changing website transactional or guarantee exactly-once effects.

Loom's own control pages are protected from browser tools. This helps prevent a bot from using the browser to approve its own requests. Browser operations otherwise use the permissions and signed-in sessions of the selected Chrome profile; they are not an OS sandbox.

## Stop, disconnect and recovery

**Disconnect** cancels connection attempts and waiting browser work for the selected browser. Disconnecting a dedicated bot browser does not reset other bots' dedicated connections. Disconnecting the shared browser affects bots using it. After an explicit disconnect, tools cannot reconnect until you explicitly connect again, or disable and re-enable browser control. Disabling the feature or selecting Deny disconnects every browser. Merely polling connection status never starts Chrome or calls a language model.

Pausing a room does not disconnect browsers or abort their current operations. Already-started tasks can finish. Individual task cancellation may reset that task's browser connection, and already-issued website actions are not rolled back.

Changing connection mode requires disconnecting first and stopping active bot tasks. Finish or interrupt active bot tasks before changing general image input or capture-time screenshot inclusion; pausing a room alone keeps its active task settings pinned. General image input also stays pinned during prompt-assistance and avatar-generation jobs. Permissions and the browser-enabled switch can be changed while work is active; a queued operation checks permission again before issuance. An operation already sent to a website may have taken effect when cancellation arrives.

Completed actions return a historical receipt during recovery instead of issuing the same operation again. That receipt does not include the old page content, tab ID or snapshot state, and explicitly says that the current page has not been observed. Use `tabs` and a fresh `snapshot` to inspect what is present now; a previous successful action does not establish the current page state.

A new `open` call can visit the same URL again within a task or a later work continuation. Recovering the same tool call does not open another tab. Older completed URL-based receipts do not block a new visit. Failed or uncertain opens still require outcome review before another attempt, including through a new tool call. Clicks, uploads and other interactions retain their existing duplicate protections. Opening a page still follows the current Chrome permission and requests approval under Smart auto-approve.

The adapter has finite connection/action timeouts, bounded snapshots and viewport images, and shuts down its MCP child on disconnect or application shutdown. The MCP wrapper also owns dedicated Chrome, cancels startup on client EOF, and waits for its exit before normal shutdown completes. Graceful browser closure has bounded termination fallbacks; unknown exit evidence never authorizes deleting upload copies. A manually closed or crashed dedicated Chrome invalidates the connection and its observed page states. It runs the pinned installed package without `npx`, runtime downloads, package configuration discovery, Chrome DevTools MCP usage statistics, CrUX requests or update checks. Websites retain their ordinary network behavior.

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
- **A connection or action times out:** check Chrome, disconnect and reconnect. Inspect the page before repeating a submission.
- **The model cannot see a screenshot:** use snapshots with a text model, or select an image-capable model and server and enable general image input. Enable capture-time screenshot inclusion to send it immediately, or ask the bot to inspect the saved image explicitly. Check the [image limits](MODELS.md#image-input) if a capture is saved without pixels being sent.
- **A tool is missing after upgrading:** stop Loom, run `git pull --ff-only`, `npm ci`, and `npm run build`, then restart.

## Maintenance

The Chrome lifecycle and input shims wrap internal browser-management and locator APIs in the pinned **`chrome-devtools-mcp` 1.12.0** package. Updating that dependency requires reviewing these hooks and rerunning the input, process-proof, storage and real Chrome checks; the wrapper cannot be assumed compatible with a different package layout. Existing-Chrome process identification uses public CDP, and missing process evidence keeps cleanup conservative.

The [validation record](VALIDATION.md) distinguishes deterministic tests, the real Chrome CI smoke check, and the interactive environments not verified by those tests.
