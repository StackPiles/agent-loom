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
import type { Permission, ReasoningEffort, Settings } from '../shared/types';
import { MODEL_TOKEN_LIMITS } from '../shared/model-limits';
import { REASONING_EFFORTS } from '../shared/model-settings';
import { api } from './api';
import { activeStatuses, useApp } from './context';
import { Button, Field, PageHeader, Toggle } from './components';
import { WorkspacePicker } from './WorkspacePicker';
import { InferenceSettings } from './InferenceSettings';
import { ImageSettings, defaultImageSettings, type ImageSettingsValue } from './ImageSettings';

type TokenRange = { min: number; max: number };
const reasoningLabels: Record<ReasoningEffort, [string, string]> = {
  none: ['なし (none)', 'None'],
  minimal: ['最小', 'Minimal'],
  low: ['低', 'Low'],
  medium: ['標準', 'Medium'],
  high: ['高', 'High'],
  xhigh: ['非常に高い (xhigh)', 'Extra high (xhigh)'],
  max: ['最大 (max)', 'Maximum (max)'],
  ultra: ['Ultra（サーバー拡張）', 'Ultra (server extension)'],
};
function withinTokenRange(value: number, range: TokenRange) {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}
function tokenChoices(range: TokenRange, current: number, saved: number) {
  const values = new Set<number>([current, saved]);
  for (let value = 2 ** Math.ceil(Math.log2(range.min)); value <= range.max; value *= 2)
    values.add(value);
  return [...values].sort((a, b) => a - b);
}

