import { useState } from 'react';
import { Check, ChevronDown, ShieldCheck, X } from 'lucide-react';
import type { Approval } from '../shared/types';
import { useApp } from './context';
import { Avatar, Button } from './components';

export function ApprovalCard({ approval }: { approval: Approval }) {
  const { data, t, mutate } = useApp();
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const bot = data.bots.find((item) => item.id === approval.botId);
  async function decide(decision: 'approve' | 'deny') {
    setBusy(decision);
    try {
      await mutate(
        `/approvals/${approval.id}`,
        'POST',
        { decision },
        decision === 'approve'
          ? t('この操作を許可しました', 'This action was approved')
          : t('この操作を拒否しました', 'This action was denied'),
      );
    } catch {
    } finally {
      setBusy(null);
    }
  }
  return (
    <article className="approval-card">
      <div className="approval-card-header">
        <span className="approval-icon">
          <ShieldCheck size={19} />
        </span>
        <div>
          <span className="eyebrow">{t('あなたの確認が必要です', 'YOUR APPROVAL IS NEEDED')}</span>
          <h3>{approval.summary}</h3>
        </div>
      </div>
      <div className="approval-meta">
        <Avatar bot={bot} size="small" />
        <span>{bot?.name}</span>
        <code>{approval.toolName}</code>
      </div>
      <dl>
        <dt>{t('対象', 'Target')}</dt>
        <dd>{approval.target || t('下記の引数を参照', 'See arguments below')}</dd>
      </dl>
      <details className="approval-arguments" open>
        <summary>
          {t('実行する操作の詳細', 'Exact action details')}
          <ChevronDown size={14} />
        </summary>
        <pre>{JSON.stringify(approval.args, null, 2)}</pre>
      </details>
      <footer>
        <span>
          {t('許可はこの操作にのみ適用されます。', 'Approval applies to this action only.')}
        </span>
        <div>
          <Button
            icon={X}
            disabled={!!busy}
            busy={busy === 'deny'}
            onClick={() => void decide('deny')}
          >
            {t('拒否する', 'Deny')}
          </Button>
          <Button
            icon={Check}
            variant="primary"
            disabled={!!busy}
            busy={busy === 'approve'}
            onClick={() => void decide('approve')}
          >
            {t('許可する', 'Approve')}
          </Button>
        </div>
      </footer>
    </article>
  );
}
