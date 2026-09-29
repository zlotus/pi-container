import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <>
          <h2>{title}</h2>
          {children}
        </>
      ) : null}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  requiredText,
  pending = false,
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** When set, the confirm button stays disabled until this exact text is typed. */
  requiredText?: string | undefined;
  pending?: boolean;
  /** Destructive actions use the red confirm button; reversible ones use the primary color. */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const confirmed = requiredText === undefined || typed === requiredText;

  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed && !pending) onConfirm();
        }}
      >
        <div className="modal-message">{children}</div>
        {requiredText === undefined ? null : (
          <label>
            <span>请输入 <code>{requiredText}</code> 以确认</span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>取消</button>
          <button type="submit" className={tone === "danger" ? "danger-solid" : undefined} disabled={!confirmed || pending}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  tone: "danger" | "primary";
  resolve: (confirmed: boolean) => void;
}

/** Promise-based replacement for window.confirm that renders the Portal dialog. */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback(
    (options: Omit<ConfirmRequest, "resolve" | "tone"> & { tone?: "danger" | "primary" }) =>
      new Promise<boolean>((resolve) => {
        setRequest({ tone: "primary", ...options, resolve });
      }),
    [],
  );

  const settle = (confirmed: boolean) => {
    request?.resolve(confirmed);
    setRequest(null);
  };

  const dialog = (
    <ConfirmDialog
      open={request !== null}
      title={request?.title ?? ""}
      confirmLabel={request?.confirmLabel ?? "确认"}
      tone={request?.tone ?? "primary"}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      <p>{request?.message}</p>
    </ConfirmDialog>
  );

  return [confirm, dialog] as const;
}

export interface TextPromptOptions {
  title: string;
  label: string;
  confirmLabel: string;
  description?: ReactNode;
  type?: "text" | "password";
  minLength?: number;
  maxLength?: number;
  autoComplete?: string;
}

/** Promise-based replacement for window.prompt; resolves to null when cancelled. */
export function useTextPrompt() {
  const [request, setRequest] = useState<
    (TextPromptOptions & { resolve: (value: string | null) => void }) | null
  >(null);
  const [value, setValue] = useState("");

  const prompt = useCallback(
    (options: TextPromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue("");
        setRequest({ ...options, resolve });
      }),
    [],
  );

  const settle = (result: string | null) => {
    request?.resolve(result);
    setRequest(null);
    setValue("");
  };

  const dialog = (
    <Modal open={request !== null} title={request?.title ?? ""} onClose={() => settle(null)}>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (event.currentTarget.checkValidity()) settle(value);
        }}
      >
        {request?.description === undefined ? null : <div className="modal-message">{request.description}</div>}
        <label>
          {request?.label}
          <input
            type={request?.type ?? "text"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            minLength={request?.minLength}
            maxLength={request?.maxLength}
            autoComplete={request?.autoComplete ?? "off"}
            spellCheck={false}
            autoFocus
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={() => settle(null)}>取消</button>
          <button type="submit">{request?.confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );

  return [prompt, dialog] as const;
}
