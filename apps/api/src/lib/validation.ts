import { ZodError, type ZodTypeAny } from "zod";
import { badRequest } from "./errors.js";

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): ReturnType<T["parse"]> {
  try {
    return schema.parse(data) as ReturnType<T["parse"]>;
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest(
        "Validation failed",
        err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    throw err;
  }
}
