import { useId, useRef, type ReactNode } from 'react';
import { useApp } from './context';
import { AutonomousWorkSection } from './AutonomousWork';
import { needsWorkAttention, useViewPreference } from './WorkSummary';

type AutomationTab = 'rules' | 'work';

export function AutomationWorkspace({ children }: { children: ReactNode }) {
  const { data, t } = useApp();
  const storageKey = `loom:automation-tab:${data.settings.workspacePath}`;
  const [preference, setPreference] = useViewPreference(storageKey, 'rules');
  const tab: AutomationTab = preference === 'work' ? 'work' : 'rules';
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const current = (data.workItems || []).filter(
    (work) => work.status !== 'completed' && work.status !== 'cancelled',
  );
  const attention = current.filter((work) => needsWorkAttention(work, data.tasks)).length;
  const tabs = ['rules', 'work'] as const;
  return (
    <div className="automation-workspace">
      <div
        role="tablist"
        aria-label={t('自動化の表示', 'Automation views')}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 20,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {tabs.map((value, index) => (
          <button
            key={value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${value}`}
            aria-controls={`${id}-panel-${value}`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setPreference(value)}
            onKeyDown={(event) => {
              const target =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : undefined;
              if (target === undefined) return;
              event.preventDefault();
              setPreference(tabs[target]);
              buttons.current[target]?.focus();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 7,
              padding: '10px 12px',
              borderBottom: `2px solid ${tab === value ? 'var(--sage-dark)' : 'transparent'}`,
              fontWeight: tab === value ? 700 : 400,
              fontSize: 13,
              color: tab === value ? 'var(--ink)' : 'var(--sage-dark)',
            }}
          >
            {value === 'rules' ? t('実行ルール', 'Execution rules') : t('継続中の仕事', 'Ongoing work')}
            {value === 'work' && <span className="subtle-tag">{current.length}</span>}
            {value === 'work' && attention > 0 && (
              <span
                className="work-attention-badge"
                style={{
                  background: 'var(--amber-soft)',
                  color: 'var(--amber)',
                  padding: '3px 7px',
                  borderRadius: 12,
                  fontSize: 11,
                }}
              >
                {t(`要対応 ${attention}件`, `${attention} need attention`)}
              </span>
            )}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`${id}-panel-rules`}
        aria-labelledby={`${id}-tab-rules`}
        hidden={tab !== 'rules'}
        tabIndex={0}
      >
        {children}
      </section>
      <section
        role="tabpanel"
        id={`${id}-panel-work`}
        aria-labelledby={`${id}-tab-work`}
        hidden={tab !== 'work'}
        tabIndex={0}
      >
        <AutonomousWorkSection />
      </section>
    </div>
  );
}
