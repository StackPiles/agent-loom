import { useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Brain,
  Lightbulb,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import type { Memory, Skill } from '../shared/types';
import { normalizeMemory, normalizeSkill, normalizedLearningText } from '../shared/learning';
import { dateLabel, useApp } from './context';
import { Avatar, Button, EmptyState, IconButton, Markdown, PageHeader } from './components';
import { LearningEditor } from './LearningEditor';

export function LearningPage() {
  const { data, t, locale } = useApp();
  const [tab, setTab] = useState<'skills' | 'memories'>('skills');
  const [skillFilter, setSkillFilter] = useState<'all' | Skill['status']>('all');
  const [memoryFilter, setMemoryFilter] = useState<'active' | 'archived'>('active');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<
    { kind: 'skill'; item?: Skill } | { kind: 'memory'; item?: Memory } | null
  >(null);
  const normalizedQuery = normalizedLearningText(query);
  const allSkills = data.skills.map(normalizeSkill);
  const allMemories = data.memories.map(normalizeMemory);
  const skills = allSkills
    .filter(
      (item) =>
        (skillFilter === 'all' ? item.status !== 'archived' : item.status === skillFilter) &&
        normalizedLearningText(item.name + ' ' + item.description + ' ' + item.content).includes(
          normalizedQuery,
        ),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const memories = allMemories
    .filter(
      (item) =>
        item.status === memoryFilter &&
        normalizedLearningText(item.content).includes(normalizedQuery),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const candidates = allSkills.filter((item) => item.status === 'candidate').length;
  const roomLabel = (roomId: string | null) =>
    roomId
      ? (data.rooms.find((room) => room.id === roomId)?.name ??
        t('ルームが見つかりません', 'Room unavailable'))
      : t('すべてのルーム', 'All rooms');

  return (
    <div className="page-scroll">
      <div className="page-container learning-page">
        <PageHeader
          title={t('記憶とスキル', 'Memory & skills')}
          description={t(
            'ボットが参照する情報と手順を、変更の根拠や履歴と一緒に管理します。',
            'Manage saved context and procedures alongside their evidence and history.',
          )}
          action={
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => setSelected({ kind: tab === 'skills' ? 'skill' : 'memory' })}
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
            <strong>{t('経験を、次の仕事に', 'Use experience in the next task')}</strong>
            <p>
              {t(
                'ボットが作る自分用スキルは自動で有効になります。記憶とスキルは根拠を残して更新でき、固定・アーカイブした内容は自動で書き換えません。',
                'Bots automatically activate their own new skills and record the evidence for updates. Fixed or archived items are protected from automatic edits.',
              )}
            </p>
          </div>
          <span className={'subtle-tag ' + (data.settings.autoLearn ? 'tag-sage' : '')}>
            {data.settings.autoLearn
              ? t('作業後の振り返り ON', 'Post-task review ON')
              : t('作業後の振り返り OFF', 'Post-task review OFF')}
          </span>
        </div>
        <div
          className="page-tabs"
          onFocus={(event) =>
            event.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
          }
        >
          <button
            className={tab === 'skills' ? 'selected' : ''}
            aria-pressed={tab === 'skills'}
            onClick={() => {
              setTab('skills');
              setQuery('');
            }}
          >
            <BookOpen size={17} />
            {t('スキル', 'Skills')}
            <span>{allSkills.filter((item) => item.status !== 'archived').length}</span>
          </button>
          <button
            className={tab === 'memories' ? 'selected' : ''}
            aria-pressed={tab === 'memories'}
            onClick={() => {
              setTab('memories');
              setQuery('');
            }}
          >
            <Brain size={17} />
            {t('記憶', 'Memories')}
            <span>{allMemories.filter((item) => item.status === 'active').length}</span>
          </button>
        </div>
        <div className="list-toolbar learning-toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label={t('検索', 'Search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('検索…', 'Search…')}
            />
          </div>
          <div className="filter-buttons" aria-label={t('表示する状態', 'Filter by status')}>
            {tab === 'skills'
              ? (['all', 'candidate', 'active', 'archived'] as const).map((value) => (
                  <button
                    key={value}
                    className={skillFilter === value ? 'selected' : ''}
                    aria-pressed={skillFilter === value}
                    onClick={() => setSkillFilter(value)}
                  >
                    {value === 'all'
                      ? t('すべて', 'All')
                      : value === 'candidate'
                        ? t('候補', 'Candidates') + (candidates ? ' ' + candidates : '')
                        : value === 'active'
                          ? t('有効', 'Active')
                          : t('アーカイブ', 'Archived')}
                  </button>
                ))
              : (['active', 'archived'] as const).map((value) => (
                  <button
                    key={value}
                    className={memoryFilter === value ? 'selected' : ''}
                    aria-pressed={memoryFilter === value}
                    onClick={() => setMemoryFilter(value)}
                  >
                    {value === 'active' ? t('使用中', 'In use') : t('アーカイブ', 'Archived')}
                  </button>
                ))}
          </div>
        </div>
        {tab === 'skills' ? (
          skills.length ? (
            <div className="skill-grid">
              {skills.map((item) => {
                const bot = data.bots.find((member) => member.id === item.botId);
                return (
                  <button
                    className="skill-card"
                    key={item.id}
                    onClick={() => setSelected({ kind: 'skill', item })}
                    aria-label={t('スキルを開く: ', 'Open skill: ') + item.name}
                  >
                    <header>
                      <span
                        className={
                          'skill-icon ' + (item.status === 'candidate' ? 'skill-candidate' : '')
                        }
                      >
                        {item.status === 'candidate' ? (
                          <Lightbulb size={22} />
                        ) : (
                          <BookOpen size={22} />
                        )}
                      </span>
                      <span className="learning-tags">
                        {item.locked && (
                          <span className="subtle-tag">
                            <LockKeyhole size={11} />
                            {t('固定', 'Fixed')}
                          </span>
                        )}
                        <span
                          className={
                            'subtle-tag ' +
                            (item.status === 'candidate'
                              ? 'tag-amber'
                              : item.status === 'active'
                                ? 'tag-sage'
                                : '')
                          }
                        >
                          {item.status === 'candidate'
                            ? t('候補', 'Candidate')
                            : item.status === 'active'
                              ? item.autoActivated
                                ? t('自動有効', 'Auto-active')
                                : t('有効', 'Active')
                              : t('アーカイブ', 'Archived')}
                        </span>
                      </span>
                    </header>
                    <h2>{item.name}</h2>
                    <p>{item.description}</p>
                    <span className="learning-room-label">{roomLabel(item.roomId)}</span>
                    <footer>
                      <span>
                        {bot ? (
                          <>
                            <Avatar bot={bot} size="small" />
                            {bot.name}
                          </>
                        ) : item.botId ? (
                          t('ボットが見つかりません', 'Bot unavailable')
                        ) : (
                          t('チームで共有', 'Shared with the team')
                        )}
                      </span>
                      <small>
                        v{item.version} · {t(item.useCount + '回参照', item.useCount + ' reads')}
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
              title={t('表示するスキルがありません', 'No skills to show')}
            >
              {query
                ? t(
                    '検索条件や表示する状態を変えてみてください。',
                    'Try another search or status filter.',
                  )
                : t(
                    'ボットは再利用できる手順を保存・改善できます。自分でスキルを追加することもできます。',
                    'Bots can save and improve reusable procedures. You can also add your own skills.',
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
                    <div className="learning-tags memory-tags">
                      <span className="subtle-tag">v{item.version}</span>
                      {item.locked && (
                        <span className="subtle-tag">
                          <LockKeyhole size={11} />
                          {t('固定', 'Fixed')}
                        </span>
                      )}
                      {item.status === 'archived' && (
                        <span className="subtle-tag">{t('アーカイブ', 'Archived')}</span>
                      )}
                    </div>
                    <Markdown>{item.content}</Markdown>
                    <footer>
                      <span>
                        {bot
                          ? bot.name
                          : item.botId
                            ? t('ボットが見つかりません', 'Bot unavailable')
                            : t('チームで共有', 'Shared with the team')}
                      </span>
                      <span>{roomLabel(item.roomId)}</span>
                      <span>{dateLabel(item.updatedAt, locale, true)}</span>
                    </footer>
                  </div>
                  <div className="card-icon-actions">
                    <IconButton
                      icon={Pencil}
                      label={t('編集と履歴', 'Edit and history')}
                      onClick={() => setSelected({ kind: 'memory', item })}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Brain} title={t('表示する記憶がありません', 'No memories to show')}>
            {query
              ? t(
                  '検索条件や表示する状態を変えてみてください。',
                  'Try another search or status filter.',
                )
              : memoryFilter === 'archived'
                ? t(
                    '古くなった記憶はアーカイブすると、通常の参照対象から外せます。履歴は残ります。',
                    'Archive outdated memories to stop using them while keeping their history.',
                  )
                : t(
                    '保存した情報は、ボットやルームを指定して使う範囲を決められます。',
                    'Choose which bot and room can use each saved memory.',
                  )}
          </EmptyState>
        )}
        {selected && (
          <LearningEditor
            key={selected.kind + ':' + (selected.item?.id ?? 'new')}
            selection={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}
