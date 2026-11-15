import { useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, Trash2 } from 'lucide-react';
import type { Room } from '../shared/types';
import { activeStatuses, useApp } from './context';
import { Button, Modal } from './components';

function useRoomDeletion(roomId: string, onComplete?: () => void) {
  const { mutate, t } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const locked = useRef(false);
  const remove = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      await mutate(
        `/rooms/${encodeURIComponent(roomId)}`,
        'DELETE',
        undefined,
        t('Loomを完全に削除しました', 'Loom permanently deleted'),
      );
      onComplete?.();
    } catch {
      // The mutation reports the API error. Keep a local retry affordance too,
      // including when the connection dropped before a state event arrived.
      setError(true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { busy, error, remove };
}

export function RoomDeletionDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const { data, t, connected } = useApp();
  const current = data.rooms.find((item) => item.id === room.id) ?? room;
  const { busy, error, remove } = useRoomDeletion(room.id, onClose);
  const active = data.tasks.filter(
    (task) => task.roomId === room.id && activeStatuses.includes(task.status),
  ).length;
  const counts = [
    [t('会話', 'Messages'), data.messages.filter((item) => item.roomId === room.id).length],
    [t('記憶', 'Memories'), data.memories.filter((item) => item.roomId === room.id).length],
    [t('スキル', 'Skills'), data.skills.filter((item) => item.roomId === room.id).length],
    [t('自動化', 'Automations'), data.automations.filter((item) => item.roomId === room.id).length],
    [
      t('予約起床', 'Scheduled wakeups'),
      (data.wakeups ?? []).filter((item) => item.roomId === room.id && item.status === 'scheduled')
        .length,
    ],
    [
      t('サービス', 'Services'),
      (data.serviceAccounts ?? []).filter((item) => item.roomId === room.id).length,
    ],
  ] as const;
  const deleting = busy || current.deletion?.status === 'deleting';
  return (
    <Modal
      title={t('Loomを完全に削除しますか？', 'Permanently delete this Loom?')}
      onClose={onClose}
    >
      <div className="room-deletion-confirm" aria-busy={deleting}>
        <p className="room-deletion-name">{current.name}</p>
        <p>
          {t(
            'このLoomの会話、記憶・スキル、仕事・予約、サービス登録と保存した認証情報を削除します。この操作は取り消せません。',
            'Delete this Loom’s conversations, memories, skills, work, reservations, service registrations and saved credentials. This cannot be undone.',
          )}
        </p>
        <dl className="room-deletion-counts">
          {counts.map(([label, count]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
        {active > 0 && (
          <p className="room-deletion-active">
            {t(
              `実行中・待機中の仕事 ${active}件を停止してから削除します。`,
              `${active} active or queued ${active === 1 ? 'task will' : 'tasks will'} be stopped before deletion.`,
            )}
          </p>
        )}
        <p className="room-deletion-retained">
          {t(
            '共通のボット・メールアカウント・共有データ、外部サービスのアカウント、作業フォルダと成果物は残ります。他で使われている画像も残ります。',
            'Shared bots, mail accounts and data, external service accounts, workspace folders and work files are kept. Images used elsewhere are kept too.',
          )}
        </p>
        {error && (
          <p role="alert" className="form-error">
            {t(
              '削除の完了を確認できませんでした。再試行できます。',
              'Deletion could not be confirmed. You can retry.',
            )}
          </p>
        )}
        {deleting && (
          <p role="status">
            {t('仕事を停止し、データを削除しています。', 'Stopping work and deleting data.')}
          </p>
        )}
        <footer className="form-actions">
          <Button onClick={onClose}>
            {deleting ? t('閉じる', 'Close') : t('キャンセル', 'Cancel')}
          </Button>
          <Button
            variant="danger"
            icon={Trash2}
            busy={deleting}
            disabled={connected === false}
            onClick={() => void remove()}
          >
            {deleting
              ? t('削除中…', 'Deleting…')
              : error || current.deletion?.status === 'failed'
                ? t('削除を再試行', 'Retry deletion')
                : active
                  ? t('停止して削除', 'Stop and delete')
                  : t('完全に削除', 'Delete permanently')}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

export function RoomDeletionStatus({ room, compact = false }: { room: Room; compact?: boolean }) {
  const { t, connected } = useApp();
  const { busy, error, remove } = useRoomDeletion(room.id);
  const failed = room.deletion?.status === 'failed' && !busy;
  return (
    <div className={`room-deletion-status${compact ? ' is-compact' : ''}`}>
      <div role="status" aria-live="polite">
        {failed ? (
          <CircleAlert size={compact ? 14 : 24} />
        ) : (
          <LoaderCircle className="spin" size={compact ? 14 : 24} />
        )}
        <span>
          {failed
            ? t('削除を完了できませんでした', 'Deletion needs another attempt')
            : t('Loomを削除中…', 'Deleting Loom…')}
        </span>
      </div>
      {!compact && (
        <p>
          {failed
            ? t(
                'このLoomの活動は停止したままです。削除を再試行してください。',
                'This Loom remains stopped. Retry to finish deleting it.',
              )
            : t(
                'このLoomの仕事を停止し、関連データを削除しています。ほかのLoomは引き続き利用できます。',
                'Stopping this Loom’s work and deleting its data. Other Looms remain available.',
              )}
        </p>
      )}
      {error && (
        <p role="alert">
          {t(
            '削除を完了できませんでした。再試行できます。',
            'Deletion did not finish. You can retry.',
          )}
        </p>
      )}
      {failed && (
        <Button
          variant="danger"
          busy={busy}
          disabled={connected === false}
          onClick={() => void remove()}
        >
          {t('削除を再試行', 'Retry deletion')}
        </Button>
      )}
    </div>
  );
}