export function SettingsPage() {
  const { data, t, mutate, toast, navigate, signOut } = useApp();
  const [draft, setDraft] = useState<Settings>(() => structuredClone(data.settings));
  const [modelKey, setModelKey] = useState('');
  const [modelKeyDirty, setModelKeyDirty] = useState(false);
  const [searchKey, setSearchKey] = useState('');
  const [searchKeyDirty, setSearchKeyDirty] = useState(false);
  const [imageKey, setImageKey] = useState('');
  const [imageKeyDirty, setImageKeyDirty] = useState(false);
  const [imagesDirty, setImagesDirty] = useState(false);
  const [inferenceDirty, setInferenceDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string; models: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [desktop, setDesktop] = useState(
    () => localStorage.getItem('loom.notifications') === 'true',
  );
  const [authRequired, setAuthRequired] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const hasActiveTasks = data.tasks.some((task) => activeStatuses.includes(task.status));
  const hasActiveDefaultTasks = data.tasks.some(
    (task) =>
      activeStatuses.includes(task.status) &&
      !data.rooms.find((room) => room.id === task.roomId)?.workspacePath,
  );
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
  const images = draft.images ?? defaultImageSettings;
  const setImages = (values: Partial<ImageSettingsValue>) => {
    setDraft((current) => ({
      ...current,
      images: { ...defaultImageSettings, ...current.images, ...values },
    }));
    setImagesDirty(true);
    setDirty(true);
  };
  const configured = !!data.settings.model.modelId;
  const tokenLimitsValid =
    withinTokenRange(draft.model.contextWindow, MODEL_TOKEN_LIMITS.contextWindow) &&
    withinTokenRange(draft.model.maxOutputTokens, MODEL_TOKEN_LIMITS.maxOutputTokens) &&
    draft.model.maxOutputTokens < draft.model.contextWindow;
  const tokenLabel = (value: number, current: number) => {
    const count = `${value.toLocaleString('en-US')} ${t('トークン', 'tokens')}`;
    if (Number.isInteger(Math.log2(value))) return `2^${Math.log2(value)} · ${count}`;
    return `${
      value === current
        ? t('カスタム（現在の値）', 'Custom (current value)')
        : t('カスタム（保存済み）', 'Custom (saved value)')
    } · ${count}`;
  };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pickingWorkspace || !draft.workspacePath.trim()) return;
    if (!tokenLimitsValid) {
      toast(
        t(
          '対応範囲内のトークン数を選び、出力上限をコンテキスト上限より小さくしてください。',
          'Choose supported token limits with max output smaller than the context window.',
        ),
        'error',
      );
      return;
    }
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
            ...(draft.model.reasoningMode ? { reasoningMode: draft.model.reasoningMode } : {}),
            ...(draft.model.reasoningEffort
              ? { reasoningEffort: draft.model.reasoningEffort }
              : {}),
            ...(modelKeyDirty ? { apiKey: modelKey } : {}),
          },
          autoLearn: draft.autoLearn,
          maxHandoffs: draft.maxHandoffs,
          ...(inferenceDirty && draft.inference ? { inference: draft.inference } : {}),
          ...(imagesDirty || imageKeyDirty
            ? {
                images: {
                  enabled: images.enabled,
                  baseUrl: images.baseUrl.trim().replace(/\/$/, ''),
                  modelId: images.modelId.trim(),
                  size: images.size.trim(),
                  responseFormat: images.responseFormat,
                  timeoutSeconds: images.timeoutSeconds,
                  shareInferenceSlot: images.shareInferenceSlot,
                  ...(imageKeyDirty ? { apiKey: imageKey } : {}),
                },
              }
            : {}),
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
      setImageKey('');
      setModelKeyDirty(false);
      setSearchKeyDirty(false);
      setImageKeyDirty(false);
      setImagesDirty(false);
      setInferenceDirty(false);
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
          title={t('設定', 'Settings')}
          description={t(
            'モデルの接続先や生成オプションは、作業を停止してから変更してください。同時生成の上限は実行中も調整できます。',
            'Stop active tasks before changing model connections or generation options. You can adjust the concurrency limit while tasks run.',
          )}
        />
        {!configured && (
          <div className="setup-banner">
            <span className="setup-icon">
              <Link2 size={24} />
            </span>
            <div>
              <strong>{t('推論サーバーを接続', 'Connect an inference server')}</strong>
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
                <h2>{t('モデル接続', 'Model connection')}</h2>
                <p>
                  {t(
                    'OpenAI互換APIを持つ推論サーバーに接続します。',
                    'Connect to an inference server with an OpenAI-compatible API.',
                  )}
                </p>
              </div>
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
                <div className="form-grid">
                  <Field label={t('コンテキスト上限', 'Context window')}>
                    <select
                      aria-label={t('コンテキスト上限', 'Context window')}
                      required
                      value={draft.model.contextWindow}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (
                          withinTokenRange(value, MODEL_TOKEN_LIMITS.contextWindow) &&
                          value > draft.model.maxOutputTokens
                        )
                          setModel({ contextWindow: value });
                      }}
                    >
                      {tokenChoices(
                        MODEL_TOKEN_LIMITS.contextWindow,
                        draft.model.contextWindow,
                        data.settings.model.contextWindow,
                      ).map((value) => (
                        <option
                          key={value}
                          value={value}
                          disabled={
                            !withinTokenRange(value, MODEL_TOKEN_LIMITS.contextWindow) ||
                            value <= draft.model.maxOutputTokens
                          }
                        >
                          {tokenLabel(value, draft.model.contextWindow)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('出力トークン上限', 'Max output tokens')}>
                    <select
                      aria-label={t('出力トークン上限', 'Max output tokens')}
                      required
                      value={draft.model.maxOutputTokens}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (
                          withinTokenRange(value, MODEL_TOKEN_LIMITS.maxOutputTokens) &&
                          value < draft.model.contextWindow
                        )
                          setModel({ maxOutputTokens: value });
                      }}
                    >
                      {tokenChoices(
                        MODEL_TOKEN_LIMITS.maxOutputTokens,
                        draft.model.maxOutputTokens,
                        data.settings.model.maxOutputTokens,
                      ).map((value) => (
                        <option
                          key={value}
                          value={value}
                          disabled={
                            !withinTokenRange(value, MODEL_TOKEN_LIMITS.maxOutputTokens) ||
                            value >= draft.model.contextWindow
                          }
                        >
                          {tokenLabel(value, draft.model.maxOutputTokens)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <p className="field-hint">
                  {t(
                    '推論サーバーの上限に合わせてください。出力上限はコンテキスト上限より小さくします。小さいコンテキストを選べない場合は、先に出力上限を下げてください。',
                    'Match your inference server’s limits. Output must be smaller than context. Lower the output limit first to select a smaller context.',
                  )}
                </p>
                <div className="form-grid form-grid-three">
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
                  <Field
                    label={t('思考設定', 'Reasoning mode')}
                    hint={t(
                      'サーバー既定は追加オプションを送りません。OpenAI互換は reasoning_effort に対応したサーバーで使います。',
                      'Server default sends no extra options. Use OpenAI-compatible mode only with servers that support reasoning_effort.',
                    )}
                  >
                    <select
                      aria-label={t('思考設定', 'Reasoning mode')}
                      value={draft.model.reasoningMode ?? 'server'}
                      onChange={(e) =>
                        setModel({ reasoningMode: e.target.value as 'server' | 'openai' })
                      }
                    >
                      <option value="server">{t('サーバー既定', 'Server default')}</option>
                      <option value="openai">{t('OpenAI互換', 'OpenAI-compatible')}</option>
                    </select>
                  </Field>
                  <Field
                    label={t('思考の強さ', 'Reasoning effort')}
                    hint={t(
                      'モデル・サーバーが対応する値を選んでください。Ultraは対応サーバー専用の拡張値です。思考はモデルが返した場合に表示します。',
                      'Choose a value supported by your model and server. Ultra is a server extension, not a universal level. Reasoning appears only when the model returns it.',
                    )}
                  >
                    <select
                      aria-label={t('思考の強さ', 'Reasoning effort')}
                      value={draft.model.reasoningEffort ?? 'medium'}
                      disabled={(draft.model.reasoningMode ?? 'server') !== 'openai'}
                      onChange={(e) =>
                        setModel({ reasoningEffort: e.target.value as ReasoningEffort })
                      }
                    >
                      {REASONING_EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>
                          {t(...reasoningLabels[effort])}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {!tokenLimitsValid && (
                  <p className="form-error" role="alert">
                    {t(
                      'トークン上限を確認してください。出力はコンテキストより小さくする必要があります。',
                      'Check the token limits. Output must be smaller than the context window.',
                    )}
                  </p>
                )}
              </details>
            </div>
          </section>
          <InferenceSettings
            value={
              (inferenceDirty ? draft.inference : data.settings.inference) ?? {
                maxConcurrentRequests: 1,
              }
            }
            onChange={(inference) => {
              update({ inference });
              setInferenceDirty(true);
            }}
          />
          <ImageSettings
            value={{ ...images, apiKeyConfigured: data.settings.images?.apiKeyConfigured ?? false }}
            onChange={setImages}
            apiKey={imageKey}
            keyDirty={imageKeyDirty}
            onKeyChange={(value) => {
              setImageKey(value);
              setImageKeyDirty(true);
              setDirty(true);
            }}
            disabled={hasActiveTasks || saving}
          />
          <section className="settings-section">
            <div className="settings-section-heading">
              <span>
                <ShieldCheck size={20} />
              </span>
              <div>
                <h2>{t('操作の権限', 'Permissions')}</h2>
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
                    <option value="auto">{t('自動判定', 'Smart auto-approve')}</option>
                    <option value="allow">{t('許可', 'Allow')}</option>
                    <option value="deny">{t('拒否', 'Deny')}</option>
                  </select>
                </div>
              ))}
              <p className="field-hint">
                {t(
                  '自動判定は、低リスクの読み取りと新規文書の作成を自動承認します。上書きや任意のコマンドは確認します。',
                  'Smart auto-approve permits low-risk reads and new documents. Overwrites and arbitrary commands still need approval.',
                )}
              </p>
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
                <h2>{t('Web検索', 'Web search')}</h2>
                <p>
                  {t(
                    '検索プロバイダーと接続情報を設定します。',
                    'Choose a search provider and enter its connection details.',
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
                <h2>{t('学習と引き継ぎ', 'Learning and handoffs')}</h2>
                <p>
                  {t(
                    '作業後のスキル提案と、ボット間の依頼回数を設定します。',
                    'Control skill suggestions after tasks and handoffs between bots.',
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
                  'ボット間で作業を渡す合計回数と深さを制限します。',
                  'Limits total handoffs within one originating task, including handoff depth.',
                )}
              >
                <input
                  type="number"
                  className="short-input"
                  required
                  min={0}
                  max={20}
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
                <h2>{t('既定の作業場所', 'Default workspace')}</h2>
                <p>
                  {t(
                    '個別の作業場所を指定していないルームで使用します。',
                    'Used by rooms without their own workspace folder.',
                  )}
                </p>
              </div>
            </div>
            <div className="settings-section-body">
              <WorkspacePicker
                value={draft.workspacePath}
                onChange={(path) => update({ workspacePath: path || '' })}
                onBusyChange={setPickingWorkspace}
                disabled={hasActiveDefaultTasks || saving}
              />
              {hasActiveDefaultTasks && (
                <p className="field-hint">
                  {t(
                    '既定の作業場所を変更するには、この場所を使うルームの作業を停止してください。',
                    'Stop tasks in rooms using the default folder before changing it.',
                  )}
                </p>
              )}
            </div>
          </section>
          <div className={`settings-savebar ${dirty ? 'has-changes' : ''}`}>
            <span>
              {dirty
                ? t('保存していない変更があります', 'You have unsaved changes')
                : t(
                    '設定はLoomサーバーに保存されています',
                    'Settings are saved on the Loom server',
                  )}
            </span>
            <Button
              type="submit"
              variant="primary"
              icon={Save}
              busy={saving}
              disabled={
                !dirty || !tokenLimitsValid || pickingWorkspace || !draft.workspacePath.trim()
              }
            >
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
              <h2>{t('通知', 'Notifications')}</h2>
              <p>
                {t(
                  'このブラウザーでの通知方法を設定します。',
                  'Configure notifications for this browser.',
                )}
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
              <h2>{t('デモ', 'Demo')}</h2>
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
        </div>
      </div>
    </div>
  );
}
