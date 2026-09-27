import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AuthResult, Challenge } from "@convo/shared";
import { ArrowLeftIcon } from "../components/icons";
import { Button, Card, Input, Logo, OtpInput } from "../components/ui";
import { ApiRequestError, api } from "../lib/api";
import { useAuth } from "../lib/auth";

interface OtpFlowProps {
  title: string;
  subtitle: string;
  targetLabel: string;
  targetPlaceholder: string;
  requestOtp: (target: string) => Promise<Challenge>;
  verifyOtp: (challengeId: string, code: string) => Promise<AuthResult>;
  validateTarget: (target: string) => string | null;
}

export function OtpFlow({
  title,
  subtitle,
  targetLabel,
  targetPlaceholder,
  requestOtp,
  verifyOtp,
  validateTarget,
}: OtpFlowProps) {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [step, setStep] = useState<"target" | "otp">("target");
  const [target, setTarget] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errorMessage = (err: unknown): string =>
    err instanceof ApiRequestError ? err.message : "Something went wrong. Please try again.";

  const handleRequest = async () => {
    const invalid = validateTarget(target);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await requestOtp(target);
      setChallenge(c);
      setStep("otp");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (code: string) => {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verifyOtp(challenge.challengeId, code);
      signIn(result);
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    setBusy(true);
    setError(null);
    try {
      setChallenge(await requestOtp(target));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md animate-rise">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/welcome" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800 dark:hover:text-ink-200">
            <ArrowLeftIcon className="h-4 w-4" /> Back
          </Link>
          <Logo />
        </div>

        <Card>
          {step === "target" ? (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-ink-900 dark:text-white">{title}</h1>
                <p className="mt-1.5 text-sm text-ink-500 dark:text-ink-400">{subtitle}</p>
              </div>
              <Input
                label={targetLabel}
                type={targetLabel.toLowerCase().includes("email") ? "email" : "tel"}
                placeholder={targetPlaceholder}
                value={target}
                autoFocus
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleRequest()}
                error={error}
              />
              <Button block loading={busy} onClick={() => void handleRequest()}>
                Send verification code
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-ink-900 dark:text-white">Enter your code</h1>
                <p className="mt-1.5 text-sm text-ink-500 dark:text-ink-400">
                  We sent a 6-digit code to <span className="font-semibold text-ink-700 dark:text-ink-200">{target}</span>
                </p>
              </div>
              {challenge?.devOtp && (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  Dev mode — your code is <span className="font-mono font-bold">{challenge.devOtp}</span>
                </p>
              )}
              <OtpInput disabled={busy} onComplete={(code) => void handleVerify(code)} />
              {error && <p className="text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
              <div className="flex items-center justify-center gap-4 text-sm">
                <button onClick={() => void handleResend()} disabled={busy} className="font-semibold text-iris-600 hover:text-iris-700 disabled:opacity-50 dark:text-iris-400">
                  Resend code
                </button>
                <span className="text-ink-300">•</span>
                <button onClick={() => { setStep("target"); setError(null); }} className="font-medium text-ink-500 hover:text-ink-700 dark:text-ink-400">
                  Change {targetLabel.toLowerCase()}
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export function PhoneAuthPage() {
  return (
    <OtpFlow
      title="Continue with your phone number"
      subtitle="Your phone identity powers Chats on Convo."
      targetLabel="Phone Number"
      targetPlaceholder="+919876543210"
      requestOtp={api.requestPhoneOtp}
      verifyOtp={api.verifyPhoneOtp}
      validateTarget={(v) =>
        /^\+[1-9]\d{6,14}$/.test(v.trim()) ? null : "Enter your number in E.164 format, e.g. +919876543210"
      }
    />
  );
}

export function EmailAuthPage() {
  return (
    <OtpFlow
      title="Continue with your email"
      subtitle="Your email identity powers Mail on Convo."
      targetLabel="Email"
      targetPlaceholder="you@example.com"
      requestOtp={api.requestEmailOtp}
      verifyOtp={api.verifyEmailOtp}
      validateTarget={(v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : "Enter a valid email address")}
    />
  );
}
