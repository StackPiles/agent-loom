import { useState } from 'react';
import { ArrowUpRight, Bot as BotIcon, Pencil, Plus, Trash2, Users } from 'lucide-react';
import type { Bot } from '../shared/types';
import { activeStatuses, useApp } from './context';
import {
  Avatar,
  Button,
  Confirm,
  EmptyState,
  Field,
  IconButton,
  Modal,
  PageHeader,
  Toggle,
} from './components';

export function TeamPage() {
  const { data, t, mutate } = useApp();
  const [editor, setEditor] = useState<Bot | 'new' | null>(null);
  const [removing, setRemoving] = useState<Bot | null>(null);
  return (
    <div className="page-scroll">
      <div className="page-container">
        <PageHeader
          eyebrow={t('それぞれの得意を、ひとつに', 'MANY MINDS. SHARED MOMENTUM.')}
          title={t('あなたの仲間たち', 'Meet your teammates')}
          description={t(
            '役割と個性を決めて、必要なルームに招待しましょう。',
            'Give each teammate a role, a point of view, and a room to work in.',
          )}
          action={
            <Button variant="primary" icon={Plus} onClick={() => setEditor('new')}>
              {t('仲間をつくる', 'New teammate')}
            </Button>
          }
        />
        <div className="page-note">
          <Users size={19} />
          <p>
            {t(
              '会話は共有。思考の役割は、それぞれ。仲間どうしの引き継ぎも、ひとつのモデルで順番に実行します。',
              'Shared conversations, distinct perspectives. Teammates can hand work to each other, with one model running one turn at a time.',
            )}
          </p>
        </div>
        {!data.bots.length ? (
          <EmptyState
            icon={BotIcon}
            title={t('最初の仲間を迎えましょう', 'Every good team starts somewhere')}
            action={
              <Button icon={Plus} onClick={() => setEditor('new')}>
                {t('仲間を追加', 'Add a teammate')}
              </Button>
            }
          >
            {t(
              '調査、計画、レビュー。得意な役割を与えてみましょう。',
              'Researcher, planner, reviewer. Choose a role that helps you move forward.',
            )}
          </EmptyState>
        ) : (
          <div className="team-grid">
            {data.bots.map((bot) => {
              const busy = data.tasks.some(
                (task) => task.botId === bot.id && activeStatuses.includes(task.status),
              );
              const rooms = data.rooms.filter(
                (room) => !room.archived && room.botIds.includes(bot.id),
              );
              return (
                <article
                  className={`team-card ${!bot.enabled ? 'team-disabled' : ''}`}
                  key={bot.id}
                >
                  <header>
                    <Avatar bot={bot} size="large" />
                    <div className="card-icon-actions">
                      <IconButton
                        icon={Pencil}
                        label={t('編集', 'Edit')}
                        onClick={() => setEditor(bot)}
                      />
                      <IconButton
                        icon={Trash2}
                        label={t('削除', 'Delete')}
                        onClick={() => setRemoving(bot)}
                        disabled={busy}
                      />
                    </div>
                  </header>
                  <h2>
                    {bot.name}
                    <span
                      className={`connection-dot ${busy ? 'working' : bot.enabled ? 'online' : ''}`}
                    />
                  </h2>
                  <span className="bot-handle">@{bot.handle}</span>
                  <p className="bot-role">{bot.role}</p>
                  <p className="bot-prompt-preview">{bot.systemPrompt}</p>
                  <div className="bot-room-tags">
                    {rooms.slice(0, 3).map((room) => (
                      <span key={room.id}># {room.name}</span>
                    ))}
                    {rooms.length > 3 && <span>+{rooms.length - 3}</span>}
                    {!rooms.length && (
                      <span className="muted">
                        {t('まだルームに参加していません', 'No rooms yet')}
                      </span>
                    )}
                  </div>
                  <footer>
                    <Toggle
                      checked={bot.enabled}
                      onChange={(value) =>
                        void mutate(`/bots/${bot.id}`, 'PATCH', { enabled: value }).catch(() => {})
                      }
                      label={bot.enabled ? t('有効', 'Enabled') : t('無効', 'Disabled')}
                    />
                    <button className="text-button" onClick={() => setEditor(bot)}>
                      {t('プロフィール', 'Profile')}
                      <ArrowUpRight size={14} />
                    </button>
                  </footer>
                </article>
              );
            })}
            <button className="add-team-card" onClick={() => setEditor('new')}>
              <span>
                <Plus size={24} />
              </span>
              <strong>{t('新しい視点を加える', 'Make room for a new perspective')}</strong>
              <p>{t('あなたのチームに、もうひとり。', 'Another mind for your team.')}</p>
            </button>
          </div>
        )}
        {editor && (
          <BotEditor bot={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />
        )}{' '}
        {removing && (
          <Confirm
            title={t(`${removing.name}を削除しますか？`, `Delete ${removing.name}?`)}
            onClose={() => setRemoving(null)}
            onConfirm={async () => {
              await mutate(
                `/bots/${removing.id}`,
                'DELETE',
                undefined,
                t('仲間を削除しました', 'Teammate deleted'),
              );
            }}
          >
            {t(
              'この仲間をルームから外し、プロフィールを削除します。過去の会話は残ります。',
              'This removes the teammate from rooms and deletes their profile. Past conversations remain saved.',
            )}
          </Confirm>
        )}
      </div>
    </div>
  );
}

function BotEditor({ bot, onClose }: { bot?: Bot; onClose: () => void }) {
  const { t, mutate } = useApp();
  const [name, setName] = useState(bot?.name || '');
  const [handle, setHandle] = useState(bot?.handle || '');
  const [role, setRole] = useState(bot?.role || '');
  const [prompt, setPrompt] = useState(bot?.systemPrompt || '');
  const [color, setColor] = useState(bot?.color || '#829479');
  const [avatar, setAvatar] = useState(bot?.avatar || '✦');
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const colors = ['#829479', '#7e94aa', '#b79b7d', '#a38dba', '#c28883', '#7daba4'];
  const avatars = ['✦', '◈', '◎', '❋', '✺', '◒', '⌘', '✧'];
  return (
    <Modal
      wide
      title={
        bot
          ? t('仲間のプロフィール', 'Teammate profile')
          : t('新しい仲間をつくる', 'Create a teammate')
      }
      description={t(
        '役割をはっきりさせると、より良いチームになります。',
        'A clear role helps everyone do their best work.',
      )}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await mutate(
              bot ? `/bots/${bot.id}` : '/bots',
              bot ? 'PATCH' : 'POST',
              {
                name: name.trim(),
                handle: handle.toLowerCase().trim(),
                role: role.trim(),
                systemPrompt: prompt.trim(),
                color,
                avatar,
                enabled,
              },
              t('プロフィールを保存しました', 'Teammate saved'),
            );
            onClose();
          } catch {
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="profile-customization">
          <span className="avatar avatar-large" style={{ backgroundColor: color }}>
            {avatar}
          </span>
          <div>
            <div className="avatar-options">
              {avatars.map((symbol) => (
                <button
                  type="button"
                  key={symbol}
                  className={avatar === symbol ? 'selected' : ''}
                  onClick={() => setAvatar(symbol)}
                  aria-label={`${t('アバター', 'Avatar')} ${symbol}`}
                >
                  {symbol}
                </button>
              ))}
            </div>
            <div className="color-options">
              {colors.map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-label={`${t('色', 'Color')} ${value}`}
                  aria-pressed={color === value}
                  className={color === value ? 'selected' : ''}
                  style={{ backgroundColor: value }}
                  onClick={() => setColor(value)}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="form-grid">
          <Field label={t('名前', 'Name')}>
            <input
              autoFocus
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('例：Nori', 'e.g. Nori')}
            />
          </Field>
          <Field
            label={t('短いハンドル', 'Short handle')}
            hint={t(
              '英小文字・数字・ハイフン・アンダースコア。@で呼べます。',
              'Lowercase letters, numbers, hyphens, underscores. Mention with @.',
            )}
          >
            <div className="input-prefix">
              <span>@</span>
              <input
                required
                pattern="[a-zA-Z0-9_-]{1,32}"
                maxLength={32}
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="nori"
              />
            </div>
          </Field>
        </div>
        <Field label={t('役割', 'Role')}>
          <input
            required
            maxLength={120}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder={t('例：リサーチと情報整理', 'e.g. Research & synthesis')}
          />
        </Field>
        <Field
          label={t('システムプロンプト', 'System prompt')}
          hint={t(
            '得意分野、進め方、他の仲間への引き継ぎ方などを指示します。',
            'Describe expertise, working style, and when to hand off to other teammates.',
          )}
        >
          <textarea
            required
            rows={7}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t(
              'あなたは丁寧なリサーチ担当です。根拠を確かめ、わからない点は明確に伝えます。',
              'You are a thoughtful researcher. Verify your sources and clearly explain uncertainty.',
            )}
          />
        </Field>
        <Toggle
          label={t('この仲間を有効にする', 'Enable this teammate')}
          checked={enabled}
          onChange={setEnabled}
        />
        <footer className="form-actions">
          <Button type="button" onClick={onClose}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button variant="primary" type="submit" busy={busy}>
            {t('保存する', 'Save teammate')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
