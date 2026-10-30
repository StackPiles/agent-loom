import { Layers3 } from 'lucide-react';
import type { Settings } from '../shared/types';
import { useApp } from './context';
import { Field } from './components';

export function InferenceSettings({
  value,
  onChange,
}: {
  value: NonNullable<Settings['inference']>;
  onChange: (value: NonNullable<Settings['inference']>) => void;
}) {
  const { data, t } = useApp();
  return (
    <section className="settings-section" id="inference-settings">
      <div className="settings-section-heading">
        <span>
          <Layers3 size={20} />
        </span>
        <div>
          <h2>{t('生成の同時実行', 'Concurrent generation')}</h2>
          <p>
            {t(
              '推論サーバーの処理能力に合わせて調整します。',
              'Match the capacity of your inference server.',
            )}
          </p>
        </div>
      </div>
      <div className="settings-section-body">
        <div className="inference-settings-grid">
          <Field
            label={t('同時生成の上限', 'Maximum concurrent generations')}
            hint={t(
              '初期値は1です。サーバーが複数のリクエストを処理できる場合に増やしてください。',
              'The default is 1. Increase this when the server can handle concurrent requests.',
            )}
          >
            <select
              aria-label={t('同時生成の上限', 'Maximum concurrent generations')}
              value={value.maxConcurrentRequests}
              onChange={(event) => onChange({ maxConcurrentRequests: Number(event.target.value) })}
            >
              {Array.from({ length: 16 }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count === 1 ? t('1 — 順番に生成', '1 — One at a time') : String(count)}
                </option>
              ))}
            </select>
          </Field>
          <div
            className="inference-live-summary"
            aria-label={t('現在の生成状況', 'Current generation activity')}
          >
            <span>{t('生成中', 'Generating')}</span>
            <strong>
              {data.queue.active}
              <small>
                {' '}
                / {data.queue.capacity ?? data.settings.inference?.maxConcurrentRequests ?? 1}
              </small>
            </strong>
            <span>{t(`${data.queue.waiting}件が待機中`, `${data.queue.waiting} waiting`)}</span>
          </div>
        </div>
        <p className="field-hint">
          {t(
            '同じルーム内で同時に生成するかは、ルームごとに選べます。バッチ処理やGPUへの割り当ては推論サーバーが行います。',
            'Each room can allow simultaneous responses separately. Batching and GPU scheduling are handled by the inference server.',
          )}
        </p>
        <p className="field-hint">
          {t(
            '上限は実行中でも変更できます。減らした場合、生成中の応答が終わってから新しい上限を適用します。',
            'You can change the limit during work. Lowering it lets active responses finish before admitting more work.',
          )}
        </p>
      </div>
    </section>
  );
}
