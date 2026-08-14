import * as Dialog from '@radix-ui/react-dialog';
import * as Toast from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'default' | 'compact' | 'icon';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'default', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('fmr-button', `fmr-button--${variant}`, `fmr-button--${size}`, className)}
      {...props}
    />
  );
});

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('fmr-card', className)} {...props} />;
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { id, label, hint, error, className, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? `fmr-field-${generatedId.replaceAll(':', '')}`;
  const descriptionId = hint || error ? `${inputId}-description` : undefined;
  return (
    <label className="fmr-field" htmlFor={inputId}>
      <span className="fmr-field__label">{label}</span>
      <input
        ref={ref}
        id={inputId}
        className={cn('fmr-input', error && 'fmr-input--error', className)}
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
        {...props}
      />
      {descriptionId ? (
        <span id={descriptionId} className={cn('fmr-field__hint', error && 'fmr-field__error')}>
          {error ?? hint}
        </span>
      ) : null}
    </label>
  );
});

export function StatusBadge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'danger' | 'info' | 'warning';
  children: ReactNode;
}) {
  return <span className={cn('fmr-badge', `fmr-badge--${tone}`)}>{children}</span>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="fmr-empty">
      {icon}
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fmr-dialog__overlay" />
        <Dialog.Content className="fmr-dialog__content">
          <Dialog.Title className="fmr-dialog__title">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="fmr-dialog__description">
              {description}
            </Dialog.Description>
          ) : null}
          {children}
          <Dialog.Close asChild>
            <Button className="fmr-dialog__close" size="icon" variant="ghost" aria-label="닫기">
              <X aria-hidden size={20} />
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  tone?: 'neutral' | 'success' | 'danger' | 'info';
}

interface ToastContextValue {
  notify: (message: Omit<ToastMessage, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const notify = useCallback((message: Omit<ToastMessage, 'id'>) => {
    const id = Date.now() + Math.random();
    setMessages((current) => [...current, { id, ...message }]);
  }, []);
  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      <Toast.Provider duration={3000} swipeDirection="right">
        {children}
        {messages.map((message) => (
          <Toast.Root
            key={message.id}
            className={cn('fmr-toast', `fmr-toast--${message.tone ?? 'neutral'}`)}
            defaultOpen
            onOpenChange={(open) => {
              if (!open) setMessages((current) => current.filter((item) => item.id !== message.id));
            }}
          >
            <Toast.Title className="fmr-toast__title">{message.title}</Toast.Title>
            {message.description ? (
              <Toast.Description className="fmr-toast__description">
                {message.description}
              </Toast.Description>
            ) : null}
          </Toast.Root>
        ))}
        <Toast.Viewport className="fmr-toast__viewport" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
