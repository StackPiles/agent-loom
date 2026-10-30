import { useState } from 'react';
import type { Room } from '../shared/types';
import { activeStatuses, useApp } from './context';
import { Avatar, Button, Field, Modal } from './components';
import { WorkspacePicker } from './WorkspacePicker';

export function RoomDialog({ room, onClose }: { room?: Room; onClose: () => void }) {
  const { data, t, mutate, navigate } = useApp();
  const [name, setName] = useState(room?.name || '');
  const [description, setDescription] = useState(room?.description || '');
  const [botIds, setBotIds] = useState(
    room?.botIds || data.bots.filter((b) => b.enabled).map((b) => b.id),
  );
  const [busy, setBusy] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | null>(room?.workspacePath || null);
  const [picking, setPicking] = useState(false);
  const roomActive =
    !!room &&
    data.tasks.some((task) => task.roomId === room.id && activeStatuses.includes(task.status));
  const workspaceChanged = workspacePath !== (room?.workspacePath || null);
  return (
    <Modal
      title={room ? t('ルームを編集', 'Edit room') : t('新しいルーム', 'Create a room')}
      description={t(
        'ルーム名、参加するボット、作業場所を設定します。',
        'Set the room name, participating bots, and workspace folder.',
      )}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (picking || (roomActive && workspaceChanged)) return;
          setBusy(true);
          try {
            const result = await mutate<Room>(
              room ? `/rooms/${room.id}` : '/rooms',
              room ? 'PATCH' : 'POST',
              {
                name: name.trim(),
                description: description.trim(),
                ...(!room || botIds.join('\0') !== room.botIds.join('\0') ? { botIds } : {}),
                ...(!room || workspaceChanged ? { workspacePath: workspacePath || null } : {}),
              },
              t('ルームを保存しました', 'Room saved'),
            );
            navigate('chat', result.id);
            onClose();
          } catch {
            /* mutation reports errors */
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t('ルーム名', 'Room name')}>
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('例：リサーチルーム', 'e.g. Research room')}
          />
        </Field>
        <Field label={t('このルームの目的', 'Room purpose')}>
          <textarea
            rows={3}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('例：新製品の調査と比較', 'e.g. Research and compare new products')}
          />
        </Field>
        <div className="field">
          <span className="field-label">{t('参加するボット', 'Bots')}</span>
          <div className="member-picker">
            {data.bots
              .filter((b) => b.enabled || room?.botIds.includes(b.id))
              .map((bot) => (
                <label
                  key={bot.id}
                  className={`member-option ${botIds.includes(bot.id) ? 'selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    disabled={roomActive}
                    checked={botIds.includes(bot.id)}
                    onChange={(e) =>
                      setBotIds((ids) =>
                        e.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id),
                      )
                    }
                  />
                  <Avatar bot={bot} size="small" />
                  <span>
                    <strong>{bot.name}</strong>
                    <small>@{bot.handle}</small>
                  </span>
                </label>
              ))}
          </div>
          {!data.bots.length && (
            <p className="field-hint">
              {t('先に「ボット」画面から追加してください。', 'Add a bot from Bots first.')}
            </p>
          )}
        </div>
        <div className="field room-workspace-field">
          <span className="field-label">
            {t('このルームの作業場所', 'Workspace for this room')}
          </span>
          <WorkspacePicker
            value={workspacePath}
            defaultPath={data.settings.workspacePath}
            onChange={setWorkspacePath}
            onBusyChange={setPicking}
            disabled={roomActive || busy}
          />
          <p className="field-hint">
            {roomActive
              ? t(
                  '参加ボットや作業場所を変更するには、このルームの作業を停止してください。',
                  'Stop this room’s active tasks before changing its bots or folder.',
                )
              : t(
                  'このルームのボットと自動化が読み書きするフォルダーです。',
                  'Bots and automations in this room read and write files in this folder.',
                )}
          </p>
        </div>
        <footer className="form-actions">
          <Button type="button" onClick={onClose}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={!name.trim() || !botIds.length || picking || (roomActive && workspaceChanged)}
          >
            {room ? t('変更を保存', 'Save changes') : t('ルームをつくる', 'Create room')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
