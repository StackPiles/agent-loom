import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleHelp, List } from 'lucide-react';
import { api } from './api';
import { Button, Field } from './components';
import { useApp } from './context';

type ModelList = { ok: boolean; models: string[]; message: string };

export function ModelPicker({
  target,
  baseUrl,
  value,
  onChange,
  apiKey,
  keyDirty,
  disabled = false,
}: {
  target: 'model' | 'images';
  baseUrl: string;
  value: string;
  onChange: (value: string) => void;
  apiKey: string;
  keyDirty: boolean;
  disabled?: boolean;
}) {
  const { t } = useApp();
  const image = target === 'images';
  const label = image ? t('画像モデルID', 'Image model ID') : t('モデルID', 'Model ID');
  const listId = image ? 'image-model-ids' : 'model-ids';
  // Changing the chosen ID does not invalidate a list from the same connection.
  const connection = useMemo(
    () => ({ target, baseUrl, apiKey, keyDirty, disabled }),
    [target, baseUrl, apiKey, keyDirty, disabled],
  );
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    connection: typeof connection;
    loading: boolean;
    result: ModelList | null;
  } | null>(null);
  const loading = state?.connection === connection && state.loading;
  const result = state?.connection === connection ? state.result : null;
  const models = result?.ok ? result.models : [];

  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [connection],
  );

  async function loadModels() {
    if (disabled || !baseUrl.trim() || loading) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ connection, loading: true, result: null });
    try {
      const response = await api<ModelList>(
        '/settings/test',
        'POST',
        {
          target,
          baseUrl,
          modelId: value,
          ...(keyDirty ? { apiKey } : {}),
        },
        controller.signal,
      );
      if (request.current !== controller || currentConnection.current !== connection) return;
      setState({ connection, loading: false, result: response });
    } catch (error) {
      if (request.current !== controller || currentConnection.current !== connection) return;
      setState({
        connection,
        loading: false,
        result: { ok: false, models: [], message: (error as Error).message },
      });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  return (
    <div className="model-picker">
      <Field
        label={label}
        hint={t(
          'モデル一覧から選ぶか、サーバー上の正確なIDを入力してください。',
          'Choose from the model list or enter the exact ID on your server.',
        )}
      >
        <input
          aria-label={label}
          required={image}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={image ? t('サーバー上のモデルID', 'Model ID on your server') : 'qwen3.5:9b'}
          list={listId}
          spellCheck={false}
        />
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </Field>
      <Button
        type="button"
        icon={List}
        busy={loading}
        disabled={disabled || !baseUrl.trim()}
        onClick={() => void loadModels()}
      >
        {image
          ? t('画像モデル一覧を取得', 'Load image model list')
          : t('モデル一覧を取得', 'Load model list')}
      </Button>
      <p className="field-hint model-discovery-hint">
        {t(
          '一覧の取得だけを行い、推論は実行しません。',
          'Loads the list without running inference.',
        )}
      </p>
      {models.length > 0 && (
        <Field
          label={
            image
              ? t('画像モデル一覧', 'Available image models')
              : t('モデル一覧', 'Available models')
          }
        >
          <select
            aria-label={
              image
                ? t('画像モデル一覧', 'Available image models')
                : t('モデル一覧', 'Available models')
            }
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="" disabled>
              {t('モデルを選択', 'Choose a model')}
            </option>
            {value && !models.includes(value) && (
              <option value={value}>
                {value} {t('（現在のID・一覧外）', '(current ID, not listed)')}
              </option>
            )}
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </Field>
      )}
      {result && (
        <div
          className={`connection-result ${result.ok ? 'result-success' : 'result-error'}`}
          role="status"
        >
          {result.ok ? <Check size={18} /> : <CircleHelp size={18} />}
          <div>
            <strong>
              {result.ok
                ? models.length
                  ? t(`${models.length}件のモデルを取得しました`, `Loaded ${models.length} models`)
                  : t('モデル一覧が空でした', 'The model list is empty')
                : t('モデル一覧を取得できませんでした', 'Could not load the model list')}
            </strong>
            {models.length ? (
              <p>
                {image
                  ? t(
                      '画像生成・編集に対応するモデルを選んでください。',
                      'Choose a model that supports image generation and editing.',
                    )
                  : t(
                      '会話に対応するモデルを選んでください。画像入力には画像対応モデルが必要です。',
                      'Choose a conversation model. Image input also requires image support.',
                    )}
              </p>
            ) : (
              <>
                {!result.ok && <p>{result.message}</p>}
                <p>
                  {t(
                    'モデルIDを手入力して設定を保存できます。',
                    'You can enter a model ID manually and save the settings.',
                  )}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
