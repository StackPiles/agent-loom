import { useEffect, useState } from 'react';
import { ArrowDownToLine, LoaderCircle, RefreshCw, Square, WandSparkles } from 'lucide-react';
import { Button, Field, Toggle } from './components';
import { dateLabel, useApp } from './context';
import { usePromptGenerations } from './usePromptGenerations';

export function PromptAssistant({
  id,
  name,
  role,
  currentPrompt,
  onApply,
  disabled,
}: {
  id: string;
  name: string;
  role: string;
  currentPrompt: string;
  onApply: (prompt: string) => void;
  disabled: boolean;
}) {
  const { data, locale, t } = useApp();
  const model = data.settings.model;
  const available =
    !data.settings.demoMode && Boolean(model.baseUrl.trim() && model.modelId.trim());
  const [instructions, setInstructions] = useState(role);
  const [improve, setImprove] = useState(Boolean(currentPrompt.trim()));
  const [previewId, setPreviewId] = useState<string>();
  const [draft, setDraft] = useState('');
  const {
    jobs,
    active,
    loading,
    submitting,
    cancelling,
    error,
    uncertain,
    reload,
    generate,
    cancel,
  } = usePromptGenerations();
  const preview = jobs.find((job) => job.id === previewId) ?? active ?? jobs[0];
  const completed = jobs.filter((job) => job.status === 'completed');
  const locked = disabled || Boolean(active) || submitting || uncertain;
  useEffect(() => {
    setDraft(preview?.output ?? '');
  }, [preview?.id, preview?.status]);

  return (
    <section
      id={id}
      className="prompt-assistant"
      aria-label={t('システムプロンプトの生成支援', 'System prompt assistant')}
    >
      <header className="prompt-assistant-header">
        <div>
          <strong>{t('役割から指示を作る', 'Turn a role into instructions')}</strong>
          {available && <span title={model.baseUrl}>{model.modelId}</span>}
        </div>
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => void reload()}
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          {t('更新', 'Refresh')}
        </button>
      </header>
      {!available && (
        <p className="prompt-setup-note" role="status">
          {data.settings.demoMode
            ? t(
                '「設定」でデモモードをオフにし、LLMに接続すると生成できます。',
                'Turn off demo mode and connect a language model in Settings to generate a draft.',
              )
            : t(
                '「設定」でLLMの接続先とモデルIDを設定してください。',
                'Configure the language model API URL and model ID in Settings.',
              )}
        </p>
      )}
      <Field label={t('どんな仕事を任せたいですか？', 'What should this bot do?')}>
        <textarea
          aria-label={t('どんな仕事を任せたいですか？', 'What should this bot do?')}
          rows={3}
          maxLength={6000}
          value={instructions}
          disabled={locked}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={t(
            '例：技術調査を担当。根拠と不確実な点を示し、結論を先に簡潔に報告してほしい。',
            'For example: research technical questions, verify sources, flag uncertainty, and lead with a concise conclusion.',
          )}
        />
      </Field>
      {currentPrompt.trim() && (
        <Toggle
          label={t('現在のプロンプトを基に改善する', 'Improve the current prompt')}
          checked={improve}
          disabled={locked}
          onChange={setImprove}
        />
      )}
      <div className="prompt-assistant-actions">
        <Button
          type="button"
          icon={WandSparkles}
          busy={submitting}
          disabled={disabled || loading || Boolean(active) || !available || !instructions.trim()}
          onClick={async () => {
            const job = await generate({
              name: name.trim(),
              role: role.trim(),
              instructions: instructions.trim(),
              locale,
              ...(improve && currentPrompt.trim() ? { currentPrompt: currentPrompt.trim() } : {}),
            });
            if (job) setPreviewId(job.id);
          }}
        >
          {uncertain
            ? t('同じリクエストを確認', 'Check the same request')
            : t('案を生成', 'Generate draft')}
        </Button>
        {active && (
          <Button
            type="button"
            icon={Square}
            busy={cancelling}
            disabled={disabled}
            onClick={() => void cancel()}
          >
            {t('生成を停止', 'Stop generation')}
          </Button>
        )}
      </div>
      <p className="field-hint prompt-assistant-hint">
        {t(
          '名前・役割・入力した依頼を設定済みのLLMに送信します。閉じても生成は続き、結果をここから開けます。',
          'The configured language model receives the name, role, and instructions. Generation continues after closing; reopen this panel to find the result.',
        )}
      </p>
      {uncertain && (
        <p className="prompt-job-message" role="status">
          {t(
            '受付結果を確認できませんでした。「同じリクエストを確認」で重複せずに状態を取得できます。',
            'The request may have been accepted. Check the same request to retrieve it without starting a duplicate.',
          )}
        </p>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {active && (
        <div className="prompt-generation-status" role="status">
          <LoaderCircle size={16} className="spin" />
          <span>
            {active.status === 'queued'
              ? t(
                  '順番待ち：利用できる推論枠を待っています。',
                  'Queued: waiting for an available generation slot.',
                )
              : t('プロンプトを生成中', 'Generating prompt')}
          </span>
        </div>
      )}
      {completed.length > 0 && (
        <Field label={t('保存済みの案', 'Saved drafts')} className="prompt-history-field">
          <select
            aria-label={t('保存済みの案', 'Saved drafts')}
            value={preview?.id ?? ''}
            disabled={disabled}
            onChange={(event) => setPreviewId(event.target.value)}
          >
            {active && <option value={active.id}>{t('生成中の案', 'Draft in progress')}</option>}
            {preview && preview.status !== 'completed' && preview.id !== active?.id && (
              <option value={preview.id}>{t('今回の生成', 'Current generation')}</option>
            )}
            {completed.map((job) => (
              <option key={job.id} value={job.id}>
                {(job.request.name || job.request.role || t('生成案', 'Draft')) +
                  ' · ' +
                  dateLabel(job.createdAt, locale, true)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {preview && ['failed', 'cancelled', 'interrupted'].includes(preview.status) && (
        <div className="prompt-job-message" role={preview.status === 'failed' ? 'alert' : 'status'}>
          <strong>
            {preview.status === 'cancelled'
              ? t('生成を停止しました。', 'Generation stopped.')
              : preview.status === 'interrupted'
                ? t(
                    '再起動により生成が中断されました。',
                    'Generation was interrupted by a restart.',
                  )
                : t('案を生成できませんでした。', 'The draft could not be generated.')}
          </strong>
          {preview.error && <span>{preview.error}</span>}
        </div>
      )}
      {preview && (preview.output || preview.status === 'completed') && (
        <div className="prompt-result">
          <Field
            label={t('生成したプロンプト案', 'Draft system prompt')}
            hint={
              preview.status === 'completed'
                ? t(
                    '内容を確認し、必要なら編集してから取り込んでください。',
                    'Review and edit the draft before using it.',
                  )
                : preview.status === 'queued' || preview.status === 'generating'
                  ? t(
                      '生成途中の内容です。完了すると編集・取り込みができます。',
                      'This is a partial result. Editing and applying become available after completion.',
                    )
                  : t(
                      '生成は完了していません。依頼を調整して再生成できます。',
                      'This draft is incomplete. Adjust the instructions and generate a new draft.',
                    )
            }
          >
            <textarea
              aria-label={t('生成したプロンプト案', 'Draft system prompt')}
              className="prompt-result-text"
              rows={9}
              maxLength={32000}
              spellCheck={false}
              value={preview.status === 'completed' ? draft : preview.output}
              readOnly={preview.status !== 'completed'}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          {preview.status === 'completed' && (
            <div className="prompt-result-footer">
              <Button
                type="button"
                variant="primary"
                icon={ArrowDownToLine}
                disabled={disabled || !draft.trim() || draft.length > 32000}
                onClick={() => onApply(draft.trim())}
              >
                {t('この案を取り込む', 'Use this draft')}
              </Button>
              <small>
                {t(
                  '取り込んだ後、プロフィールを保存すると反映されます。',
                  'Apply the draft, then save the profile to use it.',
                )}
              </small>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
