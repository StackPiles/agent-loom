# Image storage and cleanup

Since v0.21.0, **Settings → Storage** shows saved image usage and manages originals that have not been used recently. Open the section to load its measurements. The default policy is **30 days without use**, with **automatic cleanup off**. This policy is independent of the image model and its per-request size limits.

## Choose what to keep

Select **Keep** on a chat image or use the storage list to protect several images. Owner-uploaded images start protected. Generated images and screenshots can become candidates once their unused period ends. A protected image stays available until its protection is explicitly removed; ordinary rendering and restarting Loom do not change that choice.

| Action                                                      | Extends the unused period                  |
| ----------------------------------------------------------- | ------------------------------------------ |
| Open/enlarge an image or follow its original-image link     | Yes                                        |
| Download the original                                       | Yes                                        |
| Explicit bot `view_image` read                              | Yes, after a successful managed-image read |
| Use a managed image as an editing source, reference or mask | Yes, after a successful read               |
| Attach a new image or deliver it as explicit task input     | Yes                                        |
| Render chat or storage thumbnails                           | No                                         |
| Restore older image references for a model request          | No                                         |
| Inspect usage or consolidate duplicate files                | No                                         |

The timer starts again from the latest explicit use. Images already present when this feature first initializes receive a complete grace period from that initialization; Loom does not reconstruct or guess their earlier viewing history. Importing a data-transfer archive preserves actual recorded use and protection while granting a fresh grace period. Retired originals stay retired after import.

## Review and clean up

1. Open **Settings → Storage** and review usage, warnings and the candidate list.
2. Keep anything you want to retain. Filters show all images, candidates, protected images or cleaned-up records; sort by size or last use.
3. Select the candidates to remove and review their names and original sizes in the confirmation dialog.
4. Confirm cleanup. Loom rechecks those exact identifiers and reports images removed, actual bytes freed and candidates it kept because their conditions changed.

Manual cleanup follows the same safeguards as automatic cleanup. It does not force removal of a fresh, protected or currently required image. If automatic cleanup is enabled, Loom checks periodically while running, using the saved unused period. The permitted period is a whole number from 1 to 3650 days. Disabling the option stops future automatic cleanup.

Even after its time window has ended, an image is retained while a current, queued, paused, interrupted or otherwise resumable task needs it. Open autonomous work, relevant saved session references, active image reads, current avatars and sources of surviving edits also protect originals. Identical bytes shared by another protected, recent or required image remain available. A new generation or read racing with cleanup is checked again before files are removed. Maintenance and shutdown pause cleanup.

Conversation text, image prompts, model names, provenance and original size metadata remain after cleanup. Chat displays **Original cleaned up** instead of a broken image. Intentional expiry in saved session history becomes an explanation that the original is no longer available; it does not fail the conversation or trigger regeneration. To inspect or edit those pixels again, attach an available original or explicitly request a new image. Cleanup has no undo for removed originals. A genuinely missing or corrupt file without an expiry record remains a distinct error.

## Duplicate storage and measured usage

New images use the same exact bytes for the generated-image path and the content-addressed session asset. Where the filesystem supports hardlinks, those paths share one physical file. No compression, resizing or change of quality is involved. New saves use a copy fallback when links are unavailable.

**Consolidate duplicates** checks existing originals and consolidates matching files where linking is supported. It preserves all image IDs and conversations and does not change the unused timer. The displayed freed space is the actual reduction in physical bytes, rather than the sum of names that referred to the same file.

Usage separates originals, session images, original migration backups and browser upload copies. Physical totals count shared inodes once. Candidate sizes are estimates; shared files, files kept by other work or protection changes can make the final amount smaller. The dialog identifies its size sum as original sizes, and the completed cleanup reports actual freed bytes.

Original inline-history migration backups and browser upload staging follow their existing lifecycles. Image cleanup does not automatically erase those recovery backups, unrecognized files, or arbitrary files inside a room workspace. It also does not impose a total data-directory quota. If those categories account for most of the storage, their displayed sizes explain why cleaning image originals alone frees less space.

## Backups and upgrades

Back up the complete Loom data directory while it is stopped, including the database, `generated-images`, `sessions/assets` and `sessions/assets-retired`. The encrypted data-transfer feature copies the same image metadata and expiry markers. Copying only the database does not copy image pixels; omitting expiry markers can turn intentional cleanup into a missing-file error. Ordinary room deletion continues to remove that room's unreferenced managed images and retention records while preserving content shared with surviving rooms.

The API and record shapes are documented in [API.md](API.md#image-storage).

## 日本語：画像の保存容量を整理する

**設定 → ストレージ**を開くと、保存済み画像の容量・最終利用・整理候補を確認できます。初期値は**未使用30日、自動整理オフ**です。画像モデルの設定や、1回に送受信できる画像の容量上限とは別に保存します。

必要な画像はチャットの**「残す」**、または一覧で保護してください。利用者が添付した画像は初めから保護します。拡大表示・元画像の表示・ダウンロード・ボットによる画像確認・編集や参考画像としての読み取りで、未使用期間をリセットします。サムネイル表示、過去の履歴の自動読み込み、容量の集計では延長しません。

整理候補を選ぶと、削除する原本の名前とサイズを確認できます。確認後に使われた画像や保護された画像は、実行直前の再確認で除外します。進行中・順番待ち・休止中・再開待ちの作業、未完了の自律作業、現在のアイコン、残す編集結果の元画像などに必要な画像も残します。同じ画像データを別のルームや画像が必要としている場合も、そのデータを削除しません。

会話本文や生成時の情報は保持し、削除した原本は**「原本は整理済み」**と表示します。会話の再開時にも整理済み画像を説明文へ置き換え、自動で再生成しません。削除した原本を元に戻す機能はないため、再度確認・編集したい場合は手元の画像を添付してください。

既存の画像はこの機能の導入時から計測を始めるため、更新直後には削除候補になりません。データ移行でも猶予を設けます。日数は1〜3650日の整数で変更でき、自動整理をオンにするとLoomの起動中に定期確認します。

**「重複をまとめる」**は画像の品質やIDを変えず、同じ内容の保存ファイルをまとめます。会話画像の旧形式からの移行バックアップやブラウザー送信用の一時コピーは別の区分として表示し、原本の整理だけでは消しません。作業フォルダー内の任意のファイルも対象外です。表示された原本サイズの合計と、実際に空いた容量が異なることがあります。
