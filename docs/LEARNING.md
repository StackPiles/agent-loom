# Memory and skill maintenance

Agent Loom keeps durable facts and preferences as memories, and reusable procedures as skills. Starting with v0.8.0, a bot can search and maintain its own records. Newly created bot skills become active automatically. The owner can inspect their evidence, fix their content, lock them, archive them, or restore an earlier revision in **Memory & skills**.

## What changes automatically

| Record                                     | Bot behavior                                                            | Owner controls                                        |
| ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| An unlocked memory owned by this bot       | Search, read, revise, merge with memories in the same scope, or archive | Edit, lock, archive, reactivate, and restore content  |
| A new skill created by this bot            | Record its evidence and make it available automatically                 | Inspect, edit, lock, or archive                       |
| An unlocked active skill owned by this bot | Append an evidence-linked revision to the same skill ID                 | Inspect the change, lock, archive, or restore content |
| A shared record or another bot's record    | Read it only when visible in the current scope                          | Choose the owner and scope                            |
| A locked or archived record                | Respect the owner's decision; do not replace or recreate it             | Explicitly unlock or reactivate it                    |
| An existing candidate skill                | Inspect it for maintenance; do not use or activate it automatically     | Review and activate it                                |

New records created through the owner UI are fixed by default; the checkbox makes the choice visible and can permit bot updates. Bot-created records are not fixed. A shared record remains owner-managed even when unlocked: unlocking does not give every bot permission to rewrite it.

The **automatic learning** preference controls the separate review after a completed task. It does not turn off ordinary memory and skill tools during a task. A review shares the fair work queue, has only learning tools, and may make at most one memory change and one skill change. A merge counts as one memory change. Up to ten model requests allow time to search, inspect, revise, and report the result. Interrupted mutation attempts still consume their change allowance after restart; a confirmed validation or version-conflict failure can be reconsidered. The bot should make no change when evidence is weak, a lesson is already captured, or a failed action has not established a better procedure.

## Scope and retrieval

Each record belongs to one bot or is shared with the room's bots. New bot-created memories and skills default to the current room, including records made during the background learning review. Omitting the optional tool `scope` never broadens a new record to other rooms. The owner editor also starts with the current active room, or the only eligible room; if neither identifies a room, the owner must select one before saving.

A bot sees its own and shared records only when their room restriction matches its current room. General preferences or reusable procedures may still be deliberately shared: bots must explicitly choose `scope: 'bot'`, and owners must explicitly choose **All rooms (explicit sharing)**. Changing a record's selected bot cannot silently change a room restriction to all rooms. Replacing an existing memory preserves its saved scope. The owner creation API requires `roomId`; use a room ID, or explicitly pass `null` for all-room sharing.

The initial prompt contains a bounded selection of active memories and short descriptions of active skills, labelled with their scope and known source task/room. Unknown provenance stays unknown. A pinned skill reports the source of the version that task actually read. Search tools can find records outside those initial limits. Reading a skill loads its full procedure when needed. Records learned in another room are reference data; they do not establish a current request or mean that conversation occurred here. Activating a skill does not grant shell, browser, network, mail, or scheduling permissions.

Bots should search before saving, revise the same record when a fact changes, and preserve useful conditions and exceptions. Memory merging updates the selected target and archives its sources atomically. All participants must be unlocked, owned by the bot, and in the same scope. A missing, stale, or unavailable source prevents the entire merge.

## History, conflicts, and owner decisions

Both record types have numbered revisions. New revisions record the content, author, reason, evidence, source task when available, and scope/control metadata. The UI shows previous content and changes. Restoring an old revision appends a new revision; it does not erase the intervening history. Restoring content preserves the current owner, room, lock, and activation state, so content recovery does not silently reactivate an archived record.

Every existing-record mutation supplies the version it was based on. If another task or the owner saves first, the server returns a conflict instead of overwriting that newer work. An open editor keeps its original version and draft through incoming snapshots. Reload the current record deliberately before reconciling a conflict.

Archiving is reversible. Bots cannot unarchive records or remove locks. Creation and update checks also compare normalized names/content, including prior revisions of protected records, to prevent direct recreation under a different ID. These deterministic checks recognize matching records; they are not a semantic proof that differently worded procedures are unrelated. The bot instructions also require respecting the meaning of an owner's correction or deactivation.

## Which skill version a task uses

The first `read_skill` call for a task saves that skill's exact ID, version, name, description, content, and read time on the task. Subsequent reads by the same task use that snapshot, including after pause or application restart. A new task reads the current active version.

Live availability is still checked. Archiving a skill or moving it outside the bot's available scope prevents later reads, including reads of a pinned copy. Current tool permissions still apply to actions. A saved skill version is a procedure snapshot, not a stored authorization.

For maintenance, `inspect_skill` reads the current record without changing the task's execution snapshot. This lets a bot inspect a newer revision before proposing a change based on old task experience. Search/inspection and use are separate operations.

## Existing installations

Version **0.18.0** migrates all existing memories and skills without a room restriction on the first startup, before runtime construction or task admission. Already room-scoped records retain their exact stored data. The migration covers active, candidate and archived records, and preserves IDs, content, activation state, locks and source references.

The saved source task, revision authors/source tasks, historical room restrictions and merged-memory contributors must identify one consistent existing room. The migration does not infer a room from a bot's current membership, guess from text, or copy a record into every room. Records whose origin is missing, conflicting or no longer available are retained in an archived, paused room named **記憶・スキルの整理待ち**. That room has no members or autonomous work, so its records are unavailable in ordinary active rooms. Open **Memory & skills**, edit the record, and select its intended **Room scope** to use it again. Fixed records remain fixed; inactive records remain inactive.

All changed records receive an additional revision explaining the scope migration. Exact original records and provenance decisions are retained in the private `learningRoomMigrationRecords` database collection, outside model/UI snapshots. Migration updates, the holding room and the `meta/learningRoomScopeMigrationV1` completion marker commit in one transaction. An interrupted migration rolls back and can run again. Completed migrations do not move later deliberately shared records on subsequent restarts. The marker and originals survive encrypted data transfer; an older imported dataset without the marker is migrated before it starts.

This migration changes future memory/skill availability. It does not erase text already quoted into another room's saved conversation or compaction summary, and it does not change shared files, mail accounts or a bot's Chrome profile. Those are independent sources of information. Existing conversation history and operation receipts are retained.

- Existing skill candidates and archived records keep their state. Updating Loom does not activate them in bulk.
- Skill version pinning begins with the first read recorded by v0.8.0. Tasks that read skills before this feature existed have no task-level version snapshot to recover automatically.
- Existing memories without lock metadata retain their prior bot-update behavior. Their first version is reconstructed from the saved content before a new change is appended.
- Legacy skills created or edited by the owner are fixed by default when their stored provenance establishes that history; uncertain legacy skill provenance is handled conservatively. The owner can permit automatic updates in the editor.
- Older history cannot reveal facts that were never recorded. Missing authors and evidence are displayed as legacy/unknown rather than invented.
- Histories, room restrictions, and task skill snapshots are stored in the existing SQLite data and are included in data transfer. Transferring data does not itself start a learning review.

## Evaluating the result

A skill read count measures retrieval, not successful work. The source task and observed results help explain why a record changed; they do not certify a generated lesson. Useful evaluation checks whether subsequent work avoids the same mistake, needs fewer user corrections, and completes with less repeated effort. Model weights are unchanged.

For owner API payloads and conflict behavior, see [API.md](API.md). For runtime boundaries, see [ARCHITECTURE.md](ARCHITECTURE.md).
