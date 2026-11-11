# Additional instructions to an active task

Version 0.14.0 adds an explicit way for the owner to change a bot's current work. Select **Add instruction**, write in the existing chat composer, and send. The target bot and task remain visible above the input. Clear that target to send an ordinary new request.

This feature requires a connected conversation model. The fixed demo script does not interpret additional instructions. Learning reviews remain separate from owner-directed task inputs.

## Scope and timing

One instruction targets one task in its own room. Mentions inside its text do not add recipients. The original request is preserved, and instructions are appended in acceptance order. Task identity, workspace, work ownership, permission rules, image-input allowance and operation records remain in place.

| Current state                        | Delivery behavior                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queued or waiting for model capacity | Include the accepted instructions before sending the next conversation-model request. Rebuild an older prepared request when necessary.                      |
| Generating a response                | Normal delivery waits for that response to finish. **Apply now** interrupts the conversation response and continues the same task with the additional input. |
| Executing a tool                     | Keep the started operation and its result. Reconsider later unstarted operations before they execute.                                                        |
| Awaiting approval                    | Withdraw the old pending approval as superseded by new instructions. The replanned operation follows the normal permission rules.                            |
| Room paused                          | Store the instruction without resuming the room. Deliver it after an explicit room resume.                                                                   |
| Task stopped, interrupted or failed  | Previously accepted pending instructions remain for explicit task recovery. New submissions require an eligible active task.                                 |
| Task completed                       | Reject new submissions and retain the composer draft so the owner can choose a new request.                                                                  |

Apply now controls a conversation-model response. It does not abort a shell command, an image-generation tool, a file upload, or a mail delivery that has already started. Context compaction also retains its own lifecycle. A tool may already have started while it waits for a resource; waiting does not by itself prove that it is safe to restart it.

An instruction cannot undo a completed external effect. Loom retains completed and uncertain operation records instead of replaying those operations during replanning. The effect of cancelling a model request on the inference server's GPU work depends on that server's cancellation support.

## What the status means

**Received / waiting** means Loom has durably stored the instruction. The UI may explain that a started tool or room resume is delaying delivery. **Delivered to the bot** means the instruction was included in a conversation-model request; it is not a claim that the model understood or obeyed it. New assistant output is shown after the corresponding owner instruction while earlier partial output remains available.

If image input is disabled or the shared image-input budget prevents supplying the attachment pixels, the text and image identifiers remain available and the receipt explains the limitation. Delivery of text alone does not mean the model saw the attached images.

The target is fixed at acceptance. If a task finishes while an instruction is being submitted, Loom either accepts it for that same task's continuation or rejects it explicitly. It never silently sends the correction to a different task or bot. A retry of an accepted request returns the same receipt, including after the target has finished.

## Persistence and recovery

Inputs are stored separately from the original task prompt, with their message link, sequence and delivery state. Pi's persisted conversation carries structured input identities so recovery can avoid inserting the same input twice. Pending instructions survive application restart and are included in encrypted data transfer.

If context compaction removes an instruction before its first model request, Loom restores the pending group in acceptance order using the saved content. The same input identities remain authoritative, and the restored images do not consume their allowance again. Already delivered history remains eligible for normal summarization.

Stopping a task or restarting Loom does not authorize automatic recovery. Review its progress and resume explicitly. Paused rooms remain paused. Already accepted instructions are retained, including instructions that had not reached the model when the task stopped.

Each message follows the ordinary 32,000-character and chat-image limits. A task accepts at most 32 pending instructions and 200 instructions in total. These bounds do not reset the task's existing model, tool, handoff or image budgets. An additional instruction does not grant new permissions.

## Implementation boundaries

The HTTP endpoint is `POST /api/tasks/:id/inputs`. It accepts a client request ID, text, optional images and `boundary` or `immediate` mode. Acceptance and the visible owner message are stored atomically, and duplicate request IDs must match the original target and content.

Runtime delivery preserves the same task and Pi session. Input changes are checked before model dispatch, before unstarted tool actions and when approvals settle. Superseding an approval is distinguished from denying an operation or stopping the task.

The pinned Pi version delivers native steering after a full assistant tool batch. Loom's own boundaries provide the earlier reconsideration of unstarted operations. A task-level stop signal is not reused for generation-only immediate delivery, and operation receipts are never cleared just to make a retry possible.
