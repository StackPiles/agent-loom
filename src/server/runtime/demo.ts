import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolContext } from './contract.js';
import { InferenceGate, throwIfAborted } from './gate.js';
import { safeError, type ToolRegistry } from './tools.js';

/** No fabricated inference, search, email access, or verification in this mode. */
export async function runDemo(
  context: ToolContext,
  tools: ToolRegistry,
  gate: InferenceGate,
  append: (delta: string) => void,
): Promise<string> {
  const { host, task, settings, signal } = context;
  const snapshot = host.getSnapshot();
  const bot = snapshot.bots.find((candidate) => candidate.id === task.botId)!;
  const japanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(task.prompt);
  let output = '';
  const say = async (value: string): Promise<void> => {
    host.updateTask(task.id, { status: 'waiting_model' });
    const release = await gate.acquire(signal, task.kind === 'learning');
    try {
      host.updateTask(task.id, { status: 'running' });
      for (let index = 0; index < value.length; index += 32) {
        throwIfAborted(signal);
        const delta = value.slice(index, index + 32);
        output += delta;
        append(delta);
        await delay(24, undefined, { signal });
      }
    } finally {
      release();
    }
  };
  if (task.kind === 'learning') {
    await say(
      japanese
        ? 'デモの学習レビューです。実際のモデル推論は行っていません。'
        : 'Demo review: no model inference ran. No automatic claims of learning or verification were made.',
    );
    return output;
  }
  await say(
    japanese
      ? `**デモモード · LLM の推論は行っていません**\n\n${bot.name} です。実際の操作履歴、承認、順番に進むボット連携をチャット内で確認できます。デモの思考テキストは作りません。\n\n`
      : `**Demo mode · no model inference**\n\nI’m ${bot.name}. This guided response exercises real progress, approvals, and the serial bot queue inside chat. The demo does not invent reasoning text.\n\n`,
  );
  await tools.invoke('room_context', { limit: 8 });
  if (task.depth > 0) {
    await say(
      japanese
        ? '引き継ぎを受け取り、このルームの会話を確認しました。別のボットが承認を待っていても、このボットは順番に応答できます。これは固定のデモ応答で、依頼内容の調査やモデルによるレビューは実行していません。\n\nルームの短い @ハンドルで必要な相手だけに依頼し、終了後は相互の「了解」ループを作りません。'
        : 'I received the directed handoff and read this room’s recent conversation. A teammate can respond while another bot waits for approval. This is a deterministic demonstration, not model-generated analysis of the request.\n\nThe handoff ends here, without an acknowledgement loop. In connected mode, each bot uses its own persistent session and only one inference runs at a time.',
    );
    return output;
  }

  const fullDemo = /\bdemo\b|デモ|体験/i.test(task.prompt);
  const wantsHandoff =
    fullDemo ||
    /team|collaborat|handoff|multi.?agent|チーム|連携|相談|分担|引き継|複数/i.test(task.prompt);
  const wantsFile =
    fullDemo ||
    /write|file|approval|approve|permission|notes|保存|ファイル|書|承認/i.test(task.prompt);
  const wantsNotice =
    fullDemo ||
    task.kind === 'automation' ||
    /notify|notification|alert|通知|お知らせ/i.test(task.prompt);
  const wantsSkill =
    fullDemo || /learn|skill|memory|remember|学習|成長|スキル|覚/i.test(task.prompt);
  let didSomething = false;

  if (wantsHandoff) {
    const room = snapshot.rooms.find((candidate) => candidate.id === task.roomId)!;
    const teammate = snapshot.bots.find(
      (candidate) =>
        candidate.id !== task.botId && candidate.enabled && room.botIds.includes(candidate.id),
    );
    if (teammate && settings.maxHandoffs > 0) {
      try {
        await tools.invoke('send_message', {
          handle: teammate.handle,
          message: japanese
            ? 'このデモの引き継ぎを受け取り、ルームの会話を確認して短く返信してください。デモであることを明示し、追加の引き継ぎは行わないでください。'
            : 'Please acknowledge this demo handoff with a short review of the room context. Clearly label this as a demo and do not hand work to another bot.',
        });
        await say(
          japanese
            ? `@${teammate.handle} に具体的な依頼を送りました。返信はこのルームに届きます。\n\n`
            : `I queued a focused request for @${teammate.handle}. Their reply will appear in this room.\n\n`,
        );
        didSomething = true;
      } catch (error) {
        await say(`${safeError(context, error)}\n\n`);
      }
    } else
      await say(
        japanese
          ? '連携を試すには、ルームに有効なボットをもう 1 体追加し、引き継ぎ上限を 1 以上にしてください。\n\n'
          : 'Add another enabled bot to this room and set a handoff budget above zero to try collaboration.\n\n',
      );
  }

  if (wantsFile) {
    const name = `demo/loom-${createHash('sha256').update(task.id).digest('hex').slice(0, 8)}.md`;
    const content = `# Agent Loom demo\n\nThis file was created by the labelled deterministic demo, after the configured file-write permission check. No LLM, email monitoring, web search, or model verification was performed.\n\nTask: ${task.id}\nBot: ${bot.name}\n\n## Workflow\n1. Read the room context.\n2. Inspect the exact file path and proposed content.\n3. Approve or deny the write.\n4. Inspect the activity timeline and result.\n`;
    await say(
      japanese
        ? `ワークスペースの「${name}」にデモ用メモを保存する承認を求めます。カードで内容を確認できます。\n\n`
        : `I’m requesting permission to create '${name}' in your workspace. The approval card shows the exact content and destination.\n\n`,
    );
    try {
      const result = await tools.invoke('write_file', { path: name, content });
      await say(japanese ? `保存結果: ${result}\n\n` : `File result: ${result}\n\n`);
      didSomething = true;
    } catch (error) {
      await say(
        japanese
          ? `ファイル操作は完了しませんでした。${safeError(context, error)}\n\n`
          : `The file action did not complete: ${safeError(context, error)}\n\n`,
      );
    }
  }

  if (wantsNotice) {
    await tools.invoke('notify_user', {
      title: japanese
        ? 'デモ: ワークフローを確認できます'
        : 'Demo: your workflow is ready to inspect',
      body: japanese
        ? 'これはアプリ内通知の動作確認です。実際のメール検知や外部サービスへの送信は行っていません。'
        : 'This is a real in-app notification from the labelled demo. No email detection or external message delivery occurred.',
    });
    await say(
      japanese
        ? 'アプリ内通知を作成しました。通知からこのルームへ戻れます。\n\n'
        : 'I created an in-app notification linked to this room.\n\n',
    );
    didSomething = true;
  }

  if (wantsSkill) {
    await tools.invoke('propose_skill', {
      name: japanese ? '承認内容を確認するデモ手順' : 'Inspect an approval before acting (demo)',
      description: japanese
        ? '操作の目的、対象、内容、結果を確認する手順。デモから作成された候補です。'
        : 'An example candidate for reviewing the purpose, destination, content, and result of a proposed action.',
      content:
        '# Approval review workflow (demo candidate)\n\n1. Explain the purpose of the proposed operation.\n2. Show its exact target and arguments.\n3. Respect the user’s approval decision.\n4. Record the actual result in the activity timeline.\n5. Do not repeat a completed side effect when resuming a task.\n\nThis is a deterministic demonstration candidate. It is not evidence of model learning or independently tested instructions. Review and edit before activation.\n',
      evidence: `Created by the explicit deterministic demo for task ${task.id}. The user can inspect its recorded tool activities. No LLM review or automated tests were performed.`,
    });
    await say(
      japanese
        ? 'スキル候補を 1 件作成しました。スキル画面で確認して有効化するまで、ボットには適用されません。\n\n'
        : 'I proposed one clearly labelled skill candidate. Review and activate it in Skills before a bot can use it.\n\n',
    );
    didSomething = true;
  }

  await say(
    japanese
      ? `${didSomething ? '各操作の詳細と結果はアクティビティで確認できます。' : '「デモを実行して」と送ると、ボット連携、実際のファイル承認、通知、スキル候補をまとめて試せます。'}\n\n実際の依頼を処理するには、設定で推論サーバーの URL とモデル ID を登録し、デモモードをオフにしてください。Web 検索には SearXNG または Brave の設定が必要です。`
      : `${didSomething ? 'Inspect Activity for each operation’s arguments and actual outcome.' : 'Send “Run the demo” to try a directed handoff, a real file approval, an in-app notification, and a skill candidate.'}\n\nTo perform your actual request, configure your inference server URL and model ID in Settings, then turn off demo mode. Web search uses a configured SearXNG or Brave provider.`,
  );
  return output;
}
