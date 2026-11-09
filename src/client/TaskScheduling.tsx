import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowUp, Clock3, X } from 'lucide-react';
import {
  OWNER_PRIORITY_REQUESTS,
  type SchedulingGrant,
  type TaskSchedulingInfo,
} from '../shared/scheduling';
import type { Snapshot, Task } from '../shared/types';
import { activeStatuses, dateLabel, useApp, type Locale } from './context';
import { Button } from './components';

const pendingGroups = new Set<string>();
const pendingListeners = new Set<() => void>();
const subscribePending = (listener: () => void) => {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
};
const changedPending = () => pendingListeners.forEach((listener) => listener());

export function taskSchedulingInfo(task: Task, data: Snapshot): TaskSchedulingInfo | undefined {
  return data.queue.scheduling?.find((item) => item.taskId === task.id);
}

export function taskSchedulingGroup(task: Task): string {
  return task.workId || task.rootTaskId || task.id;
}

/** Queue records include the effective grant shared by the whole work. */
export function taskSchedulingGrant(task: Task, data: Snapshot): SchedulingGrant | undefined {
  const effective = taskSchedulingInfo(task, data);
  if (effective) return effective.grant;
  const groupId = taskSchedulingGroup(task);
  const grants = data.tasks
    .filter((item) => item.roomId === task.roomId && taskSchedulingGroup(item) === groupId)
    .flatMap((item) =>
      item.scheduling?.grant && !item.scheduling.grantRedirect ? [item.scheduling.grant] : [],
    );
  // A legacy snapshot cannot resolve merged aliases; leave that decision to the server.
  return new Set(grants.map((grant) => grant.id)).size === 1 ? grants[0] : undefined;
}

export function taskQueueDetail(task: Task, data: Snapshot, locale: Locale): string | undefined {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const waiting = data.queue.waitingTasks?.find((item) => item.taskId === task.id);
  const info = taskSchedulingInfo(task, data);
  const blocker = info?.blockingTaskId
    ? data.tasks.find((item) => item.id === info.blockingTaskId)
    : undefined;
  const blockerInfo = blocker && taskSchedulingInfo(blocker, data);
  const blockerName = blocker && data.bots.find((item) => item.id === blocker.botId)?.name;
  // The existing presentation distinguishes an unstarted task from a saved continuation.
  if (waiting?.reason === 'paused') return;
  // Lending a worker while approval is pending does not change what the owner needs to do.
  if (
    task.status === 'awaiting_approval' ||
    data.approvals.some((item) => item.taskId === task.id && item.status === 'pending')
  )
    return;
  if (waiting?.reason === 'session')
    return t(
      'このボットの前の作業が終わるのを待っています。先行指定だけでは会話を切り替えません。',
      'Waiting for this bot’s previous task in the room. A priority request does not switch its conversation.',
    );
  if (waiting?.reason === 'room')
    return blockerName && blockerInfo?.purpose === 'compaction'
      ? t(
          `このルームで${blockerName}が会話を要約しています。`,
          `${blockerName} is summarizing a conversation in this room.`,
        )
      : t(
          'このルームの別の生成が終わるのを待っています。',
          'Waiting for another response in this room to finish generating.',
        );
  if (waiting?.reason === 'worker')
    return t('実行の順番を待っています。', 'Waiting for a turn to run.');
  if (waiting?.reason === 'inference') {
    if (blockerName && blockerInfo?.purpose === 'compaction')
      return t(
        `生成枠待ち · ${blockerName}が会話を要約中です。`,
        `Waiting for generation capacity · ${blockerName} is summarizing a conversation.`,
      );
    return info?.purpose === 'compaction'
      ? t(
          '会話の要約を始める順番を待っています。',
          'Waiting for a turn to summarize the conversation.',
        )
      : t('生成枠が空くのを待っています。', 'Waiting for an available generation slot.');
  }
  if (info?.purpose === 'compaction' && task.status === 'running')
    return t('会話を要約しています。', 'Summarizing the conversation.');
  return undefined;
}

function useGrantTime(grant?: SchedulingGrant) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!grant) return;
    const remaining = Date.parse(grant.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [grant?.id, grant?.expiresAt]);
  return now;
}

