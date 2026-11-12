# App updates / アプリの更新

## 画面からの更新

どの画面でも上部の **アプリの更新** を開くと、現在の版・最新の版と変更番号・確認日時・更新結果を確認し、その場で更新できます。設定画面へ移動しないため、開いていた画面や入力中の内容を保てます。**設定 → アプリの更新** からも同じ操作を利用できます。上部のボタンは更新がないときも表示し、更新あり・更新中・更新完了を知らせます。狭い画面ではアイコンと状態の印で表示します。

起動後の画面から公式 `StackPiles/agent-loom` の `main` を確認し、通常は6時間ごとに再確認します。一時的な確認失敗や配布元のCI待ちでは15分ごとに再確認します。背景のタブでは定期確認を控え、画面へ戻ったときも期限が過ぎている場合だけ確認します。ウィンドウの切り替えや再接続のたびに配布元へ問い合わせることはありません。**更新を確認** は、その時点での確認を明示的に要求します。確認できない場合はその旨を表示し、「最新版」とは扱いません。同じバージョン番号でも変更が追加されていれば検知します。

**更新して再起動** は、表示した変更番号のCIが成功し、対応する更新方式である場合に使用できます。更新先のURL・ブランチ・コマンドを入力する操作はありません。確認だけではインストールしません。

v0.8.5では、確認した配布元とソースの変更番号が同じなのに実行中のバージョンが異なる場合、その不一致を表示します。同じ変更番号への再インストールは提示せず、修正版の確認を案内します。修正版が別の変更番号で公開されれば、通常の条件で更新できます。

| 起動方法                                                       | Web画面での更新                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Windows / macOS / Linux の公式Gitクローン、`main`、`npm start` | 対応。Gitの変更が保存済みで、実行中の作業がないことが条件です。                         |
| `node dist/server/index.js` の直接起動                         | 通知と手動手順。`npm start` で再起動すると、対応するクローンではWeb更新を利用できます。 |
| `npm run dev`                                                  | 通知と手動手順。本番ビルドと `npm start` が必要です。                                   |
| Docker                                                         | 通知とホスト側の更新手順。コンテナーからホストのDockerを操作しません。                  |
| ZIP展開・Git worktree・独自リポジトリー・別ブランチ            | 通知と手動手順。自動でブランチや接続先を書き換えません。                                |

### 手動での更新

**v0.5以前からは、最初の1回だけ手動で更新します。** 旧版には更新を管理するランチャーが入っていません。

手動更新する場合は、実行中の作業を終え、起動した端末で Ctrl+C を押してLoomの終了を待ち、通常のバックアップを取ってから、既存のリポジトリーのフォルダーで次を1行ずつ実行してください。`git status --short` でローカル変更が表示された場合は先に保存し、各コマンドが成功してから次へ進みます。

```sh
git status --short
git pull --ff-only
npm ci --include=dev
npm run build
npm start
```

PowerShellで `npm.ps1` が制限される場合は `npm.cmd` を使えます。起動後は画面を再読み込みしてください。以後、対応する更新はWeb画面から行えます。`npm start` を実行した端末は起動したままにしてください。

Dockerの場合はホストで次を実行します。

```sh
git pull --ff-only
docker compose up --build -d
```

### v0.8.4 のバージョン表示と更新の復旧

v0.8.4には、`package.json` が `0.8.4` なのにサーバー内の固定値が `0.8.3` のままという不具合がありました。Web更新では新版の起動応答が対象バージョンと一致せず、検証に失敗して旧版へ戻ります。端末でv0.8.4のソースを取得してビルドした場合も表示は `0.8.3` のままで、同じ変更番号へのWeb更新を再び試すと「すでにインストール済み」と拒否されます。

まず **設定 → アプリの更新** で更新を確認してください。修正版のv0.8.5が表示され、その変更番号のCIが成功していれば、**更新して再起動** で適用できます。v0.8.5は別の変更番号なので、v0.8.4が古いバージョンを報告していても更新対象になります。完了後は画面を再読み込みします。

Web更新を利用できない場合は、上記の手動手順で修正済みのソースを取得してからビルド・起動してください。未修正のv0.8.4を再ビルドするだけでは直りません。復旧のためにデータや `.git/loom-updates` のジャーナルを削除する必要はありません。

## 実行中の作業と画面

実行中の生成・ツール、休止していないボットの待機・承認待ち、アバター／プロンプト／画像テストの生成、メール送信、データ転送、処理中のAPIがある場合は更新を開始しません。ルームを休止した直後も、現在の処理を終えて休止地点へ達するまでは待ちます。更新を始める際は新規作業の受付と自動化を止め、もう一度状態を確認します。

**v0.7.6以降は、開始済みのタスクも、ランタイムが完全に休止したことを確認できれば更新できます。** 更新前にその実行を終了して会話・ツール結果・操作記録の保存を完了し、同じタスクを休止ルームの待機列へ戻します。未開始の待機タスクとルームの休止状態も保持します。更新後に勝手に動き出すことはなく、**「ルームを再開」** すると保存済みの履歴から続けます。

