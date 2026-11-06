import { useState } from 'react';
import { ArrowUpRight, History } from 'lucide-react';
import type { LearningActor, MemoryRevision, SkillRevision } from '../shared/types';
import { dateLabel, useApp } from './context';
import { Button, Markdown } from './components';

type Revision = MemoryRevision | SkillRevision;

export function LearningEvidence({
  evidence,
  sourceTaskId,
  onClose,
  disabled = false,
}: {
  evidence?: string;
  sourceTaskId?: string;
  onClose: () => void;
  disabled?: boolean;
}) {
  const { data, t, navigate } = useApp();
  const task = data.tasks.find((item) => item.id === sourceTaskId);
  if (!evidence && !sourceTaskId) return null;
  return (
    <div className="learning-evidence">
      {evidence && <p>{evidence}</p>}
      {task ? (
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          onClick={() => {
            navigate('chat', task.roomId);
            onClose();
          }}
        >
          {t('元の作業を見る', 'View source task')}
          <ArrowUpRight size={13} />
        </button>
      ) : sourceTaskId ? (
        <p className="muted">
          {t('元の作業は現在のデータにありません。', 'The source task is no longer available.')}
        </p>
      ) : null}
    </div>
  );
}

export function LearningAuthor({ actor }: { actor?: LearningActor }) {
  const { data, t } = useApp();
  return (
    <span className="learning-author">
      {actor?.kind === 'user'
        ? t('ユーザー', 'User')
        : actor?.kind === 'bot'
          ? (data.bots.find((bot) => bot.id === actor.botId)?.name ?? t('ボット', 'Bot'))
          : t('更新者の記録なし', 'Author not recorded')}
    </span>
  );
}

