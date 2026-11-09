import type { AutonomousWakeupPolicy } from '../shared/work';
import { useApp } from './context';
import { Field } from './components';

export function AutonomousWakeSettings({
  value,
  onChange,
  disabled = false,
}: {
  value: AutonomousWakeupPolicy;
  onChange: (policy: AutonomousWakeupPolicy) => void;
  disabled?: boolean;
}) {
  const { t } = useApp();
  return (
    <fieldset className="autonomous-wake-settings" disabled={disabled}>
      <legend>{t('ボットの自律予約', 'Autonomous wake-ups')}</legend>
      <Field label={t('予約を任せる範囲', 'Who bots may schedule')}>
        <select
          value={value.mode}
          onChange={(event) =>
            onChange({ ...value, mode: event.target.value as AutonomousWakeupPolicy['mode'] })
          }
        >
          <option value="off">{t('無効', 'Off')}</option>
          <option value="self">{t('自分自身の起床', 'Their own wake-ups')}</option>
          <option value="room">
            {t('自分自身と、このルームの参加ボット', 'Their own and room teammates’ wake-ups')}
          </option>
        </select>
      </Field>
      <p className="field-hint">
        {value.mode === 'off'
          ? t(
              'ボットによる自律予約を無効にします。通常の自動化は「自動化」画面で管理できます。',
              'Autonomous scheduling is off. Manage ordinary automation rules in Automations.',
            )
          : t(
              'このルームの目的や任せた役割について、ボットが承認待ちなしで次の起床を予約できます。実行時のツール権限は引き続き適用されます。',
              'Bots may schedule the next steps of this room’s purpose or assigned roles without a separate approval. Tool permissions still apply when they run.',
            )}
      </p>
      {value.mode !== 'off' && (
        <details className="autonomous-wake-limits">
          <summary>{t('実行頻度と予約数', 'Frequency and reservation limits')}</summary>
          <div className="autonomous-wake-limit-grid">
            <Field label={t('最短の起床間隔（分）', 'Minimum interval (minutes)')}>
              <input
                type="number"
                required
                min={1}
                max={1440}
                step={1}
                value={value.minIntervalMinutes}
                onChange={(event) =>
                  onChange({ ...value, minIntervalMinutes: Number(event.target.value) })
                }
              />
            </Field>
            <Field label={t('未実行の予約数の上限', 'Maximum pending wake-ups')}>
              <input
                type="number"
                required
                min={1}
                max={200}
                step={1}
                value={value.maxPendingWakeups}
                onChange={(event) =>
                  onChange({ ...value, maxPendingWakeups: Number(event.target.value) })
                }
              />
            </Field>
            <Field label={t('1時間あたりの仕事の実行上限', 'Maximum task starts per hour')}>
              <input
                type="number"
                required
                min={1}
                max={240}
                step={1}
                value={value.maxRunsPerHour}
                onChange={(event) =>
                  onChange({ ...value, maxRunsPerHour: Number(event.target.value) })
                }
              />
            </Field>
          </div>
          <p className="field-hint">
            {t(
              'このルーム全体の上限で、仕事に紐づくボットへの引き継ぎも実行数に含みます。待機中は推論を行いません。手動の会話が優先され、起床時刻から実際の開始まで待つ場合があります。',
              'These limits apply to the whole room; work-linked handoffs also count as task starts. Waiting uses no inference. Manual conversations take priority, so work may begin after its scheduled time.',
            )}
          </p>
        </details>
      )}
    </fieldset>
  );
}