再起動をまたぐため、メモリ内の実行位置そのものを復元する仕組みではありません。完了済みの同一操作は保存した結果を使い、未完了・成否不明の操作を自動で繰り返しません。未決定の承認は取り消し、必要な操作は再開後に改めて確認します。更新の受付が確実に拒否された場合も、保存済みのタスクは休止した待機列に残ります。

### v0.7.5以前から初めて更新する場合

現在起動している旧版では、開始済みタスクが休止中でも更新をブロックします。修正版を入れる最初の1回は、完全に休止したタスクをアクティビティから個別に **「中断」** してから更新してください。ルームを休止したままLoomを通常終了・再起動してから更新する方法もあります。会話と完了済みの操作記録は残ります。この初回に手動で中断したタスクは、更新後に各タスクの **「再開」** を選びます。

更新時はサーバーをいったん停止するため、依存関係のインストールとビルド中に一時的に接続できなくなります。画面は更新要求のIDを保持し、更新中と受付結果が不明な間は2秒ごとに状態を読み取って再接続を待ちます。更新の画面を閉じても追跡は続き、通信が途切れても更新要求を自動で再送しません。完了後は **画面を再読み込み** して新版のUIを取り込みます。未保存の設定がある場合は、上部から開いた更新画面でもインストールと再読み込みを無効にします。先に設定の変更を保存または破棄してください。

## 保持されるデータと復旧

更新はアプリのソース・依存関係・ビルド成果物を交換します。`.env`、`.loom` または `LOOM_DATA_DIR`、外部の作業フォルダーを通常のGitクリーン処理で消去しません。更新状態や旧成果物はインストール固有の `.git/loom-updates` に置き、Loom間のデータコピーに含めません。

ランチャーは旧サーバーをIPCで正常終了させ、旧版の `dist` と `node_modules`、起動前のSQLiteと暗号鍵を保持します。新版は自動化とAPI変更操作を止めた検証状態で起動し、対象バージョン・変更番号と起動応答を確認した後に通常運転を開始します。

取得・インストール・ビルド・検証起動に失敗した場合は、変更が想定どおりで排他ロックを取得できる範囲で、旧コードと成果物へ復帰します。検証起動でDBが変わった場合も、通常運転に入る前なら保持したDBと鍵を復帰します。通常運転を有効にした後は、メール等の外部作用を二重実行しないため、古いDBへの自動巻き戻しをしません。

更新途中にランチャーが終了した場合、次の `npm start` でジャーナルを確認します。途中でソースが編集された、別プロセスがデータを使用している、復旧用ファイルが欠けている等の場合は強制上書きをせず、端末に理由を表示して復旧資料を保持します。`.git/loom-updates` を削除して無理に続行しないでください。この内部スナップショットは、生成画像や外部作業フォルダーまで含む通常のバックアップの代わりではありません。

この版では更新ごとの旧成果物と復旧資料を自動削除しないため、更新の回数に応じてディスク使用量が増えます。更新が完了し、通常のバックアップも確保できた後で整理してください。未完了の更新のジャーナルや復旧資料を削除しないでください。

## Implementation notes

The update source is the fixed official repository and its `main` commit. Package metadata and the latest push/main CI run are read at the exact observed SHA. A new major implementation of the updater can require a manual transition by changing `loomUpdateProtocol`; the v0.6 launcher accepts protocol 1 only.

`package.json` is the release version source. After both TypeScript compilation and the Vite build succeed, `scripts/build-version.mjs` captures that version in `dist/build-info.json`. Source execution reads the package version; compiled execution reads only this build snapshot and fails with rebuild guidance if it is missing or invalid. It does not fall back to the mutable checkout's package, so a source-only update cannot relabel an older build. Health, UI state, update metadata and the supervisor's ready IPC share this runtime version.

Discovery does not offer a known identical current/target SHA, even when the reported version differs. The UI diagnoses that mismatch instead of offering a redundant installation. A newer corrective release at a distinct SHA remains eligible for the normal CI, protocol and installation checks.

One app-wide provider owns discovery, install receipts and progress. Automatic discovery normally runs every six hours, with a fifteen-minute retry for transient errors or pending/unknown CI. Hidden pages defer discovery until they become visible and the deadline is due. Focus and online events do not cause idle status polling. Opening the global update dialog explicitly refreshes local status; it neither navigates away nor installs. Active or unresolved update requests retain two-second read-only status polling, including while hidden. Each mounted settings panel registers its own unsaved-change state, so opening a second update panel cannot bypass an existing settings draft. Both installation and page reload require the user’s explicit action.

`npm start` runs a Node-builtins-only supervisor. It launches the compiled server at the original checkout and data directory, retains the inherited configuration, and uses an IPC request/receipt/proceed exchange so the accepted HTTP response can be delivered before shutdown. An uncertain HTTP result is looked up by its request ID instead of being replayed.

The supervisor verifies the official origin, clean `main`, current source revision and fast-forward ancestry again before changing files. It uses explicit argument arrays. On Windows it invokes the npm CLI through the Node executable rather than executing `npm.cmd` as a native program. Install/build failures retain the previous artifacts, so rollback does not require re-downloading old dependencies.

See the primary references for [Node child-process IPC and Windows behavior](https://nodejs.org/download/release/v24.11.0/docs/api/child_process.html), [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/), [Git fast-forward-only merging](https://git-scm.com/docs/git-merge), and [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs).
