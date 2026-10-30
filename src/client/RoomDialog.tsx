import { useState } from 'react';
import type { Room } from '../shared/types';
import { useApp } from './context';
import { Avatar, Button, Field, Modal } from './components';

export function RoomDialog({ room, onClose }: { room?: Room; onClose: () => void }) {
  const { data, t, mutate, navigate } = useApp();
  const [name, setName] = useState(room?.name || '');
  const [description, setDescription] = useState(room?.description || '');
  const [botIds, setBotIds] = useState(
    room?.botIds || data.bots.filter((b) => b.enabled).map((b) => b.id),
  );
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={room ? t('ルームを編集', 'Edit room') : t('新しいルーム', 'Create a room')}
      description={t(
        'ルーム名、目的、参加するボットを設定します。',
        'Set a name, purpose, and participating bots.',
      )}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const result = await mutate<Room>(
              room ? `/rooms/${room.id}` : '/rooms',
              room ? 'PATCH' : 'POST',
              { name: name.trim(), description: description.trim(), botIds },
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
          <span className="field-label">{t('参加する仲間', 'Teammates')}</span>
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
              {t('先に「仲間」からBotを追加してください。', 'Add a bot from Team first.')}
            </p>
          )}
        </div>
        <footer className="form-actions">
          <Button type="button" onClick={onClose}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={!name.trim() || !botIds.length}
          >
            {room ? t('変更を保存', 'Save changes') : t('ルームをつくる', 'Create room')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
