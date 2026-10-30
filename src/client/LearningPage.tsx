import { useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  Download,
  History,
  Lightbulb,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Memory, Skill } from '../shared/types';
import { dateLabel, useApp } from './context';
import {
  Avatar,
  Button,
  Confirm,
  EmptyState,
  Field,
  IconButton,
  Markdown,
  Modal,
  PageHeader,
} from './components';

export function LearningPage() {
  const { data, t, locale, mutate } = useApp();
  const [tab, setTab] = useState<'skills' | 'memories'>('skills');
  const [filter, setFilter] = useState<'all' | Skill['status']>('all');
  const [query, setQuery] = useState('');
  const [skill, setSkill] = useState<Skill | 'new' | null>(null);
  const [memory, setMemory] = useState<Memory | 'new' | null>(null);
  const [remove, setRemove] = useState<Memory | null>(null);
  const skills = data.skills.filter(
    (item) =>
      (filter === 'all' ? item.status !== 'archived' : item.status === filter) &&
      `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const memories = data.memories.filter((item) =>
    item.content.toLowerCase().includes(query.toLowerCase()),
  );
  const candidates = data.skills.filter((item) => item.status === 'candidate').length;
  return (
    <div className="page-scroll">
      <div className="page-container">
        <PageHeader
          title={t('記憶とスキル', 'Memory & skills')}
          description={t(
            'ボットが参照する情報と、再利用する手順を管理します。',
            'Manage saved context and reusable procedures for your bots.',
          )}
          action={
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => (tab === 'skills' ? setSkill('new') : setMemory('new'))}
            >
              {tab === 'skills' ? t('スキルを追加', 'New skill') : t('記憶を追加', 'New memory')}
            </Button>
          }
        />
        <div className="learning-banner">
          <span className="learning-banner-icon">
            <Sparkles size={24} strokeWidth={1.5} />
          </span>
          <div>
            <strong>{t('スキル候補の確認', 'Review skill candidates')}</strong>
            <p>
              {t(
                '作業から生まれたスキルは、まず候補に。内容を確認して有効にすると、次の作業で利用できます。',
                'Lessons from completed work begin as candidates. Review and activate them to make them available for future work.',
              )}
            </p>
          </div>
          <span className={`subtle-tag ${data.settings.autoLearn ? 'tag-sage' : ''}`}>
            {data.settings.autoLearn
              ? t('自動提案 ON', 'Auto-suggest ON')
              : t('自動提案 OFF', 'Auto-suggest OFF')}
          </span>
        </div>
        <div className="page-tabs">
          <button
            className={tab === 'skills' ? 'selected' : ''}
            onClick={() => {
              setTab('skills');
              setQuery('');
            }}
          >
            <BookOpen size={17} />
            {t('スキル', 'Skills')}
            <span>{data.skills.filter((item) => item.status !== 'archived').length}</span>
          </button>
          <button
            className={tab === 'memories' ? 'selected' : ''}
            onClick={() => {
              setTab('memories');
              setQuery('');
            }}
          >
            <Brain size={17} />
            {t('記憶', 'Memories')}
            <span>{data.memories.length}</span>
          </button>
        </div>
        <div className="list-toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label={t('検索', 'Search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('検索…', 'Search…')}
            />
          </div>
          {tab === 'skills' && (
            <div className="filter-buttons">
              {(['all', 'candidate', 'active', 'archived'] as const).map((value) => (
                <button
                  key={value}
                  className={filter === value ? 'selected' : ''}
                  onClick={() => setFilter(value)}
                >
                  {value === 'all'
                    ? t('すべて', 'All')
                    : value === 'candidate'
                      ? t(`候補 ${candidates || ''}`, `Candidates ${candidates || ''}`)
                      : value === 'active'
                        ? t('有効', 'Active')
                        : t('アーカイブ', 'Archived')}
                </button>
              ))}
            </div>
          )}
        </div>
        {tab === 'skills' ? (
          skills.length ? (
            <div className="skill-grid">
              {skills.map((item) => {
                const bot = data.bots.find((member) => member.id === item.botId);
                return (
                  <button className="skill-card" key={item.id} onClick={() => setSkill(item)}>
                    <header>
                      <span
                        className={`skill-icon ${item.status === 'candidate' ? 'skill-candidate' : ''}`}
                      >
                        {item.status === 'candidate' ? (
                          <Lightbulb size={22} />
                        ) : (
                          <BookOpen size={22} />
                        )}
                      </span>
                      <span
                        className={`subtle-tag ${item.status === 'candidate' ? 'tag-amber' : item.status === 'active' ? 'tag-sage' : ''}`}
                      >
                        {item.status === 'candidate'
                          ? t('確認待ち', 'To review')
                          : item.status === 'active'
                            ? t('有効', 'Active')
                            : t('アーカイブ', 'Archived')}
                      </span>
                    </header>
                    <h2>{item.name}</h2>
                    <p>{item.description}</p>
                    <footer>
                      <span>
                        {bot ? (
                          <>
                            <Avatar bot={bot} size="small" />
                            {bot.name}
                          </>
                        ) : (
                          t('チームで共有', 'Shared with the team')
                        )}
                      </span>
                      <small>
                        v{item.version} · {t(`${item.useCount}回使用`, `${item.useCount} uses`)}
                      </small>
                      <ArrowUpRight size={15} />
                    </footer>
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={BookOpen}
              title={
                query
                  ? t('一致するスキルがありません', 'No matching skills')
                  : t('スキルがありません', 'No skills yet')
              }
            >
              {t(
                '作業を進めると、再利用できる手順が候補として提案されます。自分でスキルを追加することもできます。',
                'Reusable procedures can be proposed after completed work. You can also write and add a skill yourself.',
              )}
            </EmptyState>
          )
        ) : memories.length ? (
          <div className="memory-list">
            {memories.map((item) => {
              const bot = data.bots.find((member) => member.id === item.botId);
              return (
                <article className="memory-card" key={item.id}>
                  <span className="memory-icon">
                    <Brain size={20} />
                  </span>
                  <div>
                    <Markdown>{item.content}</Markdown>
                    <footer>
                      <span>
                        {bot
                          ? `${bot.name} ${t('専用', 'only')}`
                          : t('チームで共有', 'Shared with the team')}
                      </span>
                      <span>{dateLabel(item.updatedAt, locale, true)}</span>
                    </footer>
                  </div>
                  <div className="card-icon-actions">
                    <IconButton
                      icon={Pencil}
                      label={t('編集', 'Edit')}
                      onClick={() => setMemory(item)}
                    />
                    <IconButton
                      icon={Trash2}
                      label={t('削除', 'Delete')}
                      onClick={() => setRemove(item)}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={Brain}
            title={
              query
                ? t('一致する記憶がありません', 'No matching memories')
                : t('記憶がありません', 'No memories yet')
            }
          >
            {t(
              '保存した情報は、全ボットで共有するか、特定のボットに限定できます。',
              'Save context for all bots or limit it to a specific bot.',
            )}
          </EmptyState>
        )}
        {skill && (
          <SkillEditor
            skill={
              skill === 'new'
                ? undefined
                : data.skills.find((item) => item.id === skill.id) || skill
            }
            onClose={() => setSkill(null)}
          />
        )}{' '}
        {memory && (
          <MemoryEditor
            memory={memory === 'new' ? undefined : memory}
            onClose={() => setMemory(null)}
          />
        )}{' '}
        {remove && (
          <Confirm
            title={t('この記憶を削除しますか？', 'Delete this memory?')}
            onClose={() => setRemove(null)}
            onConfirm={async () => {
              await mutate(`/memories/${remove.id}`, 'DELETE');
            }}
          >
            {t(
              '以後の作業で、この記憶を参照しなくなります。',
              'This memory will no longer be used in future work.',
            )}
          </Confirm>
        )}
      </div>
    </div>
  );
}

function SkillEditor({ skill, onClose }: { skill?: Skill; onClose: () => void }) {
  const { data, t, locale, mutate, navigate } = useApp();
  const [name, setName] = useState(skill?.name || '');
  const [description, setDescription] = useState(skill?.description || '');
  const [content, setContent] = useState(skill?.content || '');
  const [botId, setBotId] = useState(skill?.botId || '');
  const [tab, setTab] = useState<'edit' | 'preview' | 'history'>('edit');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      wide
      title={skill ? skill.name : t('新しいスキル', 'New skill')}
      description={t(
        '繰り返し使える手順を、読みやすいMarkdownで。',
        'Write a reusable procedure in readable Markdown.',
      )}
      onClose={onClose}
    >
      {skill?.status === 'candidate' && (
        <div className="inline-note amber-note">
          <Lightbulb size={18} />
          {t(
            'まだ候補です。有効にするまで、エージェントはこのスキルを使いません。',
            'This is a candidate. Teammates will use it only after you activate it.',
          )}
        </div>
      )}
      {skill?.evidence && (
        <details className="evidence-details">
          <summary>{t('提案の根拠を確認', 'Review the evidence')}</summary>
          <p>{skill.evidence}</p>
          {skill.sourceTaskId && (
            <button
              className="text-button"
              onClick={() => {
                const task = data.tasks.find((item) => item.id === skill.sourceTaskId);
                if (task) {
                  navigate('chat', task.roomId);
                  onClose();
                }
              }}
            >
              {t('元の作業を見る', 'View source task')}
              <ArrowUpRight size={13} />
            </button>
          )}
        </details>
      )}
      <div className="editor-tabs">
        <button className={tab === 'edit' ? 'selected' : ''} onClick={() => setTab('edit')}>
          <Pencil size={14} />
          {t('編集', 'Edit')}
        </button>
        <button className={tab === 'preview' ? 'selected' : ''} onClick={() => setTab('preview')}>
          <BookOpen size={14} />
          {t('プレビュー', 'Preview')}
        </button>
        {skill && (
          <button className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}>
            <History size={14} />
            {t('履歴', 'History')} ({skill.revisions.length})
          </button>
        )}
      </div>
      {tab === 'history' && skill ? (
        <div className="revision-list">
          {skill.revisions
            .slice()
            .reverse()
            .map((revision) => (
              <details key={revision.version}>
                <summary>
                  <strong>v{revision.version}</strong>
                  <span>{dateLabel(revision.createdAt, locale, true)}</span>
                  <span>{revision.reason}</span>
                </summary>
                <Markdown>{revision.content}</Markdown>
                <Button
                  icon={History}
                  busy={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await mutate(
                        `/skills/${skill.id}/restore`,
                        'POST',
                        { version: revision.version },
                        t('この版を復元しました', 'Version restored'),
                      );
                      setContent(revision.content);
                      setDescription(revision.description);
                      setTab('edit');
                    } catch {
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t('この版を復元', 'Restore this version')}
                </Button>
              </details>
            ))}
          {!skill.revisions.length && (
            <p className="muted">{t('まだ変更履歴がありません。', 'No earlier versions yet.')}</p>
          )}
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await mutate(
                skill ? `/skills/${skill.id}` : '/skills',
                skill ? 'PATCH' : 'POST',
                { name, description, content, botId: botId || null },
                t('スキルを保存しました', 'Skill saved'),
              );
              onClose();
            } catch {
            } finally {
              setBusy(false);
            }
          }}
        >
          {tab === 'edit' ? (
            <>
              <div className="form-grid">
                <Field label={t('名前', 'Name')}>
                  <input required value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label={t('対象', 'Scope')}>
                  <select value={botId} onChange={(e) => setBotId(e.target.value)}>
                    <option value="">{t('チームで共有', 'Shared with the team')}</option>
                    {data.bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={t('説明・使うタイミング', 'Description & when to use')}>
                <input
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <Field label={t('手順（Markdown）', 'Procedure (Markdown)')}>
                <textarea
                  className="code-input"
                  required
                  rows={12}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={t(
                    '# 目的\n\n## 手順\n1. …\n\n## 確認すること\n- …',
                    '# Purpose\n\n## Steps\n1. …\n\n## Verification\n- …',
                  )}
                />
              </Field>
            </>
          ) : (
            <div className="skill-preview">
              <h2>{name || t('新しいスキル', 'New skill')}</h2>
              <p className="muted">{description}</p>
              <Markdown>
                {content ||
                  t('プレビューする内容がありません。', 'There is no content to preview yet.')}
              </Markdown>
            </div>
          )}
          <footer className="form-actions skill-form-actions">
            <div>
              {skill && (
                <a className="button button-ghost" href={`/api/skills/${skill.id}/export`} download>
                  <Download size={15} />
                  {t('書き出す', 'Export')}
                </a>
              )}
              {skill && (
                <Button
                  type="button"
                  variant="ghost"
                  icon={skill.status === 'archived' ? History : Archive}
                  onClick={async () => {
                    try {
                      await mutate(`/skills/${skill.id}`, 'PATCH', {
                        status: skill.status === 'archived' ? 'candidate' : 'archived',
                      });
                      onClose();
                    } catch {}
                  }}
                >
                  {skill.status === 'archived' ? t('戻す', 'Restore') : t('アーカイブ', 'Archive')}
                </Button>
              )}
            </div>
            <div>
              <Button type="submit" busy={busy}>
                {t('保存', 'Save')}
              </Button>
              {skill && skill.status !== 'active' && (
                <Button
                  type="button"
                  variant="primary"
                  icon={Check}
                  busy={busy}
                  onClick={async () => {
                    if (!name.trim() || !content.trim() || !description.trim()) return;
                    setBusy(true);
                    try {
                      await mutate(
                        `/skills/${skill.id}`,
                        'PATCH',
                        { name, description, content, botId: botId || null, status: 'active' },
                        t('スキルを有効にしました', 'Skill activated'),
                      );
                      onClose();
                    } catch {
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t('有効にする', 'Activate')}
                </Button>
              )}
            </div>
          </footer>
        </form>
      )}
    </Modal>
  );
}

function MemoryEditor({ memory, onClose }: { memory?: Memory; onClose: () => void }) {
  const { data, t, mutate } = useApp();
  const [content, setContent] = useState(memory?.content || '');
  const [botId, setBotId] = useState(memory?.botId || '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={memory ? t('記憶を編集', 'Edit memory') : t('記憶を追加', 'Add memory')}
      description={t(
        'これからの会話や作業で、参照する情報です。',
        'Context your teammates can use in future conversations and work.',
      )}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await mutate(
              memory ? `/memories/${memory.id}` : '/memories',
              memory ? 'PATCH' : 'POST',
              { content, ...(!memory ? { botId: botId || null } : {}) },
              t('記憶を保存しました', 'Memory saved'),
            );
            onClose();
          } catch {
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t('内容', 'Content')}>
          <textarea
            autoFocus
            rows={6}
            required
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t(
              '例：回答は日本語で、最初に要点をまとめてほしい。',
              'e.g. I prefer concise answers with the key points first.',
            )}
          />
        </Field>
        <Field label={t('対象', 'Scope')}>
          <select value={botId} onChange={(e) => setBotId(e.target.value)} disabled={!!memory}>
            <option value="">{t('チームで共有', 'Shared with the team')}</option>
            {data.bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </Field>
        <footer className="form-actions">
          <Button type="button" onClick={onClose}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {t('保存する', 'Save memory')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
