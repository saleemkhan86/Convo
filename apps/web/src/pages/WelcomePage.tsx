import { Link } from "react-router-dom";
import { Button, Card, Logo } from "../components/ui";
import { ChatIcon, MailIcon, PhoneIcon } from "../components/icons";

export function WelcomePage() {
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
