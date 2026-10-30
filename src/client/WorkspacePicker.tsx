import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RotateCcw } from 'lucide-react';
import type { FolderPickerStatus } from '../shared/types';
import { api } from './api';
import { useApp } from './context';
import { Button } from './components';

export function WorkspacePicker({
  value,
  defaultPath,
  onChange,
  disabled = false,
  onBusyChange,
}: {
  value: string | null;
  defaultPath?: string;
  onChange: (path: string | null) => void;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useApp();
  const [status, setStatus] = useState<FolderPickerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const effective = value || defaultPath || '';
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api<FolderPickerStatus>('/workspace-picker', 'GET', undefined, controller.signal)
      .then((result) => {
        if (mounted.current) setStatus(result);
      })
      .catch(() => {
        if (mounted.current && !controller.signal.aborted)
          setStatus({ available: false, platform: 'unknown', reason: 'unsupported' });
      });
    return () => {
      mounted.current = false;
      controller.abort();
      request.current?.abort();
    };
  }, []);
  async function choose() {
    if (busy || disabled || !status?.available) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    onBusyChange?.(true);
    try {
      const result = await api<{ path: string | null }>(
        '/workspace-picker',
        'POST',
        { initialPath: effective || undefined },
        controller.signal,
      );
      if (mounted.current && !controller.signal.aborted && result.path !== null)
        onChange(result.path);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
      if (request.current === controller) request.current = null;
    }
  }
  const unavailable = status && !status.available;
  const reason =
    status?.reason === 'remote'
      ? t(
          'OSの選択画面は、Loomを実行しているPCでlocalhostから開いた場合に使えます。',
          'The OS picker is available when you open Loom through localhost on the computer running it.',
        )
      : status?.reason === 'headless'
        ? t(
            'Dockerやデスクトップのない環境ではOSの選択画面を開けません。サーバー上のパスを指定してください。',
            'Docker and headless environments cannot open an OS dialog. Specify a folder path on the server.',
          )
        : status?.reason === 'disabled'
          ? t(
              'この環境ではOSのフォルダー選択が無効です。サーバー上のパスを指定してください。',
              'The OS folder picker is disabled here. Specify a folder path on the server.',
            )
          : t(
              'この環境ではOSの選択画面を利用できません。サーバー上のパスを直接指定できます。',
              'The OS picker is unavailable in this environment. You can enter a server folder path manually.',
            );
  return (
    <div className="workspace-picker" aria-busy={busy}>
      <div className="workspace-selection">
        <FolderOpen size={18} aria-hidden="true" />
        <div>
          <output
            className="workspace-path"
            aria-label={t('選択中のフォルダー', 'Selected folder')}
            title={effective}
          >
            {effective || t('フォルダーを選択してください', 'Choose a folder')}
          </output>
          {defaultPath && !value && (
            <span className="workspace-default-label">
              {t('既定の場所を使用', 'Using the default folder')}
            </span>
          )}
        </div>
      </div>
      <div className="workspace-picker-actions">
        <Button
          type="button"
          icon={FolderOpen}
          onClick={() => void choose()}
          disabled={disabled || !status?.available}
          busy={busy}
        >
          {busy
            ? t('フォルダーを選択中…', 'Choosing a folder…')
            : t('フォルダーを選択', 'Choose folder')}
        </Button>
        {defaultPath && value && (
          <Button
            type="button"
            variant="ghost"
            icon={RotateCcw}
            disabled={disabled || busy}
            onClick={() => {
              setError('');
              onChange(null);
            }}
          >
            {t('既定の場所に戻す', 'Use default folder')}
          </Button>
        )}
      </div>
      {busy && (
        <p className="field-hint" role="status">
          {t('OSのフォルダー選択画面で場所を選んでください。', 'Select a folder in the OS dialog.')}
        </p>
      )}
      {unavailable && <p className="field-hint workspace-picker-unavailable">{reason}</p>}
      {error && (
        <p className="workspace-picker-error" role="alert">
          {error}
        </p>
      )}
      <details
        className="workspace-manual"
        open={manual}
        onToggle={(event) => setManual(event.currentTarget.open)}
      >
        <summary>{t('パスを直接指定', 'Enter server path manually')}</summary>
        <label>
          <span className="field-label">
            {t('サーバー上のフォルダーパス', 'Folder path on the server')}
          </span>
          <input
            aria-label={t('サーバー上のフォルダーパス', 'Folder path on the server')}
            value={value || ''}
            placeholder={defaultPath}
            disabled={disabled || busy}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) =>
              onChange(defaultPath && !event.target.value ? null : event.target.value)
            }
          />
        </label>
      </details>
    </div>
  );
}