export function TaskScheduling({ task }: { task: Task }) {
  const { data, connected, locale, t, mutate } = useApp();
  const info = taskSchedulingInfo(task, data);
  const grant = taskSchedulingGrant(task, data);
  const now = useGrantTime(grant);
  const groupId = `${task.roomId}\0${info?.groupId || taskSchedulingGroup(task)}`;
  const busy = useSyncExternalStore(
    subscribePending,
    () => pendingGroups.has(groupId),
    () => false,
  );
  const room = data.rooms.find((item) => item.id === task.roomId);
  const bot = data.bots.find((item) => item.id === task.botId);
  const work = task.workId ? data.workItems?.find((item) => item.id === task.workId) : undefined;
  const active = activeStatuses.includes(task.status);
  const windowOpen = !!grant && Date.parse(grant.expiresAt) > now;
  const grantUnavailable = info?.grantUnavailable === true;
  const consumedRequests = grant
    ? Math.max(grant.consumedRequests ?? 0, grant.grantedRequests - grant.remainingRequests)
    : 0;
  const prioritized =
    windowOpen && !grantUnavailable && !grant.revokedAt && grant.remainingRequests > 0;
  const canUpgrade =
    windowOpen &&
    !grantUnavailable &&
    !grant.revokedAt &&
    grant.source === 'bot' &&
    consumedRequests < OWNER_PRIORITY_REQUESTS;
  const canRequest = !windowOpen || canUpgrade;
  const available =
    active &&
    connected !== false &&
    !!room &&
    !room.paused &&
    !room.archived &&
    !!bot?.enabled &&
    room.botIds.includes(task.botId) &&
    (!task.workId || work?.status === 'active');
  const unavailable =
    connected === false
      ? t('再接続後に操作できます。', 'Reconnect before changing priority.')
      : room?.paused
        ? t('ルームの再開後に指定できます。', 'Resume the room before requesting priority.')
        : task.workId && work?.status !== 'active'
          ? t(
              '仕事を確認して再開してから指定できます。',
              'Review and resume the work before requesting priority.',
            )
          : t('この作業には先行指定を行えません。', 'Priority is unavailable for this task.');
  const guidance = t(
    '同じ仕事で最大3回の生成を、5分以内に先に進めます。実行中の処理には割り込みません。',
    'Prioritize up to 3 model requests in this work within 5 minutes. Already running actions are not interrupted.',
  );

  async function changePriority(method: 'POST' | 'DELETE') {
    if (!available || pendingGroups.has(groupId) || (method === 'POST' && !canRequest)) return;
    pendingGroups.add(groupId);
    changedPending();
    try {
      await mutate(`/tasks/${task.id}/priority`, method, method === 'POST' ? {} : undefined);
    } catch {
      // The shared mutation handler reports the error; a failed request remains retryable.
    } finally {
      pendingGroups.delete(groupId);
      changedPending();
    }
  }

  if (!active) return null;
  const dispatchReason = info?.lastDispatchReason;
  const dispatchLabel =
    dispatchReason === 'owner'
      ? t('ユーザーの先行指定', 'Your priority request')
      : dispatchReason === 'bot'
        ? t('ボットの先行依頼', 'The bot’s priority request')
        : dispatchReason === 'waiting'
          ? t('長く待っていた作業への配分', 'A turn for work that had waited longer')
          : dispatchReason === 'fair'
            ? t('ほかの仕事との公平な配分', 'A fair turn among the waiting work')
            : undefined;

  return (
    <div className="task-scheduling" data-task-scheduling={task.id}>
      {dispatchLabel && (
        <p className="task-scheduling-decision" data-dispatch-reason={dispatchReason}>
          <span>{t('直前の生成', 'Last generation')}</span>
          {dispatchLabel}
        </p>
      )}
      {windowOpen && (
        <div className={`task-priority-note${prioritized ? ' is-prioritized' : ''}`} role="status">
          <Clock3 size={13} aria-hidden="true" />
          <span>
            {grantUnavailable
              ? t('先行指定は現在利用できません', 'This priority allowance is unavailable')
              : grant.revokedAt
                ? t('優先は解除済み', 'Priority cancelled')
                : grant.remainingRequests === 0
                  ? t('今回の先行枠は使用済み', 'This priority allowance has been used')
                  : grant.source === 'owner'
                    ? t(
                        `先行指定 · 残り${grant.remainingRequests}回`,
                        `Your priority request · ${grant.remainingRequests} remaining`,
                      )
                    : t(
                        `ボットの先行依頼 · 残り${grant.remainingRequests}回`,
                        `Bot priority request · ${grant.remainingRequests} remaining`,
                      )}
            {' · '}
            {t(
              `${dateLabel(grant.expiresAt, locale)}まで`,
              `until ${dateLabel(grant.expiresAt, locale)}`,
            )}
          </span>
          {grant.reason && <span className="task-priority-reason">{grant.reason}</span>}
        </div>
      )}
      <div className="task-priority-actions">
        <Button
          type="button"
          variant="ghost"
          icon={ArrowUp}
          data-priority-action="request"
          busy={busy}
          disabled={!available || !canRequest}
          title={
            !available
              ? unavailable
              : !canRequest
                ? grantUnavailable
                  ? t(
                      'この先行指定は利用できません。期限後に再度指定できます。',
                      'This allowance is unavailable. Request another after it expires.',
                    )
                  : t(
                      '同じ先行期間の回数は追加できません。期限後に再度指定できます。',
                      'This allowance cannot be refilled. Request another after it expires.',
                    )
                : canUpgrade
                  ? t(
                      'ボットが使用した回数を含めて最大3回にします。期限は延長しません。',
                      'Raise the allowance to 3 in total, including requests already used. The expiry is unchanged.',
                    )
                  : guidance
          }
          onClick={() => void changePriority('POST')}
        >
          {t('先に実行', 'Prioritize')}
        </Button>
        {prioritized && (
          <Button
            type="button"
            variant="ghost"
            icon={X}
            data-priority-action="revoke"
            disabled={!available || busy}
            title={t(
              '先行指定だけを解除します。作業は停止しません。',
              'Remove priority without stopping the task.',
            )}
            onClick={() => void changePriority('DELETE')}
          >
            {t('優先を解除', 'Remove priority')}
          </Button>
        )}
        <span className="task-priority-guidance">
          {windowOpen
            ? t(
                '同じ仕事の要約や引き継ぎも、この回数を共有します。',
                'Summaries and delegated tasks share this work’s allowance.',
              )
            : t('最大3回・5分間の先行指定', 'Up to 3 requests within 5 minutes')}
        </span>
      </div>
    </div>
  );
}
