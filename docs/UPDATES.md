# App updates / アプリの更新

## 画面からの更新

**設定 → アプリの更新** で現在の版・最新の版と変更番号・確認日時・更新結果を確認できます。起動後の画面から公式 `StackPiles/agent-loom` の `main` を確認し、通常の確認結果は6時間保持します。更新があれば既存の上部バーに小さな通知を表示します。確認できない場合はその旨を表示し、「最新版」とは扱いません。同じバージョン番号でも変更が追加されていれば検知します。

**更新して再起動** は、表示した変更番号のCIが成功し、対応する更新方式である場合に使用できます。更新先のURL・ブランチ・コマンドを入力する操作はありません。確認だけではインストールしません。

| 起動方法                                                       | Web画面での更新                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Windows / macOS / Linux の公式Gitクローン、`main`、`npm start` | 対応。Gitの変更が保存済みで、実行中の作業がないことが条件です。                         |
| `node dist/server/index.js` の直接起動                         | 通知と手動手順。`npm start` で再起動すると、対応するクローンではWeb更新を利用できます。 |
| `npm run dev`                                                  | 通知と手動手順。本番ビルドと `npm start` が必要です。                                   |
| Docker                                                         | 通知とホスト側の更新手順。コンテナーからホストのDockerを操作しません。                  |
| ZIP展開・Git worktree・独自リポジトリー・別ブランチ            | 通知と手動手順。自動でブランチや接続先を書き換えません。                                |

**v0.5以前からは、最初の1回だけ手動で更新します。** 旧版には更新を管理するランチャーが入っていません。実行中の作業を終え、元のLoomを停止し、通常のバックアップを取ってから、リポジトリーのフォルダーで実行してください。

```sh
git pull --ff-only
npm ci
npm run build
npm start
```

PowerShellで `npm.ps1` が制限される場合は `npm.cmd` を使えます。以後、対応する更新はWeb画面から行えます。`npm start` を実行した端末は起動したままにしてください。

Dockerの場合はホストで次を実行します。

```sh
git pull --ff-only
docker compose up --build -d
```

## 実行中の作業と画面

実行中の生成・ツール、休止していないボットの待機・承認待ち、アバター／プロンプト／画像テストの生成、メール送信、データ転送、処理中のAPIがある場合は更新を開始しません。ルームを休止した直後も、現在の処理を終えて休止地点へ達するまでは待ちます。更新を始める際は新規作業の受付と自動化を止め、もう一度状態を確認します。

**v0.7.6以降は、開始済みのタスクも、ランタイムが完全に休止したことを確認できれば更新できます。** 更新前にその実行を終了して会話・ツール結果・操作記録の保存を完了し、同じタスクを休止ルームの待機列へ戻します。未開始の待機タスクとルームの休止状態も保持します。更新後に勝手に動き出すことはなく、**「ルームを再開」** すると保存済みの履歴から続けます。

再起動をまたぐため、メモリ内の実行位置そのものを復元する仕組みではありません。完了済みの同一操作は保存した結果を使い、未完了・成否不明の操作を自動で繰り返しません。未決定の承認は取り消し、必要な操作は再開後に改めて確認します。更新の受付が確実に拒否された場合も、保存済みのタスクは休止した待機列に残ります。

### v0.7.5以前から初めて更新する場合

現在起動している旧版では、開始済みタスクが休止中でも更新をブロックします。修正版を入れる最初の1回は、完全に休止したタスクをアクティビティから個別に **「中断」** してから更新してください。ルームを休止したままLoomを通常終了・再起動してから更新する方法もあります。会話と完了済みの操作記録は残ります。この初回に手動で中断したタスクは、更新後に各タスクの **「再開」** を選びます。

更新時はサーバーをいったん停止するため、依存関係のインストールとビルド中に一時的に接続できなくなります。画面は更新要求のIDを保持し、再接続時に結果を確認します。通信が途切れても更新要求を自動で再送しません。完了後は **画面を再読み込み** して新版のUIを取り込みます。未保存の設定がある場合は、先に保存または破棄してください。

## 保持されるデータと復旧

更新はアプリのソース・依存関係・ビルド成果物を交換します。`.env`、`.loom` または `LOOM_DATA_DIR`、外部の作業フォルダーを通常のGitクリーン処理で消去しません。更新状態や旧成果物はインストール固有の `.git/loom-updates` に置き、Loom間のデータコピーに含めません。

ランチャーは旧サーバーをIPCで正常終了させ、旧版の `dist` と `node_modules`、起動前のSQLiteと暗号鍵を保持します。新版は自動化とAPI変更操作を止めた検証状態で起動し、対象バージョン・変更番号と起動応答を確認した後に通常運転を開始します。

取得・インストール・ビルド・検証起動に失敗した場合は、変更が想定どおりで排他ロックを取得できる範囲で、旧コードと成果物へ復帰します。検証起動でDBが変わった場合も、通常運転に入る前なら保持したDBと鍵を復帰します。通常運転を有効にした後は、メール等の外部作用を二重実行しないため、古いDBへの自動巻き戻しをしません。

更新途中にランチャーが終了した場合、次の `npm start` でジャーナルを確認します。途中でソースが編集された、別プロセスがデータを使用している、復旧用ファイルが欠けている等の場合は強制上書きをせず、端末に理由を表示して復旧資料を保持します。`.git/loom-updates` を削除して無理に続行しないでください。この内部スナップショットは、生成画像や外部作業フォルダーまで含む通常のバックアップの代わりではありません。

この版では更新ごとの旧成果物と復旧資料を自動削除しないため、更新の回数に応じてディスク使用量が増えます。更新が完了し、通常のバックアップも確保できた後で整理してください。未完了の更新のジャーナルや復旧資料を削除しないでください。

## Implementation notes

The update source is the fixed official repository and its `main` commit. Package metadata and the latest push/main CI run are read at the exact observed SHA. A new major implementation of the updater can require a manual transition by changing `loomUpdateProtocol`; the v0.6 launcher accepts protocol 1 only.

`npm start` runs a Node-builtins-only supervisor. It launches the compiled server at the original checkout and data directory, retains the inherited configuration, and uses an IPC request/receipt/proceed exchange so the accepted HTTP response can be delivered before shutdown. An uncertain HTTP result is looked up by its request ID instead of being replayed.

The supervisor verifies the official origin, clean `main`, current source revision and fast-forward ancestry again before changing files. It uses explicit argument arrays. On Windows it invokes the npm CLI through the Node executable rather than executing `npm.cmd` as a native program. Install/build failures retain the previous artifacts, so rollback does not require re-downloading old dependencies.

See the primary references for [Node child-process IPC and Windows behavior](https://nodejs.org/download/release/v24.11.0/docs/api/child_process.html), [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/), [Git fast-forward-only merging](https://git-scm.com/docs/git-merge), and [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs).
