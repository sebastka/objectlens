import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Capability, Section } from '../../shared/types.ts';
import { ToastContext, type ToastLevel } from '../toast.ts';
import { Icon, type IconName } from './icons.tsx';

/**
 * A button for an action that needs a capability. Denied: disabled, and the reason is the
 * tooltip (and is read out, since disabled buttons get no focus).
 */
export function CapButton({
  cap,
  icon,
  label,
  onClick,
  disabled,
  primary,
  danger,
  title,
  iconOnly,
}: {
  cap?: Capability | Capability[] | undefined;
  icon?: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  title?: string;
  iconOnly?: boolean;
}) {
  const caps = cap === undefined ? [] : Array.isArray(cap) ? cap : [cap];
  const denied = caps.find((c) => c.allowed === false);
  const tip = denied ? `Not allowed: ${denied.reason ?? 'denied'}` : (title ?? (iconOnly ? label : undefined));
  return (
    <span className="cap-wrap" title={tip}>
      <button
        type="button"
        className={`btn${primary ? ' btn-primary' : ''}${danger ? ' btn-danger' : ''}${iconOnly ? ' btn-icon' : ''}`}
        onClick={onClick}
        disabled={Boolean(denied) || disabled}
        aria-label={iconOnly ? label : undefined}
      >
        {icon && <Icon name={icon} />}
        {!iconOnly && <span>{label}</span>}
        {denied && <Icon name="lock" size={12} className="lock" />}
      </button>
      {denied && <span className="visually-hidden">{tip}</span>}
    </span>
  );
}

/** A side panel over the page; Escape or a click on the backdrop closes it. */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  actions,
  wide,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        className={`drawer${wide ? ' drawer-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="drawer-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <div className="muted small mono wrap">{subtitle}</div>}
          </div>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close" autoFocus>
            <Icon name="x" />
          </button>
        </div>
        {actions && <div className="drawer-actions">{actions}</div>}
        {children}
      </aside>
    </>
  );
}

/** A modal dialog (native <dialog>: focus trap and Escape for free). */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal-wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{footer}</div>
      </form>
    </dialog>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="banner banner-error" role="alert">
      <Icon name="info" />
      <div>{children}</div>
    </div>
  );
}

export function InfoBanner({ children }: { children: ReactNode }) {
  return (
    <div className="banner">
      <Icon name="info" />
      <div>{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: number | null }[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className="tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Definition list of label → value; empty values are left out. */
export function KV({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  return (
    <dl className="kv">
      {shown.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A read-only configuration value: JSON, "not configured", denied or failed. */
export function SectionView<T>({
  section,
  render,
  empty = 'Not configured',
}: {
  section: Section<T>;
  render?: (v: NonNullable<T>) => ReactNode;
  empty?: string;
}) {
  if (!section.ok) {
    return (
      <div className={`section-state ${section.denied ? 'denied' : 'failed'}`}>
        <Icon name={section.denied ? 'lock' : 'info'} size={14} />
        {section.denied
          ? 'These credentials may not read this.'
          : /NotImplemented/.test(section.error)
            ? 'Not supported by this S3 server.'
            : section.error}
      </div>
    );
  }
  const v = section.value;
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return <div className="muted">{empty}</div>;
  return <>{render ? render(v as NonNullable<T>) : <pre className="code">{JSON.stringify(v, null, 2)}</pre>}</>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spin" />
      {label && <span>{label}</span>}
    </span>
  );
}

// --- Toasts -------------------------------------------------------------------------------

interface Toast {
  id: number;
  level: ToastLevel;
  text: ReactNode;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: ReactNode, level: ToastLevel = 'ok') => {
    const id = next.current++;
    setToasts((t) => [...t, { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'error' ? 10_000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.level}`}>
            <Icon name={t.level === 'error' ? 'info' : t.level === 'ok' ? 'check' : 'info'} />
            <div className="grow">{t.text}</div>
            <button
              type="button"
              className="btn-link"
              aria-label="Dismiss"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
