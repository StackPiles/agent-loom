import { useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  Check,
  Download,
  History,
  Lightbulb,
  LockKeyhole,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import type { Memory, Skill, Snapshot } from '../shared/types';
import {
  normalizeMemory,
  normalizeSkill,
  type NormalizedMemory,
  type NormalizedSkill,
} from '../shared/learning';
import { ApiError, api } from './api';
import { dateLabel, statusLabel, useApp } from './context';
import { Button, Field, Markdown, Modal, Toggle } from './components';
import { LearningAuthor, LearningEvidence, LearningHistory } from './LearningHistory';

type Selection = { kind: 'skill'; item?: Skill } | { kind: 'memory'; item?: Memory };
type LearningRecord = NormalizedMemory | NormalizedSkill;
interface Draft {
  name: string;
  description: string;
  content: string;
  botId: string;
  roomId: string;
  locked: boolean;
  evidence: string;
  reason: string;
}

function initialDraft(record?: LearningRecord): Draft {
  return {
    name: record && 'name' in record ? record.name : '',
    description: record && 'description' in record ? record.description : '',
    content: record?.content ?? '',
    botId: record?.botId ?? '',
    roomId: record?.roomId ?? '',
    locked: record?.locked ?? true,
    evidence: record?.evidence ?? '',
    reason: '',
  };
}

function findRecord(snapshot: Snapshot, kind: Selection['kind'], id: string) {
  if (kind === 'skill') {
    const record = snapshot.skills.find((item) => item.id === id);
    return record ? normalizeSkill(record) : undefined;
  }
  const record = snapshot.memories.find((item) => item.id === id);
  return record ? normalizeMemory(record) : undefined;
}

export function LearningEditor({
  selection,
  onClose,
}: {
  selection: Selection;
  onClose: () => void;
}) {
  const { data, t, locale, connected, mutate, navigate } = useApp();
  const kind = selection.kind;
  const isSkill = kind === 'skill';
  const collection = isSkill ? 'skills' : 'memories';
  // This baseline belongs to the draft, not to live SSE props. Advancing it
  // silently would let an old edit overwrite a newer bot or owner revision.
  const [base, setBase] = useState<LearningRecord | undefined>(() =>
    selection.item
      ? selection.kind === 'skill'
        ? normalizeSkill(selection.item)
        : normalizeMemory(selection.item)
      : undefined,
  );
  const [draft, setDraft] = useState(() => initialDraft(base));
  const [tab, setTab] = useState<'edit' | 'preview' | 'history'>('edit');
  const [busy, setBusy] = useState(false);
  const [serverConflict, setServerConflict] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const live = base ? findRecord(data, kind, base.id) : undefined;
  const missing = Boolean(base && !live);
  const stale = Boolean(base && live && live.version > base.version);
  const conflict = stale || serverConflict;
  const current = live && (!base || live.version >= base.version) ? live : base;
  const blocked = busy || missing || conflict || connected === false;
  const valid = Boolean(draft.content.trim()) && (!isSkill || Boolean(draft.name.trim()));
  const unchanged = JSON.stringify(draft) === JSON.stringify(initialDraft(base));
  const revisions = current?.revisions ?? [];
  const latestRevision = revisions.find((revision) => revision.version === current?.version);
  const rooms = data.rooms.filter(
    (room) =>
      room.id === draft.roomId ||
      (!room.archived && (!draft.botId || room.botIds.includes(draft.botId))),
  );
  const usedTasks =
    isSkill && base
      ? data.tasks
          .flatMap((task) => {
            const use = task.skillUses?.find((item) => item.id === base.id);
            return use ? [{ task, use }] : [];
          })
          .sort((a, b) => b.use.readAt.localeCompare(a.use.readAt))
      : [];

  const close = () => {
    if (!inFlight.current) onClose();
  };
  const update = (patch: Partial<Draft>) => {
    if (inFlight.current) return;
    setDraft((previous) => ({ ...previous, ...patch }));
    setError('');
  };
  const failed = (caught: unknown) => {
    if (base && caught instanceof ApiError && caught.status === 409) setServerConflict(true);
    setError(caught instanceof Error ? caught.message : String(caught));
  };
  const reload = async () => {
    if (!base || inFlight.current || connected === false) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      // Read a definite current record even if a simultaneous message delta
      // makes the app discard a broader refresh response to protect streaming.
      const snapshot = await api<Snapshot>('/state');
      const latest = findRecord(snapshot, kind, base.id);
      if (!latest)
        throw new Error(t('この項目は見つかりません。', 'This item is no longer available.'));
      setBase(latest);
      setDraft(initialDraft(latest));
      setServerConflict(false);
    } catch (caught) {
      failed(caught);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const save = async (status?: Skill['status']) => {
    if (inFlight.current || blocked || !valid) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const fields = {
      content: draft.content,
      botId: draft.botId || null,
      roomId: draft.roomId || null,
      locked: status && status !== 'active' ? true : draft.locked,
      evidence: draft.evidence,
      ...(draft.reason.trim()
        ? { reason: draft.reason.trim() }
        : status
          ? {
              reason:
                status === 'archived'
                  ? t('ユーザーがアーカイブ', 'Archived by the user')
                  : status === 'candidate'
                    ? t('ユーザーが候補に変更', 'Marked as a candidate by the user')
                    : t('ユーザーが有効化', 'Activated by the user'),
            }
          : {}),
      ...(isSkill ? { name: draft.name, description: draft.description } : {}),
      ...(base ? { baseVersion: base.version } : {}),
      ...(status ? { status } : {}),
    };
    try {
      await mutate(
        '/' + collection + (base ? '/' + encodeURIComponent(base.id) : ''),
        base ? 'PATCH' : 'POST',
        fields,
        status === 'archived'
          ? t('アーカイブしました', 'Archived')
          : status === 'active'
            ? t('有効にしました', 'Activated')
            : status === 'candidate'
              ? t('候補に戻しました', 'Returned to candidates')
              : t('保存しました', 'Saved'),
      );
      onClose();
    } catch (caught) {
      failed(caught);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const restore = async (version: number) => {
    if (!base || inFlight.current || blocked) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate(
        '/' + collection + '/' + encodeURIComponent(base.id) + '/restore',
        'POST',
        { version, baseVersion: base.version },
        t('履歴の内容を新しい版として復元しました', 'Restored the content as a new version'),
      );
      onClose();
    } catch (caught) {
      failed(caught);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={
        isSkill
          ? base && 'name' in base
            ? base.name
            : t('新しいスキル', 'New skill')
          : base
            ? t('記憶を編集', 'Edit memory')
            : t('記憶を追加', 'New memory')
      }
      description={
        isSkill
          ? t(
              '使う条件と手順を記録し、作業から得た経験を次の版に反映できます。',
              'Record when to use this procedure and improve it with evidence from work.',
            )
          : t(
              '今後の作業で参照する情報と、その根拠を記録します。',
              'Record context for future work and the evidence behind it.',
            )
      }
      onClose={close}
    >
      <div className="learning-editor">
        {base && (
          <div className="learning-editor-meta">
            <span className="subtle-tag">
              {t('編集中', 'Editing')} v{base.version}
            </span>
            {base.locked && (
              <span className="subtle-tag">
                <LockKeyhole size={12} />
                {t('固定', 'Fixed')}
              </span>
            )}
            <span>
              {t('保存済みの更新者: ', 'Last saved by: ')}
              <LearningAuthor actor={latestRevision?.actor} />
            </span>
            {current && <span>{dateLabel(current.updatedAt, locale, true)}</span>}
          </div>
        )}
        {(conflict || missing) && (
          <div className="learning-conflict" role="alert">
            <strong>
              {missing
                ? t(
                    'この項目は現在の一覧にありません。',
                    'This item is no longer in the current list.',
                  )
                : t(
                    '編集開始後に内容が更新されました。',
                    'This item changed after you started editing.',
                  )}
            </strong>
            <p>
              {t(
                '入力内容は保持しています。最新の内容を確認してから編集し直してください。',
                'Your draft is preserved. Load and review the latest content before editing again.',
              )}
            </p>
            {stale && live && (
              <p>
                {t('保存されている版: ', 'Latest saved version: ')}v{live.version}
              </p>
            )}
            <Button
              type="button"
              icon={RefreshCw}
              busy={busy}
              disabled={connected === false}
              onClick={() => void reload()}
            >
              {t('最新の内容を読み込む', 'Load latest content')}
            </Button>
            <small>
              {t(
                '読み込むと現在の入力を置き換えます。必要な文章は先にコピーしてください。',
                'Loading replaces your current draft. Copy any text you want to keep first.',
              )}
            </small>
          </div>
        )}
        {connected === false && (
          <p className="learning-connection-note" role="status">
            {t(
              '接続が切れています。入力は保持され、再接続後に保存できます。',
              'Disconnected. Your draft is kept and can be saved after reconnecting.',
            )}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {base?.status === 'archived' ? (
          <p className="learning-status-note">
            {t(
              'アーカイブ中です。履歴の復元や本文の保存だけでは、使用は再開されません。',
              'Archived. Saving or restoring content does not reactivate this item.',
            )}
          </p>
        ) : isSkill && (!base || base.status === 'candidate') ? (
          <div className="inline-note amber-note learning-status-note">
            <Lightbulb size={18} />
            {base
              ? t(
                  'このスキルは候補です。「有効にする」を選ぶとボットが利用できます。',
                  'This skill is a candidate. Activate it to make it available to bots.',
                )
              : t(
                  '手動で作成するスキルは候補として保存されます。保存後に内容を確認して有効化できます。',
                  'Manually created skills are saved as candidates. You can activate them after saving.',
                )}
          </div>
        ) : isSkill && current && 'autoActivated' in current && current.autoActivated ? (
          <p className="learning-status-note">
            {t(
              'ボットが自動で有効にしたスキルです。確認した範囲は根拠と作業履歴で確認できます。',
              'The bot activated this skill automatically. Its evidence and source task show what was checked.',
            )}
          </p>
        ) : null}
        {current && (current.evidence || current.sourceTaskId) && (
          <details className="evidence-details">
            <summary>{t('保存済みの根拠を確認', 'Review saved evidence')}</summary>
            <LearningEvidence
              evidence={current.evidence}
              sourceTaskId={current.sourceTaskId}
              onClose={close}
              disabled={busy}
            />
          </details>
        )}
        {isSkill && base && (
          <details className="learning-uses">
            <summary>
              {t('作業で使用した版', 'Versions used in tasks')} ({usedTasks.length})
            </summary>
            <p>
              {t(
                '各作業は読み込んだ版を保持します。新しい作業はその時点の有効な版を使います。',
                'Each task keeps the version it loaded. New tasks use the version active when they load it.',
              )}
            </p>
            {usedTasks.length ? (
              <>
                <ul>
                  {usedTasks.slice(0, 20).map(({ task, use }) => (
                    <li key={task.id}>
                      <span className="subtle-tag">v{use.version}</span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          navigate('chat', task.roomId);
                          close();
                        }}
                      >
                        {task.prompt.slice(0, 100) + (task.prompt.length > 100 ? '…' : '')}
                      </button>
                      <span>{statusLabel(task.status, locale)}</span>
                      <span>{dateLabel(use.readAt, locale, true)}</span>
                    </li>
                  ))}
                </ul>
                {usedTasks.length > 20 && (
                  <p className="muted">
                    {t('直近20件を表示しています。', 'Showing the latest 20 tasks.')}
                  </p>
                )}
              </>
            ) : (
              <p className="muted">
                {t('まだ版の使用記録はありません。', 'No task version records yet.')}
              </p>
            )}
          </details>
        )}
        <div className="editor-tabs">
          <button
            className={tab === 'edit' ? 'selected' : ''}
            aria-pressed={tab === 'edit'}
            onClick={() => setTab('edit')}
          >
            <Pencil size={14} />
            {t('編集', 'Edit')}
          </button>
          <button
            className={tab === 'preview' ? 'selected' : ''}
            aria-pressed={tab === 'preview'}
            onClick={() => setTab('preview')}
          >
            <BookOpen size={14} />
            {t('プレビュー', 'Preview')}
          </button>
          {base && (
            <button
              className={tab === 'history' ? 'selected' : ''}
              aria-pressed={tab === 'history'}
              onClick={() => setTab('history')}
            >
              <History size={14} />
              {t('履歴', 'History')} ({revisions.length})
            </button>
          )}
        </div>
        {tab === 'history' && base ? (
          <>
            {!unchanged && (
              <p className="learning-status-note">
                {t(
                  '未保存の入力があります。履歴を復元すると、その入力は保存されずに編集画面が閉じます。',
                  'You have an unsaved draft. Restoring a revision closes the editor without saving that draft.',
                )}
              </p>
            )}
            <LearningHistory
              revisions={revisions}
              currentVersion={current?.version ?? base.version}
              blocked={blocked}
              busy={busy}
              onRestore={restore}
              onClose={close}
            />
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset className="learning-fields" disabled={busy}>
              {tab === 'edit' ? (
                <>
                  {isSkill && (
                    <Field label={t('名前', 'Name')}>
                      <input
                        required
                        maxLength={160}
                        value={draft.name}
                        onChange={(event) => update({ name: event.target.value })}
                      />
                    </Field>
                  )}
                  <div className="form-grid">
                    <Field label={t('対象ボット', 'Bot scope')}>
                      <select
                        value={draft.botId}
                        onChange={(event) => {
                          const botId = event.target.value;
                          const room = data.rooms.find((item) => item.id === draft.roomId);
                          update({
                            botId,
                            roomId:
                              botId && room && !room.botIds.includes(botId) ? '' : draft.roomId,
                          });
                        }}
                      >
                        <option value="">{t('チームで共有', 'Shared with the team')}</option>
                        {data.bots.map((bot) => (
                          <option key={bot.id} value={bot.id}>
                            {bot.name}
                          </option>
                        ))}
                        {draft.botId && !data.bots.some((bot) => bot.id === draft.botId) && (
                          <option value={draft.botId} disabled>
                            {t('ボットが見つかりません', 'Bot unavailable')}
                          </option>
                        )}
                      </select>
                    </Field>
                    <Field
                      label={t('対象ルーム', 'Room scope')}
                      hint={t(
                        '案件固有の内容は、その案件のルームに限定できます。',
                        'Limit project-specific context to its room.',
                      )}
                    >
                      <select
                        value={draft.roomId}
                        onChange={(event) => update({ roomId: event.target.value })}
                      >
                        <option value="">{t('すべてのルーム', 'All rooms')}</option>
                        {rooms.map((room) => (
                          <option key={room.id} value={room.id}>
                            {room.name}
                            {room.archived ? t('（アーカイブ）', ' (archived)') : ''}
                          </option>
                        ))}
                        {draft.roomId && !rooms.some((room) => room.id === draft.roomId) && (
                          <option value={draft.roomId} disabled>
                            {t('ルームが見つかりません', 'Room unavailable')}
                          </option>
                        )}
                      </select>
                    </Field>
                  </div>
                  {isSkill && (
                    <Field label={t('説明・使うタイミング', 'Description & when to use')}>
                      <input
                        maxLength={1000}
                        value={draft.description}
                        onChange={(event) => update({ description: event.target.value })}
                      />
                    </Field>
                  )}
                  <Field
                    label={
                      isSkill ? t('手順（Markdown）', 'Procedure (Markdown)') : t('内容', 'Content')
                    }
                  >
                    <textarea
                      className={isSkill ? 'code-input' : ''}
                      required
                      rows={isSkill ? 12 : 7}
                      maxLength={isSkill ? 64_000 : 8000}
                      value={draft.content}
                      onChange={(event) => update({ content: event.target.value })}
                      placeholder={
                        isSkill
                          ? t(
                              '# 目的\n\n## 使う条件\n\n## 手順\n1. …\n\n## 確認できたこと・注意点\n- …',
                              '# Purpose\n\n## When to use\n\n## Steps\n1. …\n\n## Evidence and caveats\n- …',
                            )
                          : t(
                              '例：この案件の報告では、確認した結果と未確認の項目を分けて書く。',
                              'e.g. In project reports, distinguish checked results from open questions.',
                            )
                      }
                    />
                  </Field>
                  <Toggle
                    checked={draft.locked}
                    onChange={(locked) => update({ locked })}
                    disabled={busy}
                    label={t(
                      '内容を固定（ボットの更新を防ぐ）',
                      'Fix content (prevent bot updates)',
                    )}
                    description={
                      draft.botId
                        ? t(
                            '固定しても参照できます。解除すると、対象ボットが根拠を残して自分の記憶・スキルを更新できます。',
                            'Fixed content can still be used. When unfixed, its bot can update it and record the evidence.',
                          )
                        : t(
                            '共有の内容はユーザーが更新します。対象をボット専用に変更した場合も、この固定設定を引き継ぎます。',
                            'Shared items are maintained by you. This fixed setting also applies if you later assign the item to one bot.',
                          )
                    }
                  />
                  <Field
                    label={t('根拠・確認できたこと', 'Evidence and checks')}
                    hint={t(
                      'どの発言や結果に基づく内容かを残せます。',
                      'Record the statement or result that supports this content.',
                    )}
                  >
                    <textarea
                      rows={3}
                      maxLength={4000}
                      value={draft.evidence}
                      onChange={(event) => update({ evidence: event.target.value })}
                    />
                  </Field>
                  <Field label={t('変更理由（任意）', 'Reason for change (optional)')}>
                    <input
                      maxLength={1000}
                      value={draft.reason}
                      onChange={(event) => update({ reason: event.target.value })}
                      placeholder={t(
                        '例：ユーザーの訂正を反映、古い前提を更新',
                        'e.g. Apply a correction or update an outdated assumption',
                      )}
                    />
                  </Field>
                </>
              ) : (
                <div className="skill-preview">
                  {isSkill && (
                    <>
                      <h2>{draft.name || t('新しいスキル', 'New skill')}</h2>
                      <p className="muted">{draft.description}</p>
                    </>
                  )}
                  <Markdown>
                    {draft.content ||
                      t('プレビューする内容がありません。', 'There is no content to preview yet.')}
                  </Markdown>
                </div>
              )}
            </fieldset>
            <footer className="form-actions skill-form-actions learning-form-actions">
              <div>
                {base && isSkill && (
                  <a
                    className="button button-ghost"
                    href={'/api/skills/' + encodeURIComponent(base.id) + '/export'}
                    download
                  >
                    <Download size={15} />
                    {t('書き出す', 'Export')}
                  </a>
                )}
                {base && base.status !== 'archived' && (
                  <Button
                    type="button"
                    variant="ghost"
                    icon={Archive}
                    disabled={blocked || !valid}
                    onClick={() => void save('archived')}
                  >
                    {unchanged
                      ? t('アーカイブ', 'Archive')
                      : t('保存してアーカイブ', 'Save and archive')}
                  </Button>
                )}
                {base && isSkill && base.status === 'active' && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={blocked || !valid}
                    onClick={() => void save('candidate')}
                  >
                    {t('無効にする', 'Deactivate')}
                  </Button>
                )}
                {base && isSkill && base.status === 'archived' && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={blocked || !valid}
                    onClick={() => void save('candidate')}
                  >
                    {t('候補に戻す', 'Return to candidates')}
                  </Button>
                )}
              </div>
              <div>
                <Button type="button" onClick={close} disabled={busy}>
                  {t('閉じる', 'Close')}
                </Button>
                <Button
                  type="submit"
                  variant={base?.status === 'active' || !isSkill ? 'primary' : 'secondary'}
                  busy={busy}
                  disabled={blocked || !valid}
                >
                  {t('保存', 'Save')}
                </Button>
                {base && base.status !== 'active' && (
                  <Button
                    type="button"
                    variant="primary"
                    icon={Check}
                    disabled={blocked || !valid}
                    onClick={() => void save('active')}
                  >
                    {isSkill ? t('有効にする', 'Activate') : t('使用を再開', 'Use again')}
                  </Button>
                )}
              </div>
            </footer>
            {base && (
              <p className="learning-action-note">
                {t(
                  'アーカイブ・無効化すると内容も固定されます。入力を変更している場合は、その内容も保存します。',
                  'Archiving or deactivating also fixes the content. Any draft changes are saved with the action.',
                )}
              </p>
            )}
          </form>
        )}
      </div>
    </Modal>
  );
}
