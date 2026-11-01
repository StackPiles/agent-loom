import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  FilePenLine,
  Inbox,
  LoaderCircle,
  Mail,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
} from 'lucide-react';
import type {
  MailAccount,
  MailDraft,
  MailDraftInput,
  MailMessage,
  MailMessageSummary,
} from '../shared/mail-accounts';
import { ApiError, mailApi } from './api';
import { dateLabel, useApp } from './context';
import { Button, EmptyState, Field, Modal } from './components';
import { mailAddresses, mailErrorText, newMailRequestId, providerName } from './mail-ui';

type Composer = { draft?: MailDraft; reply?: MailMessage };
type MailTab = 'inbox' | 'drafts' | 'history';

export function MailPanel({ account }: { account: MailAccount }) {
  const { data, t, locale } = useApp();
  const [tab, setTab] = useState<MailTab>('inbox');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [paginationRevision, setPaginationRevision] = useState(account.revision);
  const [nextCursor, setNextCursor] = useState<string>();
  const [messages, setMessages] = useState<MailMessageSummary[]>([]);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [reading, setReading] = useState<MailMessageSummary | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const requestSequence = useRef(0);
  const denied = data.settings.permissions.network === 'deny';
  const cursor = paginationRevision === account.revision ? cursors.at(-1) : undefined;
  useEffect(() => {
    // A connection edit can change the mailbox source bound to opaque cursors.
    setCursors([]);
    setNextCursor(undefined);
    setPaginationRevision(account.revision);
  }, [account.revision]);
  useEffect(() => {
    if (tab === 'inbox' && (!account.enabled || denied)) {
      setMessages([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const owner = ++requestSequence.current;
    setLoading(true);
    setError('');
    const current = () => owner === requestSequence.current && !controller.signal.aborted;
    const request =
      tab === 'inbox'
        ? mailApi
            .messages(account.id, { query, cursor, limit: 30 }, controller.signal)
            .then((result) => {
              if (current()) {
                setMessages(result.messages);
                setNextCursor(result.nextCursor);
              }
            })
        : mailApi.drafts(account.id, controller.signal).then((result) => {
            if (current()) setDrafts(result);
          });
    void request
      .catch((caught) => {
        if (current()) setError(mailErrorText(caught, t));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      controller.abort();
      requestSequence.current++;
    };
  }, [account.id, account.revision, account.enabled, tab, query, cursor, revision, denied, t]);

  const items = drafts
    .filter(
      (draft) =>
        (tab === 'drafts' ? draft.status === 'draft' : draft.status !== 'draft') &&
        (!query ||
          `${draft.subject}\n${draft.to.join(' ')}\n${draft.text}`
            .toLowerCase()
            .includes(query.toLowerCase())),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  function changeTab(next: MailTab) {
    setTab(next);
    setCursors([]);
    setQuery('');
    setInput('');
    setError('');
  }
  return (
    <section
      className="mail-panel"
      aria-label={t(`${account.name}のメール`, `Email for ${account.name}`)}
    >
      <header className="mail-panel-heading">
        <div>
          <h2>{account.name}</h2>
          <span className="mail-panel-address" title={account.address}>
            {account.address}
          </span>
        </div>
        <Button icon={Plus} disabled={!account.enabled} onClick={() => setComposer({})}>
          {t('メールを作成', 'Compose email')}
        </Button>
      </header>
      <form
        className="mail-panel-tools"
        onSubmit={(event) => {
          event.preventDefault();
          setCursors([]);
          setQuery(input.trim());
          setRevision((value) => value + 1);
        }}
      >
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label={t('メールを検索', 'Search email')}
            maxLength={256}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('送信者・件名などを検索', 'Search sender or subject')}
          />
        </label>
        <Button type="submit" disabled={loading}>
          {t('検索', 'Search')}
        </Button>
        <Button
          type="button"
          icon={RefreshCw}
          busy={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t('更新', 'Refresh')}
        </Button>
      </form>
      <div className="mail-panel-tabs" aria-label={t('メールの表示', 'Email view')}>
        <button aria-pressed={tab === 'inbox'} onClick={() => changeTab('inbox')}>
          <Inbox size={14} />
          {t('受信箱', 'Inbox')}
        </button>
        <button aria-pressed={tab === 'drafts'} onClick={() => changeTab('drafts')}>
          <FilePenLine size={14} />
          {t('下書き', 'Drafts')}
        </button>
        <button aria-pressed={tab === 'history'} onClick={() => changeTab('history')}>
          <Send size={14} />
          {t('送信履歴', 'Send history')}
        </button>
      </div>
      {error && (
        <p className="mail-panel-error" role="alert">
          {error}
        </p>
      )}
      {tab === 'inbox' && (!account.enabled || denied) && (
        <p className="mail-panel-notice">
          {denied
            ? t(
                'ネットワーク権限が「拒否」のため受信箱に接続できません。',
                'The network permission prevents mailbox access.',
              )
            : t(
                'このメール接続は停止中です。設定から有効にしてください。',
                'This email connection is disabled. Enable it in its settings.',
              )}
        </p>
      )}
      {tab === 'history' && (
        <p className="mail-panel-notice">
          {t(
            'Loomから実行した送信の履歴です。「送信済み」はメールサービスが受け付けた状態を示します。',
            'History of sends made through Loom. “Sent” means the email provider accepted the message.',
          )}
        </p>
      )}
      <div className="mail-message-list" aria-busy={loading}>
        {loading ? (
          <div className="mail-loading" role="status">
            <LoaderCircle size={18} className="spin" />
            {t('読み込んでいます…', 'Loading…')}
          </div>
        ) : tab === 'inbox' ? (
          messages.length ? (
            messages.map((message) => (
              <button
                className="mail-message-row"
                key={message.id}
                onClick={() => setReading(message)}
              >
                <div>
                  <strong>
                    {mailAddresses(message.from) || t('送信者なし', 'Unknown sender')}
                  </strong>
                  <span className="mail-message-subject">
                    {message.subject || t('件名なし', 'No subject')}
                  </span>
                  {message.preview && (
                    <span className="mail-message-preview">{message.preview}</span>
                  )}
                </div>
                <time dateTime={message.date}>{dateLabel(message.date, locale, true)}</time>
              </button>
            ))
          ) : (
            <EmptyState
              icon={Mail}
              title={
                query
                  ? t('一致するメールがありません', 'No matching email')
                  : t('メールはありません', 'No email to show')
              }
            >
              {query
                ? t('検索条件を変えて再試行してください。', 'Try a different search.')
                : t(
                    'メールが届いたら、ここから確認できます。',
                    'Incoming email will be available here.',
                  )}
            </EmptyState>
          )
        ) : items.length ? (
          items.map((draft) => (
            <button
              className="mail-message-row"
              key={draft.id}
              onClick={() => setComposer({ draft })}
            >
              <div>
                <strong>{draft.to.join(', ') || t('宛先未設定', 'No recipients')}</strong>
                <span className="mail-message-subject">
                  {draft.subject || t('件名なし', 'No subject')}
                </span>
                <span
                  className={`account-status ${draft.status === 'unknown' || draft.status === 'failed' ? 'error' : ''}`}
                >
                  {draftStatus(draft, t)}
                </span>
              </div>
              <time dateTime={draft.updatedAt}>{dateLabel(draft.updatedAt, locale, true)}</time>
            </button>
          ))
        ) : (
          <EmptyState
            icon={tab === 'drafts' ? FilePenLine : Send}
            title={
              tab === 'drafts'
                ? t('下書きはありません', 'No drafts')
                : t('送信履歴はありません', 'No send history')
            }
          >
            {tab === 'drafts'
              ? t(
                  '作成したメールは、送信前に下書きとして保存できます。',
                  'Save an email as a draft before sending.',
                )
              : t(
                  'Loomから送信すると、結果がここに残ります。',
                  'Send results from Loom are recorded here.',
                )}
          </EmptyState>
        )}
      </div>
      <footer className="mail-panel-footer">
        <span>
          {providerName(account.provider)}
          {account.lastSyncAt
            ? ` · ${t('最終同期', 'Last sync')} ${dateLabel(account.lastSyncAt, locale, true)}`
            : ''}
        </span>
        {tab === 'inbox' && (
          <div className="mail-pagination">
            <Button
              disabled={loading || !cursors.length}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              {t('前へ', 'Previous')}
            </Button>
            <Button
              disabled={loading || !nextCursor}
              onClick={() => {
                if (nextCursor) setCursors((value) => [...value, nextCursor]);
              }}
            >
              {t('次へ', 'Next')}
            </Button>
          </div>
        )}
      </footer>
      {reading && (
        <MailMessageDialog
          account={account}
          summary={reading}
          onClose={() => setReading(null)}
          onReply={(reply) => {
            setReading(null);
            setComposer({ reply });
          }}
        />
      )}
      {composer && (
        <MailComposer
          key={composer.draft?.id || composer.reply?.id || 'new'}
          account={account}
          initial={composer.draft}
          reply={composer.reply}
          onClose={() => setComposer(null)}
          onChanged={(draft) => {
            if (draft) setTab(draft.status === 'draft' ? 'drafts' : 'history');
            setRevision((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}

function draftStatus(draft: MailDraft, t: (ja: string, en: string) => string) {
  return draft.status === 'sent'
    ? t('送信済み', 'Sent')
    : draft.status === 'sending'
      ? t('送信処理中', 'Sending')
      : draft.status === 'unknown'
        ? t('送信結果が未確認', 'Send result uncertain')
        : draft.status === 'failed'
          ? t('送信失敗', 'Send failed')
          : t('下書き', 'Draft');
}

export function MailMessageDialog({
  account,
  summary,
  onClose,
  onReply,
}: {
  account: MailAccount;
  summary: MailMessageSummary;
  onClose: () => void;
  onReply: (message: MailMessage) => void;
}) {
  const { t, locale } = useApp();
  const [message, setMessage] = useState<MailMessage>();
  const [error, setError] = useState('');
  const displayed = message || summary;
  useEffect(() => {
    const controller = new AbortController();
    setMessage(undefined);
    setError('');
    void mailApi
      .message(account.id, summary.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setMessage(result);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(mailErrorText(caught, t));
      });
    return () => controller.abort();
  }, [account.id, account.revision, summary.id, t]);
  return (
    <Modal wide title={t('メール', 'Email')} onClose={onClose}>
      <div className="mail-detail-heading">
        <div>
          <h3>{displayed.subject || t('件名なし', 'No subject')}</h3>
        </div>
        <Button
          icon={Reply}
          disabled={!message}
          onClick={() => {
            if (message) onReply(message);
          }}
        >
          {t('返信', 'Reply')}
        </Button>
      </div>
      <dl className="mail-detail-meta">
        <dt>{t('差出人', 'From')}</dt>
        <dd>{mailAddresses(displayed.from)}</dd>
        <dt>{t('宛先', 'To')}</dt>
        <dd>{mailAddresses(displayed.to)}</dd>
        {!!displayed.cc?.length && (
          <>
            <dt>Cc</dt>
            <dd>{mailAddresses(displayed.cc)}</dd>
          </>
        )}
        <dt>{t('日時', 'Date')}</dt>
        <dd>{dateLabel(displayed.date, locale, true)}</dd>
      </dl>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : !message ? (
        <div className="mail-loading" role="status">
          <LoaderCircle size={18} className="spin" />
          {t('本文を取得しています…', 'Loading message…')}
        </div>
      ) : (
        <>
          {message.truncated && (
            <p className="mail-panel-notice">
              {t(
                '長いメールのため、本文の一部を表示しています。',
                'This long message is shown with some content truncated.',
              )}
            </p>
          )}
          <pre className="mail-plain-text">
            {message.text ||
              t('表示できるテキスト本文がありません。', 'No text body is available.')}
          </pre>
          {!!message.attachments?.length && (
            <>
              <ul
                className="mail-attachment-list"
                aria-label={t('添付ファイル情報', 'Attachment information')}
              >
                {message.attachments.map((item, index) => (
                  <li key={`${item.filename}-${index}`}>
                    <Paperclip size={13} />
                    <span>
                      {item.filename} · {Math.ceil(item.size / 1024)} KB
                    </span>
                  </li>
                ))}
              </ul>
              <p className="field-hint">
                {t(
                  '添付ファイルは一覧のみ表示します。ファイルはメールサービス側から開けます。',
                  'Attachment information only. Open files with your email provider.',
                )}
              </p>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

const splitRecipients = (value: string) =>
  value
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
const replyAddresses = (message: MailMessage, address: string) =>
  (message.replyTo?.length ? message.replyTo : message.from)
    .map((item) => item.address)
    .filter((item) => item.toLowerCase() !== address.toLowerCase());

export function MailComposer({
  account,
  initial,
  reply,
  onClose,
  onChanged,
}: {
  account: MailAccount;
  initial?: MailDraft;
  reply?: MailMessage;
  onClose: () => void;
  onChanged: (draft?: MailDraft) => void;
}) {
  const { data, t, refresh, toast } = useApp();
  const [draft, setDraft] = useState(initial);
  const [to, setTo] = useState(
    initial?.to.join(', ') || (reply ? replyAddresses(reply, account.address).join(', ') : ''),
  );
  const [cc, setCc] = useState(initial?.cc.join(', ') || '');
  const [bcc, setBcc] = useState(initial?.bcc.join(', ') || '');
  const [subject, setSubject] = useState(
    initial?.subject ||
      (reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : ''),
  );
  const [text, setText] = useState(initial?.text || '');
  const [step, setStep] = useState<'edit' | 'review' | 'result'>(
    initial && initial.status !== 'draft' ? 'result' : 'edit',
  );
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(false);
  const mounted = useRef(false);
  const sendId = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const canSend =
    account.enabled &&
    account.sendPolicy !== 'deny' &&
    (account.provider !== 'imap' || !!account.smtp) &&
    data.settings.permissions.network !== 'deny';
  const uncertainResult = uncertain || draft?.status === 'unknown';
  async function save(review: boolean) {
    if (active.current || !account.enabled || !form.current?.reportValidity()) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      const input: MailDraftInput = {
        accountId: account.id,
        to: splitRecipients(to),
        cc: splitRecipients(cc),
        bcc: splitRecipients(bcc),
        subject,
        text,
        ...(reply || initial?.replyToMessageId
          ? { replyToMessageId: reply?.id || initial?.replyToMessageId }
          : {}),
        ...(draft ? { expectedRevision: draft.revision } : {}),
      };
      const saved = await mailApi.saveDraft(input, draft?.id);
      onChanged(saved);
      if (mounted.current) {
        setDraft(saved);
        sendId.current = undefined;
        if (review) setStep('review');
        else {
          toast(t('下書きを保存しました', 'Draft saved'));
          onClose();
        }
      }
    } catch (caught) {
      if (mounted.current) setError(mailErrorText(caught, t));
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function send() {
    if (!draft || active.current || !canSend || step !== 'review' || uncertainResult) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      sendId.current ||= newMailRequestId();
      const result = await mailApi.sendDraft(draft.id, {
        requestId: sendId.current,
        expectedRevision: draft.revision,
        expectedAccountRevision: draft.accountRevision,
      });
      onChanged(result);
      await refresh().catch(() => {});
      if (mounted.current) {
        setDraft(result);
        setStep('result');
      }
    } catch (caught) {
      const definitelyRejected =
        caught instanceof ApiError &&
        [
          'stale_revision',
          'invalid_request',
          'send_disabled',
          'network_denied',
          'account_disabled',
          'not_found',
          'account_unassigned',
          'credentials_required',
        ].includes(caught.code || '');
      if (mounted.current) {
        if (definitelyRejected) setError(mailErrorText(caught, t));
        else {
          setUncertain(true);
          setStep('result');
        }
      }
      onChanged();
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function checkResult() {
    if (!draft || active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = (await mailApi.drafts(account.id)).find((item) => item.id === draft.id);
      if (!saved) throw new ApiError('Draft not found', 404, 'not_found');
      if (mounted.current) {
        setDraft(saved);
        if (saved.status === 'sent' || saved.status === 'failed') setUncertain(false);
      }
      onChanged(saved);
    } catch (caught) {
      if (mounted.current) setError(mailErrorText(caught, t));
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={
        step === 'edit'
          ? reply || initial?.replyToMessageId
            ? t('返信を作成', 'Compose reply')
            : t('メールを作成', 'Compose email')
          : step === 'review'
            ? t('送信内容を確認', 'Review email')
            : t('送信結果', 'Send result')
      }
      onClose={onClose}
    >
      {step === 'edit' ? (
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            void save(true);
          }}
        >
          <Field label={t('差出人', 'From')}>
            <input readOnly value={account.address} />
          </Field>
          <fieldset className="account-fields" disabled={busy || !account.enabled}>
            <Field
              label={t('宛先', 'To')}
              hint={t(
                '複数のメールアドレスはカンマで区切ってください。',
                'Separate multiple email addresses with commas.',
              )}
            >
              <input
                type="email"
                multiple
                required
                maxLength={4000}
                value={to}
                onChange={(event) => setTo(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <details className="mail-copy-recipients" open={!!cc || !!bcc || undefined}>
              <summary>Cc / Bcc</summary>
              <div className="form-grid">
                <Field label="Cc">
                  <input
                    type="email"
                    multiple
                    maxLength={4000}
                    value={cc}
                    onChange={(event) => setCc(event.target.value)}
                  />
                </Field>
                <Field label="Bcc">
                  <input
                    type="email"
                    multiple
                    maxLength={4000}
                    value={bcc}
                    onChange={(event) => setBcc(event.target.value)}
                  />
                </Field>
              </div>
            </details>
            <Field label={t('件名', 'Subject')}>
              <input
                required
                maxLength={500}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </Field>
            <Field label={t('本文', 'Message')}>
              <textarea
                required
                rows={10}
                maxLength={64000}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
          </fieldset>
          {!canSend && (
            <p className="field-hint">
              {account.enabled
                ? t(
                    '下書きは保存できます。送信するにはメール接続と送信権限を有効にしてください。',
                    'You can save a draft. Enable the email connection and sending permission to send it.',
                  )
                : t(
                    'このメール接続は停止中です。編集や送信をするには接続を有効にしてください。',
                    'This email connection is disabled. Enable it to edit or send email.',
                  )}
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <footer className="mail-composer-actions">
            <Button type="button" onClick={onClose}>
              {t('閉じる', 'Close')}
            </Button>
            <Button
              type="button"
              icon={FilePenLine}
              disabled={busy || !account.enabled}
              onClick={() => void save(false)}
            >
              {t('下書きを保存', 'Save draft')}
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!canSend}>
              {t('送信内容を確認', 'Review email')}
            </Button>
          </footer>
        </form>
      ) : (
        <>
          {step === 'result' && (
            <div className={`mail-send-state ${uncertainResult ? 'uncertain' : ''}`} role="status">
              {draft?.status === 'sent' ? (
                <CheckCircle2 size={19} />
              ) : draft?.status === 'sending' && !uncertainResult ? (
                <LoaderCircle size={19} className="spin" />
              ) : (
                <CircleAlert size={19} />
              )}
              <p>
                {draft?.status === 'sent'
                  ? t(
                      'メールサービスが送信を受け付けました。',
                      'The email provider accepted the message.',
                    )
                  : uncertainResult
                    ? t(
                        '送信結果を確認できません。重複送信を防ぐため自動では再送しません。提供元の送信履歴を確認してください。',
                        'The send result is uncertain. Loom will not resend automatically. Check your provider’s sent history before another attempt.',
                      )
                    : draft?.status === 'sending'
                      ? t(
                          '送信処理が進行中です。状態を確認して結果を読み込めます。',
                          'Sending is in progress. Check the status to retrieve the result.',
                        )
                      : t(
                          '送信処理は完了しませんでした。接続設定と提供元の履歴を確認してください。',
                          'Sending did not complete. Check the connection settings and provider history.',
                        )}
              </p>
            </div>
          )}
          {draft && (
            <div className="mail-review">
              <dl className="mail-detail-meta">
                <dt>{t('差出人', 'From')}</dt>
                <dd>{draft.from}</dd>
                <dt>{t('宛先', 'To')}</dt>
                <dd>{draft.to.join(', ')}</dd>
                {!!draft.cc.length && (
                  <>
                    <dt>Cc</dt>
                    <dd>{draft.cc.join(', ')}</dd>
                  </>
                )}
                {!!draft.bcc.length && (
                  <>
                    <dt>Bcc</dt>
                    <dd>{draft.bcc.join(', ')}</dd>
                  </>
                )}
                <dt>{t('件名', 'Subject')}</dt>
                <dd>{draft.subject}</dd>
              </dl>
              <pre className="mail-plain-text">{draft.text}</pre>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <footer className="mail-composer-actions">
            {step === 'review' ? (
              <>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setStep('edit');
                    setError('');
                  }}
                >
                  {t('編集に戻る', 'Back to editing')}
                </Button>
                <Button
                  variant="primary"
                  icon={Send}
                  busy={busy}
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  {busy ? t('送信しています…', 'Sending…') : t('この内容で送信', 'Send this email')}
                </Button>
              </>
            ) : (
              <>
                {draft?.status !== 'sent' && (
                  <Button icon={RefreshCw} busy={busy} onClick={() => void checkResult()}>
                    {t('状態を確認', 'Check status')}
                  </Button>
                )}
                <Button onClick={onClose}>{t('閉じる', 'Close')}</Button>
              </>
            )}
          </footer>
        </>
      )}
    </Modal>
  );
}
