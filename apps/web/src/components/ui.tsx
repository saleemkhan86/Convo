import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  block?: boolean;
}

export function Button({ variant = "primary", loading, block, className, children, disabled, ...rest }: ButtonProps) {
  const variants: Record<ButtonVariant, string> = {
    primary:
      "bg-iris-600 text-white hover:bg-iris-700 active:bg-iris-800 shadow-sm shadow-iris-600/25",
    secondary:
      "bg-white text-ink-800 border border-ink-200 hover:bg-ink-50 dark:bg-night-raised dark:text-ink-100 dark:border-night-border dark:hover:bg-ink-900",
    ghost:
      "text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-night-raised",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-500",
        variants[variant],
        block && "w-full",
        className,
      )}
      disabled={disabled ?? loading}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("h-4 w-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
  hint?: string;
}

export function Input({ label, error, hint, className, id, ...rest }: InputProps) {
  const inputId = id ?? rest.name ?? label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <label className="block" htmlFor={inputId}>
      {label && (
        <span className="mb-1.5 block text-sm font-medium text-ink-600 dark:text-ink-300">{label}</span>
      )}
      <input
        id={inputId}
        className={cx(
          "w-full rounded-xl border bg-white px-4 py-3 text-[15px] text-ink-900 placeholder:text-ink-400 transition-colors",
          "focus:border-iris-500 focus:outline-none focus:ring-2 focus:ring-iris-500/25",
          "dark:bg-night-raised dark:text-ink-50 dark:border-night-border",
          error ? "border-red-400" : "border-ink-200",
          className,
        )}
        {...rest}
      />
      {error && <span className="mt-1.5 block text-sm text-red-600 dark:text-red-400">{error}</span>}
      {!error && hint && <span className="mt-1.5 block text-sm text-ink-400">{hint}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        "rounded-card border border-ink-200/70 bg-white p-6 shadow-sm dark:border-night-border dark:bg-night-surface",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "success" | "iris"; children: ReactNode }) {
  const tones = {
    neutral: "bg-ink-100 text-ink-600 dark:bg-night-raised dark:text-ink-300",
    success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
    iris: "bg-iris-100 text-iris-700 dark:bg-iris-500/15 dark:text-iris-300",
  };
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone])}>
      {children}
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-iris-500 to-signal-400 shadow-sm">
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-white" fill="currentColor" aria-hidden>
          <path d="M12 3C7 3 3 6.4 3 10.6c0 2.4 1.3 4.5 3.4 5.9-.1.9-.6 2.1-1.6 3 1.9-.3 3.5-1.1 4.6-1.9.8.2 1.7.3 2.6.3 5 0 9-3.4 9-7.6S17 3 12 3z" />
        </svg>
      </span>
      <span className="text-lg font-bold tracking-tight text-ink-900 dark:text-white">Convo</span>
    </span>
  );
}

export function OtpInput({
  length = 6,
  onComplete,
  disabled,
}: {
  length?: number;
  onComplete: (code: string) => void;
  disabled?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>(Array(length).fill(""));
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  const emit = (next: string[]) => {
    setDigits(next);
    if (next.every((d) => d !== "")) onComplete(next.join(""));
  };

  return (
    <div className="flex justify-center gap-2" role="group" aria-label="Verification code">
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          disabled={disabled}
          value={digit}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(-1);
            const next = [...digits];
            next[i] = v;
            emit(next);
            if (v && i < length - 1) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !digits[i] && i > 0) {
              refs.current[i - 1]?.focus();
              const next = [...digits];
              next[i - 1] = "";
              setDigits(next);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
            if (!pasted) return;
            const next = Array(length).fill("");
            [...pasted].forEach((c, j) => {
              next[j] = c;
            });
            emit(next);
            refs.current[Math.min(pasted.length, length - 1)]?.focus();
          }}
          className="h-14 w-11 rounded-xl border border-ink-200 bg-white text-center text-xl font-semibold text-ink-900 focus:border-iris-500 focus:outline-none focus:ring-2 focus:ring-iris-500/25 dark:border-night-border dark:bg-night-raised dark:text-white"
        />
      ))}
    </div>
  );
}
