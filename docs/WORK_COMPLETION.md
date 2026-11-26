# Completing work without losing a teammate's result

Version **0.20.0** separates work completion from an individual bot finishing its response. A completion request reviews remaining tasks, wake-ups and saved checks before deciding what to close. A bot waiting on a teammate does not need to occupy an execution slot or ask the owner to restart it after every reply.

## Remaining work has an explicit disposition

When remaining items exist, the first completion request keeps the work active and returns a completion review. The creator bot, or the owner in the work card, accounts for each item:

| Choice  | Behavior                                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wait    | Keep the required result pending. Save a review deadline and reassess after the selected work settles or the deadline arrives.                       |
| Dismiss | Record why this item is unnecessary, duplicated or already satisfied, then end its remaining execution or reservation.                               |
| Defer   | Save optional later scope in linked follow-up work and end the old execution/reservation. Original task and operation records keep their identities. |

Every choice includes a reason. The completion summary explains the observed result and how it meets the requested purpose. A bot is instructed to preserve explicit user requirements; a reason is reviewable evidence, not a mathematical proof that a language model understood the requirement. The server enforces record identity, current revisions, the remaining-item set, permissions and action-outcome guards.

Checks in the checkpoint remain ordinary future investigation while work is active. They do not become unknown external actions or stop ordinary wake-ups. At completion, they are included in the review so an optional improvement can be deferred or a redundant check dismissed without keeping the whole assignment open forever.

Finishing one recurring occurrence does not finish a standing responsibility. Complete the entire work only when that responsibility's purpose is satisfied or deliberately ended. Use cancellation when the purpose is abandoned, rather than claiming a successful result.

## Waiting releases the current response

The creator saves its wait and ends the current response normally. Other tasks can then use the available inference capacity, including when only one slot is configured. When the selected result becomes available, or the review deadline arrives, Loom admits one creator review task to inspect the result and decide what to do next. It does not automatically mark the work successful.

Saved waiting state survives restart. Dispatch is recorded durably to avoid duplicate review tasks. Room and work pauses, explicit stops, room membership, the pinned workspace, policy and admission limits remain authoritative. The default review deadline is 30 minutes; an explicit deadline must be in the future and no more than seven days away. Automatic reassessment stops after three attempts without progress on the same outstanding work, leaving the work active with a review reason. A task merely changing from queued to running does not reset that limit. A review deadline never proves that an action succeeded or that a missing result is no longer required.

An external action whose outcome is unknown still requires outcome review. Moving optional scope to follow-up work does not authorize retrying a submission or sending the same message again.

## Deferred work is saved, not replayed

A deferred follow-up keeps the same room, creator and workspace, with a reference to its original work and the saved remaining scope. It does not move old tasks or operation receipts, start a new task, or create a wake-up automatically. Inspect the follow-up and schedule useful future work through the normal room policy when appropriate.

This preserves intentionally held work. Creating a follow-up does not resume a paused room or restart a task the owner stopped.

## Stop causes and older history

New intentional stops record a structured `stopContext` with the reason, actor type, optional actor identity, related work, originating task and time. Work completion, cancellation, pause, superseded work and deferral have distinct reasons. Only an explicit task stop uses `owner_stop`.

Tasks ended because their work was resolved remain stopped; they are not relabelled as successfully executed. Their partial output and operation records remain available. Resuming a task clears the previous stop context for that new attempt.

Older `Stopped by the user` text can have been produced by automatic work completion. This upgrade preserves old records and does not infer who stopped them, silently reopen completed work, or replay past actions. Inspect the original result before deciding whether a new follow-up is still needed.

## API and model tool

`POST /api/work-items/:id/complete` accepts an optional object:

```json
{
  "baseRevision": 8,
  "completion": {
    "summary": "The requested report is verified. CSV export is optional later scope.",
    "decisions": [
      {
        "itemId": "COPY_THE_EXACT_REVIEW_ITEM_ID",
        "action": "defer",
        "reason": "CSV export is outside the completed report's requested scope."
      }
    ],
    "followUp": {
      "name": "Optional CSV export",
      "purpose": "Assess CSV export when it becomes useful."
    }
  }
}
```

The example must be filled with **all current item IDs** and the current work revision returned by the server. A call without decisions can initiate a review; it is not permission to ignore remaining work. Model `manage_work` uses the same optional `completion` object with `operation: "complete"`. `waitUntil`, when supplied, is a future ISO 8601 timestamp with an explicit offset for reassessment.

Inspect the returned work's `status` and `completionReview.status`. A successful HTTP/tool call may have saved a review while the work remains `active`; it does not necessarily mean the work became `completed`. `list_wakeups({workId})` and the normal state snapshot expose the full saved review; room summary pages show its status. A model call supplying a replacement checkpoint must first read that complete work revision, so a summary excerpt cannot silently replace the saved checkpoint. A newer task or changed item set requires reviewing that current set before closing.

## 日本語：使い方

仕事を完了するとき、残っている作業・起床予約・確認事項を **待つ／取りやめる／後続へ回す** で整理します。必要な回答は待ち、不要になった依頼は理由を残して終了し、追加の改善案は後続の仕事に保存できます。通常はボットが判断するため、毎回ユーザーが選ぶ必要はありません。仕事のカードから内容を確認・変更することもできます。

回答待ちでは依頼元の今回の応答を終え、結果が届いたときか確認期限に、依頼元が改めて判断します。確認期限は既定で30分後、指定する場合は7日以内です。同じ未解決項目に進展がなければ自動再確認は3回までで、仕事を未完了のまま理由を残します。期限切れだけで成功扱いにしません。後続へ回す操作は内容の保存であり、過去の処理を自動でやり直す操作ではありません。

仕事の完了や整理で止まったタスクには、その理由を表示します。旧版の停止記録を一括で書き換えたり、更新しただけで過去のタスクを再実行したりはしません。
