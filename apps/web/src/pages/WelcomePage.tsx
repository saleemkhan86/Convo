import { Link } from "react-router-dom";
import { Button, Card, Logo } from "../components/ui";
import { ChatIcon, MailIcon, PhoneIcon } from "../components/icons";

export function WelcomePage() {
  const handleGoogleSignIn = () => {
    // Redirect to the public Google OAuth endpoint for sign-in
    window.location.href = "/auth/google?purpose=SIGN_IN&client=web";
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md animate-rise">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="scale-125" />
          <h1 className="mt-6 text-3xl font-bold tracking-tight text-ink-900 dark:text-white">
            One account. Every way to talk.
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-500 dark:text-ink-400">
            Instant chats with your phone number, email messaging that reaches
            Gmail, Outlook and beyond — all from a single Convo account.
          </p>
        </div>

        <Card className="space-y-3">
          <button
            onClick={handleGoogleSignIn}
            className="flex w-full items-center justify-center gap-3 rounded-xl bg-white py-3.5 font-semibold text-ink-800 shadow-sm ring-1 ring-ink-200 transition-colors hover:bg-ink-50 dark:bg-night-surface dark:text-ink-100 dark:ring-night-border dark:hover:bg-night-raised"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Continue with Google
          </button>
          <Link to="/auth/phone" className="block">
            <Button block className="py-3.5">
              <PhoneIcon className="h-4.5 w-4.5" />
              Continue with Phone Number
            </Button>
          </Link>
          <Link to="/auth/email" className="block">
            <Button variant="secondary" block className="py-3.5">
              <MailIcon className="h-4.5 w-4.5" />
              Continue with Email
            </Button>
          </Link>
          <p className="pt-2 text-center text-xs leading-relaxed text-ink-400">
            You can connect the other identity later — your phone and email live
            on the same Convo account.
          </p>
        </Card>

        <div className="mt-8 grid grid-cols-2 gap-3 text-center">
          <div className="rounded-card border border-ink-200/60 bg-white/60 p-4 dark:border-night-border dark:bg-night-surface/60">
            <ChatIcon className="mx-auto h-5 w-5 text-iris-500" />
            <p className="mt-2 text-xs font-semibold text-ink-700 dark:text-ink-200">Chats</p>
            <p className="mt-0.5 text-[11px] text-ink-400">Phone-based messaging</p>
          </div>
          <div className="rounded-card border border-ink-200/60 bg-white/60 p-4 dark:border-night-border dark:bg-night-surface/60">
            <MailIcon className="mx-auto h-5 w-5 text-signal-500" />
            <p className="mt-2 text-xs font-semibold text-ink-700 dark:text-ink-200">Mail</p>
            <p className="mt-0.5 text-[11px] text-ink-400">Email, chat-style</p>
          </div>
        </div>
      </div>
    </div>
  );
}
