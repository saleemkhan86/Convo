export const ApiErrorCode = {
  ValidationError: "VALIDATION_ERROR",
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  NotFound: "NOT_FOUND",
  Conflict: "CONFLICT",
  RateLimited: "RATE_LIMITED",
  OtpInvalid: "OTP_INVALID",
  OtpExpired: "OTP_EXPIRED",
  OtpAttemptsExceeded: "OTP_ATTEMPTS_EXCEEDED",
  ChallengeNotFound: "CHALLENGE_NOT_FOUND",
  IdentityAlreadyLinkedToThisAccount: "IDENTITY_ALREADY_LINKED_TO_THIS_ACCOUNT",
  IdentityLinkedToAnotherAccount: "IDENTITY_LINKED_TO_ANOTHER_ACCOUNT",
  Internal: "INTERNAL_ERROR",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}