function RevisionItem({
  revision,
  previous,
  currentVersion,
  blocked,
  busy,
  onRestore,
  onClose,
}: {
  revision: Revision;
  previous?: Revision;
  currentVersion: number;
  blocked: boolean;
  busy: boolean;
  onRestore: (version: number) => Promise<void>;
  onClose: () => void;
}) {
  const { data, t, locale } = useApp();
  const [open, setOpen] = useState(false);
  const noRecord = t('記録なし', 'Not recorded');
  const ownerLabel = (id: string | null | undefined) =>
    id === undefined
      ? noRecord
      : id === null
        ? t('チームで共有', 'Shared with the team')
        : (data.bots.find((bot) => bot.id === id)?.name ??
          t('ボットが見つかりません', 'Bot unavailable'));
  const roomLabel = (id: string | null | undefined) =>
    id === undefined
      ? noRecord
      : id === null
        ? t('すべてのルーム', 'All rooms')
        : (data.rooms.find((room) => room.id === id)?.name ??
          t('ルームが見つかりません', 'Room unavailable'));
  const statusLabel = (status: Revision['status']) =>
    status === 'active'
      ? t('有効', 'Active')
      : status === 'candidate'
        ? t('候補', 'Candidate')
        : status === 'archived'
          ? t('アーカイブ', 'Archived')
          : noRecord;
  const lockLabel = (locked: boolean | undefined) =>
    locked === undefined
      ? noRecord
      : locked
        ? t('固定', 'Fixed')
        : t('ボットによる更新可', 'Bot updates allowed');
  const name = 'name' in revision ? revision.name : undefined;
  const oldName = previous && 'name' in previous ? previous.name : undefined;
  const description = 'description' in revision ? revision.description : undefined;
  const oldDescription = previous && 'description' in previous ? previous.description : undefined;
  const differences: Array<{ label: string; before: string; after: string }> = [];
  const addDifference = <T,>(
    label: string,
    before: T | undefined,
    after: T | undefined,
    format: (value: T | undefined) => string = (value) => String(value ?? noRecord),
  ) => {
    if (after !== undefined && (!previous || before !== after))
      differences.push({
        label,
        before: previous ? format(before) : '—',
        after: format(after),
      });
  };
  addDifference(t('名前', 'Name'), oldName, name);
  addDifference(
    t('説明・使うタイミング', 'Description & when to use'),
    oldDescription,
    description,
  );
  addDifference(t('対象ボット', 'Bot scope'), previous?.botId, revision.botId, ownerLabel);
  addDifference(t('対象ルーム', 'Room scope'), previous?.roomId, revision.roomId, roomLabel);
  addDifference(t('状態', 'Status'), previous?.status, revision.status, statusLabel);
  addDifference(t('自動更新', 'Automatic updates'), previous?.locked, revision.locked, lockLabel);
  addDifference(t('根拠', 'Evidence'), previous?.evidence, revision.evidence);
  const merged = 'mergedFrom' in revision ? revision.mergedFrom : undefined;

  return (
    <details className="learning-revision" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <strong>v{revision.version}</strong>
        {revision.version === currentVersion && (
          <span className="subtle-tag tag-sage">{t('現在', 'Current')}</span>
        )}
        <LearningAuthor actor={revision.actor} />
        <span>{dateLabel(revision.createdAt, locale, true)}</span>
        <span className="learning-revision-reason">{revision.reason}</span>
      </summary>
      {open && (
        <div className="learning-revision-body">
          {differences.length > 0 && (
            <div className="learning-diff-table-wrap">
              <table className="learning-diff-table">
                <thead>
                  <tr>
                    <th scope="col">{t('変更した項目', 'Changed field')}</th>
                    <th scope="col">{t('変更前', 'Before')}</th>
                    <th scope="col">{t('変更後', 'After')}</th>
                  </tr>
                </thead>
                <tbody>
                  {differences.map((field) => (
                    <tr key={field.label}>
                      <th scope="row">{field.label}</th>
                      <td>{field.before}</td>
                      <td>{field.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {previous && previous.content !== revision.content ? (
            <div className="learning-content-diff" aria-label={t('本文の変更', 'Content changes')}>
              <section className="learning-diff-before">
                <h3>
                  {t('変更前', 'Before')} · v{previous.version}
                </h3>
                <pre>{previous.content}</pre>
              </section>
              <section className="learning-diff-after">
                <h3>
                  {t('変更後', 'After')} · v{revision.version}
                </h3>
                <pre>{revision.content}</pre>
              </section>
            </div>
          ) : (
            <div className="learning-revision-content">
              <h3>{previous ? t('本文の変更なし', 'Content unchanged') : t('本文', 'Content')}</h3>
              <Markdown>{revision.content}</Markdown>
            </div>
          )}
          <LearningEvidence
            evidence={revision.evidence}
            sourceTaskId={revision.sourceTaskId}
            onClose={onClose}
            disabled={busy}
          />
          {merged?.length ? (
            <div className="learning-merge-sources">
              <h3>{t('統合した記憶', 'Merged memories')}</h3>
              <ul>
                {merged.map((source) => {
                  const memory = data.memories.find((item) => item.id === source.id);
                  const content =
                    memory?.revisions?.find((item) => item.version === source.version)?.content ??
                    (memory?.version === source.version ? memory.content : undefined);
                  return (
                    <li key={source.id}>
                      <span className="subtle-tag">v{source.version}</span>{' '}
                      {content
                        ? content.slice(0, 300) + (content.length > 300 ? '…' : '')
                        : t(
                            '元の内容は現在のデータにありません。',
                            'Original content is unavailable.',
                          )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          <Button
            type="button"
            icon={History}
            busy={busy}
            disabled={blocked || revision.version === currentVersion}
            onClick={() => void onRestore(revision.version)}
          >
            {t('この版の内容を復元', 'Restore this content')}
          </Button>
        </div>
      )}
    </details>
  );
}

export function LearningHistory({
  revisions,
  currentVersion,
  blocked,
  busy,
  onRestore,
  onClose,
}: {
  revisions: readonly Revision[];
  currentVersion: number;
  blocked: boolean;
  busy: boolean;
  onRestore: (version: number) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useApp();
  const sorted = [...revisions].sort((a, b) => a.version - b.version);
  return (
    <div className="learning-history">
      <p className="learning-history-note">
        {t(
          '復元すると新しい版が追加されます。対象ボット・ルーム、固定、使用状態は現在の設定を維持します。',
          'Restoring adds a new version. The current bot, room, fixed setting and activation status stay in place.',
        )}
      </p>
      <div className="revision-list">
        {sorted
          .map((revision, index) => (
            <RevisionItem
              key={revision.version}
              revision={revision}
              previous={sorted[index - 1]}
              currentVersion={currentVersion}
              blocked={blocked}
              busy={busy}
              onRestore={onRestore}
              onClose={onClose}
            />
          ))
          .reverse()}
        {!sorted.length && (
          <p className="muted">{t('まだ変更履歴がありません。', 'No revision history yet.')}</p>
        )}
      </div>
    </div>
  );
}
