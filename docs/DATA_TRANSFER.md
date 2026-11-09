# Copy Agent Loom to another machine

Agent Loom 0.4.0 adds **Settings → Data transfer**. Both machines must run a version that supports this feature; using the same version is recommended. A password-protected `.loom` file carries a snapshot from one running Loom to another. The destination previews the copy, backs up its current data, replaces it, and restarts automatically on the same address.

This is a one-time copy. The machines do not synchronize after the snapshot, and existing destination conversations are not merged with the imported conversations.

## 日本語：使い方

1. 両方のPCでAgent Loomを更新し、設定画面の未保存の変更を保存します。
2. コピー元の **設定 → データの移行 → このLoomからコピー** を開き、12文字以上の移行用パスワードを指定します。
3. 暗号化したコピーを作成し、`.loom` ファイルをダウンロードします。作成中はLoomを一時停止し、実行中の処理を中断してから自動で再起動します。作業フォルダーを別のアプリから変更する作業も、この間は止めてください。
4. ファイルをコピー先のPCへ渡します。コピー先の **設定 → データの移行 → 別のLoomから取り込む** で、そのファイルとパスワードを指定します。
5. 検証結果に表示された件数、作業フォルダーの配置、注意事項を確認し、**退避して置き換える** を選びます。検証だけでは現在のデータは変わりません。プレビュー後にコピー先のデータが変わった場合は、もう一度検証します。
6. 完了画面の退避先を確認し、Loomを開き直します。モデルの接続先やChromeの接続を確認してから、必要な自動化を個別に有効にします。自律予約の仕事は、コピー元で同じ仕事を止めたうえで、ルームの自律予約を許可し、内容を確認して個別に再開します。

コピー元のデータは残ります。コピー先では、取り込んだ自動化をすべて無効にします。v0.9.0以降は、ルームの自律予約も無効にし、未完了の仕事を一時停止します。新着メールの処理・定期実行・自律予約の仕事をコピー先で再開する前に、コピー元の同じ仕事を止めてください。コピー後の操作記録は両方のPCで共有されません。

### 引き継ぐもの

| 対象                                                   | 動作                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 設定、ボット、ルーム、会話、タスク、承認・活動履歴     | IDと参照関係を保持します。実行途中の処理は明示的に再開が必要です。                                                                                       |
| 記憶・スキルと改訂履歴、使用版、通知、自動化の設定     | 保存データを引き継ぎます。通知の送信元、返信元の文脈、返信の重複防止記録も保持します。自動化はコピー先で無効になります。                                 |
| 自律予約の仕事、起床予約、進捗と実行の識別子           | 目的・作成元・進捗・予約時刻・実行記録の参照を保持します。ルームの許可範囲は無効、未完了の仕事は一時停止となり、完了・中止した仕事は元の状態を保ちます。 |
| モデル・検索・画像生成・メール・サービスの接続情報     | Loomが保存したAPIキーとパスワードを、暗号鍵と一緒に暗号化ファイルへ含めます。通常は再入力不要です。                                                      |
| メールの下書き、送信履歴、実行済み操作、新着の処理位置 | 二重送信や処理の再実行を防ぐための記録も保持します。受信箱本体は引き続きメール提供元から読み取ります。                                                   |
| Piセッション、生成画像、アバター、保存ファイル         | 会話継続用の作業場所とセッション参照を変換し、ファイルの更新日時を維持します。                                                                           |
| 作業フォルダー                                         | データディレクトリ内は相対配置を維持し、外部の作業フォルダーはコピー先のデータディレクトリ内に配置します。コピー先の外部フォルダーは上書きしません。     |
| このブラウザーの未送信下書き・表示設定                 | コピー時に含めた場合、取り込み完了後に画面を開き直す際に反映します。他のブラウザーの状態は取得できません。                                               |

### マシンごとに確認するもの

- コピー先の起動アドレス、ポート、データ保存先、アクセス用トークンは維持します。元PCの`.env`をコピー先の起動設定として適用しません。
- LM Studio、Ollamaなどのモデル実行環境とモデルファイル、Node.js、Chrome本体はコピーしません。`localhost`のモデルURLはコピー先PCを指すため、必要に応じて変更します。
- Loomの共通・ボット専用Chromeプロファイルのファイルを含めますが、OSに依存するログイン状態は継続できない場合があります。既存Chromeのプロファイルや開いている接続は移しません。
- シンボリックリンクの外側にあるファイルはたどりません。移せないリンクやファイルは検証結果の注意事項に表示します。
- 実行中のモデル生成、ブラウザー操作、メール送信などの通信を別PCへ引き継ぐ機能ではありません。結果が不明な送信は自動で再送しません。

