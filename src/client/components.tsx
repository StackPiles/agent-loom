import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  Bot as BotIcon,
  Check,
  ChevronDown,
  Compass,
  Copy,
  Lightbulb,
  LoaderCircle,
  Search,
  Sparkles,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Bot, TaskStatus } from '../shared/types';
import { activeStatuses, statusLabel, useApp } from './context';

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? 'brand-small' : ''}`}>
      <svg viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <path
          d="M8 6v24M18 6v24M28 6v24"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d="m6 14 24 8M6 24l24-12"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
      {!small && (
        <span>
          agent<span className="brand-light">loom</span>
          <span className="brand-dot">.</span>
        </span>
      )}
    </span>
  );
}
export const avatarIcons: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  compass: Compass,
  bot: BotIcon,
  lightbulb: Lightbulb,
  search: Search,
  wrench: Wrench,
};

const graphemeSegmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
function firstGrapheme(text: string): string {
  if (graphemeSegmenter)
    return graphemeSegmenter.segment(text)[Symbol.iterator]().next().value?.segment || '';
  return Array.from(text)[0] || '';
}

export function Avatar({
  bot,
  size = 'normal',
}: {
  bot?: Pick<Bot, 'name' | 'avatar' | 'color'>;
  size?: 'small' | 'normal' | 'large';
}) {
  const value = bot?.avatar.trim() || '';
  const iconName = value.toLowerCase();
  const Icon = Object.hasOwn(avatarIcons, iconName) ? avatarIcons[iconName] : undefined;
  const glyph = Icon
    ? ''
    : value && firstGrapheme(value) === value
      ? value
      : firstGrapheme(bot?.name.trim() || 'L');
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ '--avatar-color': bot?.color || '#8c9192' } as CSSProperties}
      aria-hidden="true"
    >
      {Icon ? (
        <Icon className="avatar-symbol" strokeWidth={1.7} />
      ) : (
        <span className="avatar-initial">{glyph}</span>
      )}
    </span>
  );
}
export function Button({
  children,
  variant = 'secondary',
  icon: Icon,
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: LucideIcon;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button button-${variant} ${props.className || ''}`}
      disabled={props.disabled || busy}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : Icon && <Icon size={16} />}
      <span>{children}</span>
    </button>
  );
}
export function IconButton({
  icon: Icon,
  label,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      {...props}
      className={`icon-button ${props.className || ''}`}
      aria-label={label}
      title={label}
    >
      <Icon size={18} />
    </button>
  );
}
export function Status({ status }: { status: TaskStatus }) {
  const { locale } = useApp();
  return (
    <span className={`status status-${status}`}>
      <span
        className={
          activeStatuses.includes(status) && status !== 'awaiting_approval'
            ? 'status-dot pulse'
            : 'status-dot'
        }
      />
      {statusLabel(status, locale)}
    </span>
  );
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const { t } = useApp();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select')?.focus();
    }
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-shell">
        <header className="modal-header">
          <div>
            <h2 id={id}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon={X} label={t('閉じる', 'Close')} onClick={onClose} />
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </dialog>
  );
}
export function Confirm({
  title,
  children,
  onClose,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t, toast } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="confirm-description">{children}</p>
      <footer className="form-actions">
        <Button onClick={onClose}>{t('キャンセル', 'Cancel')}</Button>
        <Button
          variant="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (error) {
              toast(String((error as Error).message), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('実行する', 'Confirm')}
        </Button>
      </footer>
    </Modal>
  );
}
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row ${disabled ? 'disabled' : ''}`}>
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <input
        className="visually-hidden"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`toggle ${checked ? 'on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </label>
  );
}
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={28} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
export function CopyButton({ text }: { text: string }) {
  const { t, toast } = useApp();
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={t('コピー', 'Copy')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          toast(
            t(
              'コピーできませんでした。テキストを選択してコピーしてください。',
              'Could not copy. Please select and copy the text.',
            ),
            'error',
          );
        }
      }}
    />
  );
}
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: content, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {content}
            </a>
          ),
          pre: ({ children: content }) => <pre>{content}</pre>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
export function Disclosure({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="disclosure" open={defaultOpen || undefined}>
      <summary>
        {title}
        <ChevronDown size={16} />
      </summary>
      <div>{children}</div>
    </details>
  );
}
