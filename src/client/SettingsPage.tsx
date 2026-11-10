import { useEffect, useRef, useState } from 'react';
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
import { MAX_HANDOFF_LIMIT } from '../shared/handoffs';
import {
  DEFAULT_MODEL_TIMEOUTS,
  IMAGE_STEP_LIMITS,
  MODEL_TIMEOUT_LIMITS,
  modelImageInputEnabled,
  REASONING_EFFORTS,
} from '../shared/model-settings';
import { api } from './api';
import { activeStatuses, useApp } from './context';
import { Button, Field, PageHeader, Toggle } from './components';
import { WorkspacePicker } from './WorkspacePicker';
import { InferenceSettings } from './InferenceSettings';
import { ImageSettings, defaultImageSettings, type ImageSettingsValue } from './ImageSettings';
import { BrowserSettings } from './BrowserSettings';
import { DataTransferSettings } from './DataTransferSettings';
import { UpdateSettings } from './UpdateSettings';
import { DEFAULT_BROWSER_SETTINGS } from '../shared/browser';

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
function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).href.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}
function tokenChoices(range: TokenRange, current: number, saved: number) {
  const values = new Set<number>([current, saved]);
  for (let value = 2 ** Math.ceil(Math.log2(range.min)); value <= range.max; value *= 2)
    values.add(value);
  return [...values].sort((a, b) => a - b);
}