移行ファイルと展開後の内容は、それぞれ最大4GiBです。大きなモデルや依存ファイルを作業フォルダーに置いている場合は、容量を確認してください。容量超過や不正なファイル、誤ったパスワードは、現在のデータを置き換える前に拒否します。

## English workflow

Save pending settings, open **Settings → Data transfer**, and create a copy with a password of at least 12 characters. The server closes its current runtime before taking the snapshot, then starts again automatically. Active work is interrupted; do not edit included workspaces from other programs while the snapshot is being made.

Download the `.loom` file and choose it on the destination. Enter the same password, check the counts, workspace mappings, and warnings, then choose **Back up and replace**. Validation alone does not change live data. If the destination changes after the preview, validate again before applying.

The existing destination is moved to a local backup first. After reopening Loom, review machine-specific model URLs and browser connections. Enable imported automations only after disabling the same work on the source. For autonomous work, enable the destination room's policy and explicitly resume each reviewed work item after stopping its source copy. Both source and destination retain separate copies; later changes, receipts and external effects are not shared.

## Scope and recovery

The copy contains the database and its credential key together, Pi sessions, generated images, managed files, and the workspace roots referenced by settings, rooms, tasks, autonomous work and session headers. Operation receipts, mail send outcomes, automation cursors and deduplication records retain their original identities. The importer changes structured workspace references and session headers; it does not rewrite historical conversation text or tool arguments.

Autonomous work and wake-up records retain their work/run IDs, provenance, checkpoints, reservation schedules and receipt links. Import validates room policy, checkpoint shape and calendar schedules, rebases pinned work paths, turns room policies off and pauses every unfinished work item. Completed/cancelled work remains terminal. Existing reservations are held rather than discarded; an overdue occurrence follows its configured catch-up/skip policy after explicit resumption. Uncertain outcomes still require review. Imported receipts protect exact matching operations within their recorded scope; they do not coordinate two running copies or prove semantic exactly-once effects.

Unknown mail delivery outcomes and their operation uncertainty markers are retained as well. Import does not mark them sent, clear their review requirement or create another send attempt.

External workspace roots are placed under `imported-workspaces` in the destination data directory. Read the preview for the exact mapping and any skipped links. The copy includes private files within those workspaces, including repository metadata and environment files when they are ordinary files. Keep the archive password separate from the downloaded file.

Shared and bot-specific dedicated Chrome profiles are included after Chrome control is stopped, but cookies protected by the source operating system may require signing in again. An existing user Chrome profile, model binaries, externally hosted mailboxes, process environment variables and other applications are outside Loom's managed state.

Source Loom login sessions are removed from the import. The destination's own active login sessions and configured `LOOM_API_TOKEN` remain local. The exported browser state is restricted to Loom's drafts, locale, selected room/mail account, activity view, chat Focus view and notification preference.

The file uses scrypt and authenticated AES-256-GCM encryption. Passwords are not stored in job metadata. Uploads are bounded chunks, and authentication, origin checks and no-store responses apply to all transfer endpoints. Transfer files and unpacked contents are each limited to 4GiB; file count and manifest size are also bounded. Validation rejects malformed paths, unsupported database structures, damaged ciphertext and incompatible format versions before live replacement.

The completed job shows the automatic backup's path under `<LOOM_DATA_DIR>/.loom-transfer/backups/`. Backups contain the destination's previous data and credential key and have the same sensitivity as the live data directory. They are retained until the owner removes them; they are not recursively included in later exports. Prepared transfer jobs expire after 24 hours and are cleaned up at startup or when a new transfer is created.

Normal restore failures roll back to the previous data. A persistent journal lets startup recover an interrupted replacement before opening SQLite. The data directory itself is not renamed, so a Docker volume mount can remain in place. A stable process lock stays held while the old application is closed and the replacement is opened.

For manual recovery from an automatic backup, stop Loom, preserve a separate copy of the current data, and restore **all** entries from the selected backup together into the data directory. Do not mix the backup database with another `secret.key`. Keep `.loom-transfer` in place while restoring other top-level entries. If a restore journal remains because recovery itself failed, preserve the whole directory and resolve that failure before starting another import.
