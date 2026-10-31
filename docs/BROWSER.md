# Chrome control

Loom can let its bots operate **Google Chrome on the computer running the Loom server**. It bundles the official [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) server and connects it to Pi's normal tool loop. Install Loom with `npm ci`; no separate MCP configuration, Python service, browser-use account, or additional model endpoint is needed. This is not an integration of the separate Python `browser-use` agent.

Chrome is supplied by the operator. The bundled dependencies do not download a browser. Browser control is disabled by default, and ordinary startup or opening Settings does not connect to Chrome.

## Connect

Open **Settings → Chrome control** and enable it. Choose one of these connection modes.

### Existing Chrome

1. On the Loom server computer, open **Chrome 144 or newer** using the profile you want to control.
2. Open `chrome://inspect/#remote-debugging` in Chrome and enable remote debugging.
3. In Loom choose **Existing Chrome**, then **Save and connect**.
4. Accept the connection request displayed by Chrome. Return to Loom to see the connection state and available tabs.

This connects to the active default Chrome profile and can see its open windows and signed-in pages. Chrome controls whether to allow the debugging connection. Loom cannot accept that Chrome consent prompt itself. See the upstream [automatic connection instructions](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#automatically-connecting-to-a-running-chrome-instance).

### Dedicated Chrome

Choose **Dedicated Chrome** and **Save and connect**. Loom opens the installed stable Chrome in a visible desktop window with its own persistent profile at `<LOOM_DATA_DIR>/browser-profile`. Sign into sites in that window when necessary. This profile is separate from your ordinary Chrome profile.

Disconnecting closes this dedicated Chrome process but retains its profile. Disconnecting existing Chrome detaches Loom without closing the user's browser. Stop Loom before copying or backing up the profile.

### Where Chrome runs

The browser and Loom's Node server must run on the **same computer and desktop session**. Opening Loom's web UI on Windows does not let a remote Linux server control that Windows Chrome. A normal Docker or headless installation does not include Chrome or a desktop and cannot use this feature as supplied.

For example, run Loom and Chrome on Windows, then point Loom's language-model URL at your separate GPU machine. The inference server can remain remote; browser control and local file operations stay on Windows.

## What a bot can do

The `browser_use` tool supports:

| Operation            | Behavior                                                           |
| -------------------- | ------------------------------------------------------------------ |
| Tabs                 | List Chrome tabs and their page IDs.                               |
| Open / navigate      | Open an HTTP(S) URL in a new tab or navigate an observed tab.      |
| Snapshot             | Read a bounded accessibility tree with element IDs and page state. |
| Click / fill / hover | Operate an element from the latest snapshot.                       |
| Keys / scroll        | Send page keys or scroll in a chosen direction.                    |
| Screenshot           | Save a viewport screenshot as a chat attachment.                   |
| Dialog               | Accept or dismiss an observed page dialog.                         |
| Close                | Close an observed tab.                                             |

Try: “List the Chrome tabs, then summarize the article in the tab titled ….” For a new page: “Open https://example.com and summarize it.” The second request includes a navigation action and therefore asks for approval under the default policy.

The model must support OpenAI-compatible tool calls. A **text-only local LLM can use snapshots**, click controls and fill fields; image input is not required. Canvas-only content and controls absent from the accessibility tree may be difficult to operate. Arbitrary JavaScript execution, browser/DevTools shortcuts, cookie extraction, raw network-header inspection, file uploads, extension installation and direct filesystem navigation are not exposed by this tool.

Screenshots are shown in chat regardless of image-input support. **Send screenshots to the model** is off by default. Enable it only for a vision model whose serving endpoint supports OpenAI-compatible image input. When enabled, screenshot pixels are included in the following model request and may also remain in the local Pi session history. Changing the setting does not erase previous session history or saved attachments. It does not add vision support to a text-only model.

## Permissions and visible actions

Chrome has its own permission setting, separate from ordinary HTTP/search network permissions:

| Setting            | Behavior                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Smart auto-approve | Automatically permits tab lists, snapshots and screenshots. Other operations request approval. |
| Ask                | Requests approval for every browser operation.                                                 |
| Allow              | Permits browser operations without individual approval cards.                                  |
| Deny               | Disconnects Chrome and refuses browser operations.                                             |

Approval cards include the operation, page URL, element label where available, and exact arguments such as typed text. Page labels and content are untrusted website data. Enter can submit a form, and some sites save a field immediately after typing. Loom shows these actions in the same activity stream as other bot tools.

Browser interaction is serial across bots, independently of the configured LLM concurrency. Each interaction requires a fresh snapshot state; Loom checks the tab URL and relevant element or focus again before acting. A changed page produces an error and requires another snapshot instead of applying an old approval to a new target. These checks reduce stale actions; they cannot make a changing website transactional or guarantee exactly-once effects.

Loom's own control pages are protected from browser tools. This helps prevent a bot from using the browser to approve its own requests. Browser operations otherwise use the permissions and signed-in sessions of the selected Chrome profile; they are not an OS sandbox.

## Stop, disconnect and recovery

**Disconnect** also cancels connection attempts and queued browser work. After an explicit disconnect, tools cannot reconnect until you choose **Save and connect**, or disable and re-enable browser control. Disabling the feature or selecting Deny also disconnects it. Merely polling connection status never starts Chrome or calls a language model.

Changing connection mode requires disconnecting first and stopping active bot tasks. Changing whether model requests include screenshot images requires stopping active bot tasks. Permissions and the enabled switch can be changed while work is active; a queued operation checks permission again before issuance. An operation already sent to a website may have taken effect when cancellation arrives.

Completed mutation records are reused during task resume instead of issuing the same operation again. If a previous action failed or was cancelled after issuance, Loom refuses automatic replay of that exact recorded action. Inspect a fresh page snapshot and choose how to continue.

The adapter has finite connection/action timeouts, bounded snapshots and viewport images, and shuts down its MCP child on disconnect or application shutdown. It runs the pinned installed package without `npx`, runtime downloads, package configuration discovery, Chrome DevTools MCP usage statistics, CrUX requests or update checks. Websites retain their ordinary network behavior.

## Troubleshooting

- **Existing Chrome cannot connect:** check Chrome's version, the remote-debugging switch, the selected desktop profile and the Chrome consent prompt. Close another conflicting debugging connection, then reconnect.
- **Dedicated Chrome cannot start:** install stable Google Chrome on the Loom server computer and start Loom in an active desktop session. The supplied container does not provide that environment.
- **A page state is stale:** ask the bot to take a new snapshot before choosing the next action. Another bot or manual user interaction may have changed the tab.
- **A connection or action times out:** check Chrome, disconnect and reconnect. Inspect the page before repeating a submission.
- **The model cannot see a screenshot:** use snapshots with a text model, or select an image-capable model and explicitly enable screenshot input.
- **A tool is missing after upgrading:** stop Loom, run `git pull --ff-only`, `npm ci`, and `npm run build`, then restart.

The [validation record](VALIDATION.md) distinguishes deterministic tests, the real Chrome CI smoke check, and the interactive environments not verified by those tests.