export function SettingsPage() {
  const { data, connected, t, mutate, toast, navigate, signOut } = useApp();
  const [draft, setDraft] = useState<Settings>(() => {
    const initial = structuredClone(data.settings);
    // Keep a legacy opt-in independent of later Chrome source preference edits.
    initial.model.imageInput = modelImageInputEnabled(initial);
    return initial;
  });
  const [handoffMode, setHandoffMode] = useState<'unlimited' | 'limited' | 'disabled'>(() =>
    data.settings.maxHandoffs === null
      ? 'unlimited'
      : data.settings.maxHandoffs === 0
        ? 'disabled'
        : 'limited',
  );
  const [handoffLimitInput, setHandoffLimitInput] = useState(() =>
    String(data.settings.maxHandoffs || 6),
  );
  const [modelKey, setModelKey] = useState('');
  const [modelKeyDirty, setModelKeyDirty] = useState(false);
  const [searchKey, setSearchKey] = useState('');
  const [searchKeyDirty, setSearchKeyDirty] = useState(false);
  const [imageKey, setImageKey] = useState('');
  const [imageKeyDirty, setImageKeyDirty] = useState(false);
  const [imagesDirty, setImagesDirty] = useState(false);
  const [inferenceDirty, setInferenceDirty] = useState(false);
  const [browserDirty, setBrowserDirty] = useState(false);
  const browserRevision = useRef(0);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string; models: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const hasChanges = dirty || browserDirty;
  const [desktop, setDesktop] = useState(
    () => localStorage.getItem('loom.notifications') === 'true',
  );
  const [authRequired, setAuthRequired] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const activeTasks = data.tasks.filter((task) => activeStatuses.includes(task.status));
  const hasActiveTasks = activeTasks.length > 0;
  const pausedTasks = new Set(
    data.queue.waitingTasks?.filter((task) => task.reason === 'paused').map((task) => task.taskId),
  );
  const hasUnpausedTasks = activeTasks.some(
    (task) =>
      !data.rooms.find((room) => room.id === task.roomId)?.paused ||
      (task.status !== 'queued' && !pausedTasks.has(task.id)),
  );
  const imageSettingsLocked = connected === false || hasUnpausedTasks;
  const imageSettingsLockReason =
    connected === false
      ? t(
          '接続が切れているため、作業の休止を確認できません。再接続してから変更してください。',
          'The connection is lost, so paused work cannot be confirmed. Reconnect before changing these options.',
        )
      : hasUnpausedTasks
        ? t(
            'すべてのルームの作業を休止し、現在の処理が終わると変更できます。',
            'Pause work in every room and wait for the current actions to finish before changing these options.',
          )
        : undefined;
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
  const images = { ...defaultImageSettings, ...draft.images };
  const setImages = (values: Partial<ImageSettingsValue>) => {
    setDraft((current) => ({
      ...current,
      images: { ...defaultImageSettings, ...current.images, ...values },
    }));
    setImagesDirty(true);
    setDirty(true);
  };
  const browser = {
    ...DEFAULT_BROWSER_SETTINGS,
    ...(browserDirty ? draft.browser : data.settings.browser),
  };
  const setBrowser = (values: Partial<typeof browser>) => {
    browserRevision.current++;
    setDraft((current) => ({ ...current, browser: { ...browser, ...values } }));
    setBrowserDirty(true);
  };
  const saveBrowser = async (value: typeof browser) => {
    const revision = browserRevision.current;
    await mutate('/settings', 'PUT', { browser: value });
    if (revision === browserRevision.current) setBrowserDirty(false);
  };
  const configured = !!data.settings.model.modelId;
  const imageInputEnabled = modelImageInputEnabled(draft);
  const savedImages = { ...defaultImageSettings, ...data.settings.images };
  const hasImageConfigurationChanges =
    (imageKeyDirty && (imageKey !== '' || savedImages.apiKeyConfigured)) ||
    (imagesDirty &&
      (normalizedBaseUrl(images.baseUrl) !== normalizedBaseUrl(savedImages.baseUrl) ||
        images.modelId.trim() !== savedImages.modelId.trim() ||
        images.size.trim() !== savedImages.size.trim() ||
        (
          [
            'enabled',
            'steps',
            'stepsParameter',
            'responseFormat',
            'timeoutSeconds',
            'shareInferenceSlot',
          ] as const
        ).some((key) => images[key] !== savedImages[key])));
  const hasImageSettingsChanges =
    imageInputEnabled !== modelImageInputEnabled(data.settings) || hasImageConfigurationChanges;
  const imageSettingsSaveBlocked = hasImageSettingsChanges && imageSettingsLocked;
  const imageStepsValid =
    images.steps == null ||
    (Number.isInteger(images.steps) &&
      images.steps >= IMAGE_STEP_LIMITS.min &&
      images.steps <= IMAGE_STEP_LIMITS.max);
  const imageStepsError = t(
    '生成ステップ数は空欄、または1〜1,000の整数で指定してください。',
    'Leave sampling steps blank or enter a whole number from 1 to 1,000.',
  );
  const tokenLimitsValid =
    withinTokenRange(draft.model.contextWindow, MODEL_TOKEN_LIMITS.contextWindow) &&
    withinTokenRange(draft.model.maxOutputTokens, MODEL_TOKEN_LIMITS.maxOutputTokens) &&
    draft.model.maxOutputTokens < draft.model.contextWindow;
  const responseTimeoutSeconds =
    draft.model.responseTimeoutSeconds ?? DEFAULT_MODEL_TIMEOUTS.responseTimeoutSeconds;
  const idleTimeoutSeconds =
    draft.model.idleTimeoutSeconds ?? DEFAULT_MODEL_TIMEOUTS.idleTimeoutSeconds;
  const modelTimeoutsValid = [responseTimeoutSeconds, idleTimeoutSeconds].every(
    (value) =>
      Number.isInteger(value) &&
      value >= MODEL_TIMEOUT_LIMITS.min &&
      value <= MODEL_TIMEOUT_LIMITS.max,
  );
  const modelTimeoutError = t(
    '待機上限は10〜86,400秒の整数で指定してください。',
    'Use whole-number timeouts from 10 to 86,400 seconds.',
  );
  const finiteHandoffLimit = Number(handoffLimitInput);
  const handoffLimitValid =
    handoffMode !== 'limited' ||
    (Number.isInteger(finiteHandoffLimit) &&
      finiteHandoffLimit >= 1 &&
      finiteHandoffLimit <= MAX_HANDOFF_LIMIT);
  const tokenLabel = (value: number, current: number) => {
    const count = `${value.toLocaleString('en-US')} ${t('トークン', 'tokens')}`;
    if (Number.isInteger(Math.log2(value))) {
      const millions = value >= 2 ** 20 ? `${value / 2 ** 20}M · ` : '';
      return `${millions}2^${Math.log2(value)} · ${count}`;
    }
    return `${
      value === current
        ? t('カスタム（現在の値）', 'Custom (current value)')
        : t('カスタム（保存済み）', 'Custom (saved value)')
    } · ${count}`;
  };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || imageSettingsSaveBlocked || pickingWorkspace || !draft.workspacePath.trim())
      return;
    if (!handoffLimitValid) {
      toast(
        t(
          `引き継ぎ上限は1〜${MAX_HANDOFF_LIMIT.toLocaleString()}回の整数で指定してください。`,
          `Choose a whole-number handoff limit from 1 to ${MAX_HANDOFF_LIMIT.toLocaleString()}.`,
        ),
        'error',
      );
      return;
    }
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
    if (!modelTimeoutsValid) {
      toast(modelTimeoutError, 'error');
      return;
    }
    if (!imageStepsValid) {
      toast(imageStepsError, 'error');
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
            ...(draft.model.imageInput !== undefined ? { imageInput: draft.model.imageInput } : {}),
            ...(draft.model.responseTimeoutSeconds !== undefined
              ? { responseTimeoutSeconds: draft.model.responseTimeoutSeconds }
              : {}),
            ...(draft.model.idleTimeoutSeconds !== undefined
              ? { idleTimeoutSeconds: draft.model.idleTimeoutSeconds }
              : {}),
            ...(draft.model.reasoningMode ? { reasoningMode: draft.model.reasoningMode } : {}),
            ...(draft.model.reasoningEffort
              ? { reasoningEffort: draft.model.reasoningEffort }
              : {}),
            ...(modelKeyDirty ? { apiKey: modelKey } : {}),
          },
          autoLearn: draft.autoLearn,
          maxHandoffs:
            handoffMode === 'unlimited'
              ? null
              : handoffMode === 'disabled'
                ? 0
                : finiteHandoffLimit,
          ...(inferenceDirty && draft.inference ? { inference: draft.inference } : {}),
          ...(browserDirty ? { browser } : {}),
          ...(imagesDirty || imageKeyDirty
            ? {
                images: {
                  enabled: images.enabled,
                  permission: images.permission ?? 'inherit',
                  baseUrl: normalizedBaseUrl(images.baseUrl),
                  modelId: images.modelId.trim(),
                  size: images.size.trim(),
                  steps: images.steps ?? null,
                  stepsParameter: images.stepsParameter,
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
      setBrowserDirty(false);
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
            '言語モデルの接続先は、作業を完了または中断してから変更できます。画像入力と画像生成モデルの設定は、すべての作業が休止すると変更できます。同時生成の上限は実行中も調整できます。',
            'Finish or interrupt tasks before changing the language model connection. Image input and image generation settings can change once all work is fully paused. You can adjust the concurrency limit while tasks run.',
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
              <div id="model-image-input">
                <Toggle
                  label={t('画像入力を有効にする', 'Enable image input')}
                  description={t(
                    '画像対応の会話モデルと推論サーバーで有効にしてください。チャットに添付した画像を会話モデルへ送信します。Botは生成済みの画像や作業フォルダー内の画像も選んで確認できます。',
                    'Enable for a conversation model and server that support images. Images attached to chat are sent to the conversation model. Bots can also inspect selected generated or workspace images.',
                  )}
                  checked={imageInputEnabled}
                  onChange={(imageInput) => setModel({ imageInput })}
                  disabled={imageSettingsLocked || saving}
                />
                {imageSettingsLockReason && <p className="field-hint">{imageSettingsLockReason}</p>}
              </div>
              <details className="advanced-settings">
                <summary>
                  {t('推論の詳細設定', 'Inference settings')}
                  <ChevronDown size={15} />
                </summary>
                <div className="form-grid">
                  <Field
                    label={t('コンテキスト上限', 'Context window')}
                    hint={t(
                      '入力・履歴・出力の合計。1M = 1,048,576トークンです。',
                      'Total budget for input, history, and output. 1M = 1,048,576 tokens.',
                    )}
                  >
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
                  <Field
                    label={t('出力トークン上限', 'Max output tokens')}
                    hint={t(
                      '1Mコンテキストでは512Kまで、2Mでは1Mまで選択できます。',
                      'Select up to 512K with a 1M context, or 1M with a 2M context.',
                    )}
                  >
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
                <div className="form-grid">
                  <Field
                    label={t('初回応答の待機上限（秒）', 'First response timeout (seconds)')}
                    hint={t(
                      '送信から最初の出力までの上限です。サーバー内の順番待ちや入力処理を含み、Loom内の順番待ちは含みません。既定は1,800秒（30分）です。',
                      'Time from dispatch until the first output, including the server’s queue and input processing. Waiting in Loom’s queue does not count. Default: 1,800 seconds (30 minutes).',
                    )}
                  >
                    <input
                      type="number"
                      aria-label={t('初回応答の待機上限（秒）', 'First response timeout (seconds)')}
                      min={MODEL_TIMEOUT_LIMITS.min}
                      max={MODEL_TIMEOUT_LIMITS.max}
                      step={1}
                      required
                      value={responseTimeoutSeconds}
                      onChange={(e) => setModel({ responseTimeoutSeconds: Number(e.target.value) })}
                    />
                  </Field>
                  <Field
                    label={t('出力中の無応答時間（秒）', 'Output idle timeout (seconds)')}
                    hint={t(
                      '出力開始後、次の出力まで待つ上限です。回答・思考・ツール呼び出しの出力が届くたびに延長します。既定は300秒（5分）です。',
                      'After output begins, allow this long without further answer, reasoning, or tool-call output. Each output extends the deadline. Default: 300 seconds (5 minutes).',
                    )}
                  >
                    <input
                      type="number"
                      aria-label={t('出力中の無応答時間（秒）', 'Output idle timeout (seconds)')}
                      min={MODEL_TIMEOUT_LIMITS.min}
                      max={MODEL_TIMEOUT_LIMITS.max}
                      step={1}
                      required
                      value={idleTimeoutSeconds}
                      onChange={(e) => setModel({ idleTimeoutSeconds: Number(e.target.value) })}
                    />
                  </Field>
                </div>
                {!modelTimeoutsValid && (
                  <p className="form-error" role="alert">
                    {modelTimeoutError}
                  </p>
                )}
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
            disabled={imageSettingsLocked || saving}
            disabledReason={imageSettingsLockReason}
            permissionDisabled={saving}
          />
          <BrowserSettings
            value={browser}
            onChange={setBrowser}
            onSave={saveBrowser}
            disabled={saving}
            hasActiveTasks={hasActiveTasks}
            imageInputEnabled={imageInputEnabled}
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
                    '作業後の振り返りと、ボット間の依頼回数を設定します。',
                    'Control post-task review and handoffs between bots.',
                  )}
                </p>
              </div>
            </div>
            <div className="settings-section-body">
              <Toggle
                checked={draft.autoLearn}
                onChange={(value) => update({ autoLearn: value })}
                label={t('作業後に記憶とスキルを見直す', 'Review memories and skills after tasks')}
                description={t(
                  '作業の結果から記憶や自分用スキルを保存・改善します。新しい自分用スキルは自動で有効になり、固定・無効化した内容は保護されます。通常の作業中の保存・更新は、この設定がOFFでも利用できます。',
                  'Use completed work to save or improve memories and bot-owned skills. New bot-owned skills activate automatically; fixed and inactive items stay protected. Bots can still save or update during ordinary tasks when this setting is off.',
                )}
              />
              <Field
                label={t('ボット間の引き継ぎ', 'Bot handoffs')}
                hint={t(
                  '既定は上限なしです。必要な場合だけ回数を指定できます。A→Bで1回、B→Aでもう1回。ルームを休止すると、実行中の生成・ツールの完了後、次の処理へ進む前に待機します。',
                  'Unlimited by default; set a limit when needed. A → B counts as one handoff and B → A as another. Pausing a room lets the current generation or tool finish, then waits before the next action.',
                )}
              >
                <select
                  aria-label={t('ボット間の引き継ぎ', 'Bot handoffs')}
                  value={handoffMode}
                  onChange={(event) => {
                    setHandoffMode(event.target.value as typeof handoffMode);
                    setDirty(true);
                  }}
                >
                  <option value="unlimited">{t('上限なし', 'Unlimited')}</option>
                  <option value="limited">{t('上限を指定', 'Set a limit')}</option>
                  <option value="disabled">
                    {t('ボット間連携を無効', 'Disable bot handoffs')}
                  </option>
                </select>
              </Field>
              {handoffMode === 'limited' && (
                <Field
                  label={t('1つの作業の引き継ぎ上限', 'Maximum handoffs per task')}
                  hint={t(
                    '1つの元の依頼から派生する引き継ぎの合計と深さに適用します。上限到達後も、開始済みの作業は続行します。',
                    'Applies to the total and depth of handoffs from one originating task. Tasks already started continue after the limit is reached.',
                  )}
                >
                  <input
                    type="number"
                    className="short-input"
                    aria-label={t('1つの作業の引き継ぎ上限', 'Maximum handoffs per task')}
                    required
                    min={1}
                    max={MAX_HANDOFF_LIMIT}
                    step={1}
                    value={handoffLimitInput}
                    onChange={(event) => {
                      setHandoffLimitInput(event.target.value);
                      setDirty(true);
                    }}
                  />
                </Field>
              )}
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
          <div className={`settings-savebar ${hasChanges ? 'has-changes' : ''}`}>
            <span>
              {hasChanges
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
                !hasChanges ||
                imageSettingsSaveBlocked ||
                !tokenLimitsValid ||
                !modelTimeoutsValid ||
                !imageStepsValid ||
                pickingWorkspace ||
                !draft.workspacePath.trim()
              }
            >
              {t('変更を保存', 'Save changes')}
            </Button>
          </div>
        </form>
        <UpdateSettings hasChanges={hasChanges} />
        <DataTransferSettings hasChanges={hasChanges} />
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
