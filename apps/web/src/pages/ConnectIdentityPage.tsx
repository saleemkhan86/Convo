import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Account, Challenge } from "@convo/shared";
import { ArrowLeftIcon, MailIcon, PhoneIcon } from "../components/icons";
import { Button, Card, Input, Logo, OtpInput } from "../components/ui";
import { ApiRequestError, api } from "../lib/api";
import { useAuth } from "../lib/auth";

type Channel = "email" | "phone";

/**
 * Flow E — connects a second identity to the CURRENT account.
 * Wording deliberately says "connect", never "create account" (spec §8).
 */
export function ConnectIdentityPage({ channel }: { channel: Channel }) {
  const isEmail = channel === "email";
  const navigate = useNavigate();
  const { account, setAccount } = useAuth();
  const [step, setStep] = useState<"target" | "otp">("target");
  const [target, setTarget] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!account) return null;
  const alreadyConnected = isEmail ? account.email : account.phone;

  const requestOtp = (): Promise<Challenge> =>
    isEmail ? api.connectEmailRequest(target.trim()) : api.connectPhoneRequest(target.trim());

  const verifyOtp = async (code: string): Promise<Account> =>
    isEmail
      ? api.connectEmailVerify(challenge!.challengeId, code)
      : api.connectPhoneVerify(challenge!.challengeId, code);

  const handleRequest = async () => {
    const value = target.trim();
    const invalid = isEmail
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? null
        : "Enter a valid email address"
      : /^\+[1-9]\d{6,14}$/.test(value)
        ? null
        : "Enter your number in E.164 format, e.g. +919876543210";
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setChallenge(await requestOtp());
      setStep("otp");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await verifyOtp(code));
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md animate-rise">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/settings" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800 dark:hover:text-ink-200">
            <ArrowLeftIcon className="h-4 w-4" /> Settings
          </Link>
          <Logo />
        </div>

        <Card>
          {alreadyConnected ? (
            <div className="space-y-3 text-center">
              <h1 className="text-lg font-bold text-ink-900 dark:text-white">
                {isEmail ? "Email already connected" : "Phone number already connected"}
              </h1>
              <p className="text-sm text-ink-500 dark:text-ink-400">
                {isEmail ? account.email?.email : account.phone?.phone} is linked to this account.
                An account can hold one {isEmail ? "email" : "phone"} identity.
              </p>
              <Link to="/settings">
                <Button variant="secondary" block>Back to Settings</Button>
              </Link>
            </div>
          ) : step === "target" ? (
            <div className="space-y-5">
              <div>
                <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-ink-900 dark:text-white">
                  {isEmail ? <MailIcon className="h-5 w-5 text-signal-500" /> : <PhoneIcon className="h-5 w-5 text-iris-500" />}
                  {isEmail ? "Connect Email" : "Connect Phone Number"}
                </h1>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-500 dark:text-ink-400">
                  {isEmail
                    ? "Add an email identity to your existing Convo account to unlock Mail. We'll verify you own it first — no second account is created."
                    : "Add a phone identity to your existing Convo account to unlock Chats. We'll verify you own it first — no second account is created."}
                </p>
              </div>
              <Input
                label={isEmail ? "Email address" : "Phone number"}
                type={isEmail ? "email" : "tel"}
                placeholder={isEmail ? "you@example.com" : "+919876543210"}
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
                <h1 className="text-xl font-bold tracking-tight text-ink-900 dark:text-white">Verify ownership</h1>
                <p className="mt-1.5 text-sm text-ink-500 dark:text-ink-400">
                  Enter the code sent to <span className="font-semibold text-ink-700 dark:text-ink-200">{target}</span>.
                  The {isEmail ? "email" : "phone"} identity links to this account only after verification.
                </p>
              </div>
              {challenge?.devOtp && (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  Dev mode — your code is <span className="font-mono font-bold">{challenge.devOtp}</span>
                </p>
              )}
              <OtpInput disabled={busy} onComplete={(code) => void handleVerify(code)} />
              {error && <p className="text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
              <button
                onClick={() => { setStep("target"); setError(null); }}
                className="block w-full text-center text-sm font-medium text-ink-500 hover:text-ink-700 dark:text-ink-400"
              >
                Use a different {isEmail ? "email" : "number"}
              </button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
