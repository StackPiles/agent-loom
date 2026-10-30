import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Cpu,
  FlaskConical,
  FolderOpen,
  Globe2,
  Link2,
  Save,
  ShieldCheck,
  Sparkles,
  Unplug,
  X,
} from 'lucide-react';
import type { Permission, Settings } from '../shared/types';
import { api } from './api';
import { useApp } from './context';
import { Button, Field, PageHeader, Toggle } from './components';

export function SettingsPage() {
  const { data, t, mutate, toast, navigate, signOut } = useApp();
  const [draft, setDraft] = useState<Settings>(() => structuredClone(data.settings));
  const [modelKey, setModelKey] = useState('');
  const [modelKeyDirty, setModelKeyDirty] = useState(false);
  const [searchKey, setSearchKey] = useState('');
  const [searchKeyDirty, setSearchKeyDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string; models: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [desktop, setDesktop] = useState(
    () => localStorage.getItem('loom.notifications') === 'true',
  );
  const [authRequired, setAuthRequired] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ required: boolean }>('/auth')
      .then((result) => {
        if (active) setAuthRequired(result.required);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const setModel = (values: Partial<Settings['model']>) => {
    setDraft((current) => ({ ...current, model: { ...current.model, ...values } }));
    setDirty(true);
    setTest(null);
  };
  const setSearch = (values: Partial<Settings['search']>) => {
    setDraft((current) => ({ ...current, search: { ...current.search, ...values } }));
    setDirty(true);
  };
  const update = (values: Partial<Settings>) => {
    setDraft((current) => ({ ...current, ...values }));
    setDirty(true);
  };
  const configured = !!data.settings.model.modelId;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await mutate(
        '/settings',
        'PUT',
        {
          model: {
            baseUrl: draft.model.baseUrl.trim().replace(/\/$/, ''),
            modelId: draft.model.modelId.trim(),
            contextWindow: draft.model.contextWindow,
            maxOutputTokens: draft.model.maxOutputTokens,
            temperature: draft.model.temperature,
            ...(modelKeyDirty ? { apiKey: modelKey } : {}),
          },
          autoLearn: draft.autoLearn,
          maxHandoffs: draft.maxHandoffs,
          workspacePath: draft.workspacePath,
          permissions: draft.permissions,
          search: {
            provider: draft.search.provider,
            baseUrl: draft.search.baseUrl,
            ...(searchKeyDirty ? { apiKey: searchKey } : {}),
          },
        },
        t('設定を保存しました', 'Settings saved'),
      );
      setModelKey('');
      setSearchKey('');
      setModelKeyDirty(false);
      setSearchKeyDirty(false);
      setDirty(false);
    } catch {
    } finally {
      setSaving(false);
    }
  }
  async function testConnection() {
    setTesting(true);
    try {
      const result = await api<{ ok: boolean; models: string[]; message: string }>(
        '/settings/test',
        'POST',
        {
          baseUrl: draft.model.baseUrl,
          modelId: draft.model.modelId,
          ...(modelKeyDirty ? { apiKey: modelKey } : {}),
        },
      );
      setTest(result);
    } catch (error) {
      setTest({ ok: false, models: [], message: (error as Error).message });
    } finally {
      setTesting(false);
    }
  }
  return (
    <div className="page-scroll">
      <div className="page-container settings-container">
        <PageHeader
          eyebrow={t('あなたらしい、ワークスペースに', 'MAKE YOURSELF AT HOME')}
          title={t('設定', 'Your workspace, your way')}
          description={t(
            'モデル、権限、学び方。ちょうどよい動き方に整えましょう。',
            'Your model, permissions, and working style. Make this space work for you.',
          )}
        />
        {!configured && (
          <div className="setup-banner">
            <span className="setup-icon">
              <Link2 size={24} />
            </span>
            <div>
              <strong>{t('最初の一歩は、モデルの接続。', 'Start with a connection.')}</strong>
              <p>
                {t(
                  '推論サーバーを起動して、下のURLとモデルIDを設定してください。デモなら、接続前でも操作を試せます。',
                  'Start your inference server, then enter its URL and model ID below. You can also explore the interface in demo mode.',
                )}
              </p>
            </div>
          </div>
        )}
        <form onSubmit={save}>
          <section className="settings-section" id="model-settings">
            <div className="settings-section-heading">
              <span>
                <Cpu size={20} />
              </span>
              <div>
                <h2>{t('モデルへの接続', 'Connect your model')}</h2>
                <p>
                  {t(
                    'OpenAI互換APIを持つ推論サーバーに接続します。',
                    'Connect to an inference server with an OpenAI-compatible API.',
                  )}
                </p>
              </div>
              <span className="subtle-tag">LOCAL FIRST</span>
            </div>
            <div className="settings-section-body">
              <div className="provider-presets">
                <span>{t('URLの入力例', 'URL presets')}</span>
                {[
                  { label: 'Ollama', url: 'http://localhost:11434/v1' },
                  { label: 'LM Studio', url: 'http://localhost:1234/v1' },
                  { label: 'llama.cpp', url: 'http://localhost:8080/v1' },
                ].map((provider) => (
                  <button
                    key={provider.label}
                    type="button"
                    onClick={() => setModel({ baseUrl: provider.url })}
                  >
                    {provider.label}
                    <ArrowRight size={12} />
                  </button>
                ))}
              </div>
              <Field
                label={t('APIのベースURL', 'API base URL')}
                hint={t(
                  'Agent Loomのサーバーから到達できるURL。通常は末尾が /v1 です。Dockerからホストへは host.docker.internal を使います。',
                  'A URL reachable from the Agent Loom server, usually ending in /v1. From Docker, use host.docker.internal to reach the host.',
                )}
              >
                <input
                  type="url"
                  required
                  value={draft.model.baseUrl}
                  onChange={(e) => setModel({ baseUrl: e.target.value })}
                  placeholder="http://localhost:11434/v1"
                  spellCheck={false}
                />
              </Field>
              <div className="form-grid">
                <Field
                  label={t('モデルID', 'Model ID')}
                  hint={t(
                    '推論サーバーに表示される正確なIDを指定します。',
                    'Use the exact model ID shown by your inference server.',
                  )}
                >
                  <input
                    value={draft.model.modelId}
                    onChange={(e) => setModel({ modelId: e.target.value })}
                    placeholder="qwen3.5:9b"
                    list="model-ids"
                    spellCheck={false}
                  />
                  <datalist id="model-ids">
                    {test?.models.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </Field>
                <Field
                  label={t('APIキー（必要な場合）', 'API key (if required)')}
                  hint={
                    data.settings.model.apiKeyConfigured
                      ? t(
                          '保存済みのキーは、同じオリジン（方式・ホスト・ポート）でのみ再利用します。接続先を変える場合、入力し直さないと保存時に削除されます。接続テストでも別オリジンへ元のキーは送りません。',
                          'The saved key is reused only for the same origin (scheme, host, and port). Changing origin clears it on save unless you enter a key. Connection tests never forward the saved key to a different origin.',
                        )
                      : t(
                          '認証が不要なローカルサーバーでは空欄のままで構いません。',
                          'Leave blank for a local server without authentication.',
                        )
                  }
                >
                  <div className="secret-field">
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={modelKey}
                      onChange={(e) => {
                        setModelKey(e.target.value);
                        setModelKeyDirty(true);
                        setDirty(true);
                      }}
                      placeholder={
                        data.settings.model.apiKeyConfigured && !modelKeyDirty ? '••••••••••••' : ''
                      }
                    />
                    {data.settings.model.apiKeyConfigured && (
                      <button
                        type="button"
                        onClick={() => {
                          setModelKey('');
                          setModelKeyDirty(true);
                          setDirty(true);
                        }}
                        title={t('保存時にキーを削除', 'Clear key when saved')}
                        aria-label={t('APIキーを削除', 'Clear API key')}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  {modelKeyDirty && !modelKey && data.settings.model.apiKeyConfigured && (
                    <small className="form-error">
                      {t('保存するとキーを削除します。', 'The saved key will be cleared on save.')}
                    </small>
                  )}
                </Field>
              </div>
              <div className="connection-test-row">
                <Button
                  type="button"
                  icon={Link2}
                  busy={testing}
                  disabled={!draft.model.baseUrl}
                  onClick={() => void testConnection()}
                >
                  {t('接続をテスト', 'Test connection')}
                </Button>
                <span>
                  {t(
                    'モデル一覧を確認します。推論は実行しません。',
                    'Checks model discovery. Does not run inference.',
                  )}
                </span>
              </div>
              {test && (
                <div
                  className={`connection-result ${test.ok ? 'result-success' : 'result-error'}`}
                  role="status"
                >
                  {test.ok ? <Check size={18} /> : <CircleHelp size={18} />}
                  <div>
                    <strong>
                      {test.ok
                        ? t('APIに接続できました', 'The API is reachable')
                        : t('接続を確認してください', 'Check the connection')}
                    </strong>
                    <p>{test.message}</p>
                    {test.models.length > 0 && (
                      <div className="detected-models">
                        {test.models.slice(0, 12).map((model) => (
                          <button
                            key={model}
                            type="button"
                            onClick={() => {
                              setDraft((current) => ({
                                ...current,
                                model: { ...current.model, modelId: model },
                              }));
                              setDirty(true);
                            }}
                          >
                            {model}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <details className="advanced-settings">
                <summary>
                  {t('推論の詳細設定', 'Inference settings')}
                  <ChevronDown size={15} />
                </summary>
                <div className="form-grid form-grid-three">
                  <Field label={t('コンテキスト上限', 'Context window')}>
                    <input
                      type="number"
                      min={2048}
                      max={2097152}
                      step={1024}
                      required
                      value={draft.model.contextWindow}
                      onChange={(e) => setModel({ contextWindow: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label={t('出力トークン上限', 'Max output tokens')}>
                    <input
                      type="number"
                      min={256}
                      max={draft.model.contextWindow}
                      step={256}
                      required
                      value={draft.model.maxOutputTokens}
                      onChange={(e) => setModel({ maxOutputTokens: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label={t('温度', 'Temperature')}>
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      required
                      value={draft.model.temperature}
                      onChange={(e) => setModel({ temperature: Number(e.target.value) })}
                    />
                  </Field>
                </div>
                <p className="field-hint">
                  {t(
                    'モデルの実際の上限に合わせてください。ツール呼び出し対応モデルを推奨します。',
                    'Match your model’s actual limits. A model that supports tool calls is recommended.',
                  )}
                </p>
              </details>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading">
              <span>
                <ShieldCheck size={20} />
              </span>
              <div>
                <h2>{t('操作の権限', 'Permissions, made clear')}</h2>
                <p>
                  {t(
                    '何を任せ、何を確認するかを決めます。',
                    'Choose what can run and what needs your review.',
                  )}
                </p>
              </div>
            </div>
            <div className="settings-section-body permission-list">
              {(
                [
                  {
                    key: 'shell',
                    label: t('シェルの実行', 'Shell commands'),
                    detail: t(
                      '作業フォルダでコマンドを実行します。',
                      'Run commands in the workspace folder.',
                    ),
                  },
                  {
                    key: 'fileWrite',
                    label: t('ファイルの書き込み', 'File writes'),
                    detail: t(
                      '作業フォルダのファイルを作成・変更します。',
                      'Create and modify files in the workspace folder.',
                    ),
                  },
                  {
                    key: 'network',
                    label: t('外部ネットワークへのアクセス', 'External network access'),
                    detail: t(
                      'Webページや検索サービスにアクセスします。',
                      'Access web pages and search services.',
                    ),
                  },
                ] as const
              ).map((permission) => (
                <div className="permission-row" key={permission.key}>
                  <div>
                    <strong>{permission.label}</strong>
                    <p>{permission.detail}</p>
                  </div>
                  <select
                    aria-label={permission.label}
                    value={draft.permissions[permission.key]}
                    onChange={(e) =>
                      update({
                        permissions: {
                          ...draft.permissions,
                          [permission.key]: e.target.value as Permission,
                        },
                      })
                    }
                  >
                    <option value="ask">{t('毎回確認', 'Ask each time')}</option>
                    <option value="allow">{t('許可', 'Allow')}</option>
                    <option value="deny">{t('拒否', 'Deny')}</option>
                  </select>
                </div>
              ))}
              <p className="field-hint">
                {t(
                  '承認カードには、ツール名・対象・正確な引数を表示します。「許可」はその1回の操作に適用されます。',
                  'Approval cards show the tool, target, and exact arguments. Each approval applies to one action.',
                )}
              </p>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading">
              <span>
                <Globe2 size={20} />
              </span>
              <div>
                <h2>{t('Web検索', 'A wider view')}</h2>
                <p>
                  {t(
                    '検索サービスを接続すると、仲間がWebを調べられます。',
                    'Connect a search service so your teammates can research the web.',
                  )}
                </p>
              </div>
            </div>
            <div className="settings-section-body">
              <Field label={t('検索プロバイダー', 'Search provider')}>
                <select
                  value={draft.search.provider}
                  onChange={(e) =>
                    setSearch({ provider: e.target.value as Settings['search']['provider'] })
                  }
                >
                  <option value="none">{t('未設定', 'Not configured')}</option>
                  <option value="searxng">SearXNG</option>
                  <option value="brave">Brave Search</option>
                </select>
              </Field>
              {draft.search.provider === 'searxng' && (
                <Field
                  label="SearXNG URL"
                  hint={t(
                    'JSON形式の検索を有効にしたインスタンスを指定してください。',
                    'Use an instance with JSON search enabled.',
                  )}
                >
                  <input
                    type="url"
                    required
                    value={draft.search.baseUrl}
                    onChange={(e) => setSearch({ baseUrl: e.target.value })}
                    placeholder="http://localhost:8080"
                  />
                </Field>
              )}
              {draft.search.provider === 'brave' && (
                <Field
                  label="Brave Search API key"
                  hint={
                    data.settings.search.apiKeyConfigured
                      ? t(
                          '保存済み。空欄なら現在のキーを使います。',
                          'A key is saved. Leave blank to keep it.',
                        )
                      : t(
                          'Brave Search APIのキーを設定してください。',
                          'Enter your Brave Search API key.',
                        )
                  }
                >
                  <div className="secret-field">
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={searchKey}
                      onChange={(e) => {
                        setSearchKey(e.target.value);
                        setSearchKeyDirty(true);
                        setDirty(true);
                      }}
                      placeholder={
                        data.settings.search.apiKeyConfigured && !searchKeyDirty
                          ? '••••••••••••'
                          : ''
                      }
                    />
                    {data.settings.search.apiKeyConfigured && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchKey('');
                          setSearchKeyDirty(true);
                          setDirty(true);
                        }}
                        aria-label={t('検索APIキーを削除', 'Clear search API key')}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                </Field>
              )}
              {draft.search.provider === 'none' && (
                <p className="field-hint">
                  {t(
                    'Web検索は無効です。URLを指定したページの取得は、ネットワーク権限に従って利用できます。',
                    'Web search is disabled. Fetching a specific URL remains available according to your network permission.',
                  )}
                </p>
              )}
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading">
              <span>
                <Sparkles size={20} />
              </span>
              <div>
                <h2>{t('学び方と、引き継ぎ', 'Learning & collaboration')}</h2>
                <p>
                  {t(
                    '育てる速さと、仕事の広がりを調整します。',
                    'Set a comfortable pace for growth and delegation.',
                  )}
                </p>
              </div>
            </div>
            <div className="settings-section-body">
              <Toggle
                checked={draft.autoLearn}
                onChange={(value) => update({ autoLearn: value })}
                label={t('スキルの候補を自動で提案', 'Suggest reusable skills automatically')}
                description={t(
                  '作業後に再利用できる手順を候補として保存します。有効化はあなたが決めます。',
                  'Save reusable procedures as candidates after work. You decide what to activate.',
                )}
              />
              <Field
                label={t('1つの作業の引き継ぎ上限', 'Maximum handoffs per task')}
                hint={t(
                  '仲間どうしで作業を渡す回数を制限します。推論は常に1件ずつ実行します。',
                  'Limits total handoffs within one originating task, including handoff depth. Inference always runs one task at a time.',
                )}
              >
                <input
                  type="number"
                  className="short-input"
                  required
                  min={0}
                  max={10}
                  value={draft.maxHandoffs}
                  onChange={(e) => update({ maxHandoffs: Number(e.target.value) })}
                />
              </Field>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading">
              <span>
                <FolderOpen size={20} />
              </span>
              <div>
                <h2>{t('作業フォルダ', 'A place to work')}</h2>
                <p>
                  {t(
                    '仲間が読み書きするファイルの場所です。',
                    'The folder where your teammates read and write files.',
                  )}
                </p>
              </div>
            </div>
            <div className="settings-section-body">
              <Field
                label={t('フォルダのパス', 'Workspace path')}
                hint={t(
                  'Agent Loomサーバー上のパスです。変更は次の作業から適用されます。',
                  'A path on the Agent Loom server. Changes apply to future tasks.',
                )}
              >
                <input
                  required
                  value={draft.workspacePath}
                  onChange={(e) => update({ workspacePath: e.target.value })}
                  spellCheck={false}
                />
              </Field>
            </div>
          </section>
          <div className={`settings-savebar ${dirty ? 'has-changes' : ''}`}>
            <span>
              {dirty
                ? t('保存していない変更があります', 'You have unsaved changes')
                : t(
                    '設定はこのワークスペースに保存されます',
                    'Settings are stored in this workspace',
                  )}
            </span>
            <Button type="submit" variant="primary" icon={Save} busy={saving} disabled={!dirty}>
              {t('変更を保存', 'Save changes')}
            </Button>
          </div>
        </form>
        <section className="settings-section">
          <div className="settings-section-heading">
            <span>
              <Bell size={20} />
            </span>
            <div>
              <h2>{t('お知らせ', 'Stay in the loop')}</h2>
              <p>
                {t('このブラウザーでのお知らせ方法です。', 'How this browser keeps you informed.')}
              </p>
            </div>
          </div>
          <div className="settings-section-body">
            <Toggle
              label={t('デスクトップ通知', 'Desktop notifications')}
              description={t(
                'このアプリをブラウザーで開いている間、新しいお知らせを通知します。',
                'Show new updates while this app is open in your browser.',
              )}
              checked={desktop}
              disabled={!('Notification' in window)}
              onChange={async (value) => {
                if (value) {
                  const permission = await Notification.requestPermission();
                  if (permission !== 'granted') {
                    toast(
                      t(
                        'ブラウザーの設定で通知を許可してください。',
                        'Allow notifications in your browser settings.',
                      ),
                      'error',
                    );
                    return;
                  }
                }
                localStorage.setItem('loom.notifications', String(value));
                setDesktop(value);
              }}
            />
          </div>
        </section>
        <section className="settings-section demo-section">
          <div className="settings-section-heading">
            <span>
              <FlaskConical size={20} />
            </span>
            <div>
              <h2>{t('気軽に、試してみる', 'Take it for a spin')}</h2>
              <p>
                {t(
                  'モデルの接続前に、会話・引き継ぎ・承認を体験できます。',
                  'Explore conversations, handoffs, and approvals before connecting a model.',
                )}
              </p>
            </div>
            <span className="subtle-tag tag-amber">DEMO</span>
          </div>
          <div className="settings-section-body">
            <Toggle
              checked={data.settings.demoMode}
              onChange={(value) =>
                void mutate(
                  '/demo',
                  'POST',
                  { enabled: value },
                  value
                    ? t('デモモードを有効にしました', 'Demo mode enabled')
                    : t('デモモードを終了しました', 'Demo mode disabled'),
                ).catch(() => {})
              }
              label={t('デモモード', 'Demo mode')}
              description={t(
                '応答はシミュレーションです。推論サーバーには接続しません。画面に「DEMO」を表示します。',
                'Responses are simulated. No inference server is contacted. A DEMO label stays visible.',
              )}
            />
            {data.settings.demoMode && (
              <Button variant="ghost" icon={ArrowRight} onClick={() => navigate('chat')}>
                {t('ルームで試す', 'Try it in a room')}
              </Button>
            )}
          </div>
        </section>
        <div className="settings-footer">
          <span>Agent Loom · v{data.version}</span>
          {authRequired && (
            <Button
              icon={Unplug}
              variant="ghost"
              busy={signingOut}
              onClick={async () => {
                setSigningOut(true);
                try {
                  await signOut();
                } catch (error) {
                  toast((error as Error).message, 'error');
                } finally {
                  setSigningOut(false);
                }
              }}
            >
              {t('ログアウト', 'Sign out')}
            </Button>
          )}
          <span>{t('あなたの手元で、少しずつ。', 'Thoughtfully, locally, yours.')}</span>
        </div>
      </div>
    </div>
  );
}
