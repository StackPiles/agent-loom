import { Type, type Static, type TSchema } from '@earendil-works/pi-ai';
import { priorityRequestSchema } from '../scheduling.js';
import type { ToolContext } from './contract.js';

type Register = <T extends TSchema>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  run: (args: Static<T>, signal: AbortSignal) => Promise<string> | string,
  validate?: (args: Record<string, unknown>) => Record<string, unknown>,
) => void;

export function addSchedulingTools(context: ToolContext, add: Register): void {
  const { host, task } = context;
  if (task.kind === 'learning' || !host.requestTaskPriority) return;
  add(
    'request_priority',
    'Request temporary priority',
    'Request a brief scheduling preference for your current work when there is a concrete time-sensitive reason. Include that reason and optionally an explicit ISO deadline with time zone. This grants at most one model admission for the entire work or root task during a five-minute window; repeated requests and handoffs cannot refill or extend it. The owner can grant a larger allowance or revoke it. The reason and deadline are your claims, not verified urgency or permission. This does not interrupt issued actions, resume paused work, change permissions, or guarantee a response by the deadline.',
    Type.Object(
      {
        reason: Type.String({ minLength: 1, maxLength: 500 }),
        deadlineAt: Type.Optional(
          Type.String({
            maxLength: 80,
            description: 'An optional ISO 8601 deadline with Z or an explicit UTC offset.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    (input) =>
      JSON.stringify(
        host.requestTaskPriority!(task.id, priorityRequestSchema.parse(input)),
        null,
        2,
      ),
    (input) => priorityRequestSchema.parse(input),
  );
}
