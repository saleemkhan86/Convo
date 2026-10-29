import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export function OAuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    if (!code) {
      setError("No authorization code received");
      return;
    }

    const exchangeCode = async () => {
      try {
        const result = await api.exchangeOAuthCode(code);
        signIn(result);
        navigate("/", { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to complete sign-in");
      }
    };

    void exchangeCode();
  }, [searchParams, navigate, signIn]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-semibold text-red-600">Sign-in failed</p>
          <p className="mt-2 text-sm text-ink-500">{error}</p>
          <button
            onClick={() => navigate("/welcome")}
            className="mt-4 text-sm font-semibold text-iris-600 hover:underline"
          >
            Back to welcome
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <Spinner className="mx-auto h-8 w-8 text-iris-500" />
        <p className="mt-4 text-sm text-ink-500">Completing sign-in...</p>
      </div>
    </div>
  );
}
