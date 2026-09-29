import { type ReactNode, useEffect, useRef, useState } from "react";

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
