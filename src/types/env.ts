import { Type as T } from "@sinclair/typebox";
import { StaticDecode } from "@sinclair/typebox";
import dotenv from "dotenv";
dotenv.config();

/**
 * Define sensitive environment variables here.
 *
 * These are fed into the worker/workflow as `env` and are
 * taken from either `dev.vars` or repository secrets.
 * They are used with `process.env` but are type-safe.
 */
export const envSchema = T.Object({
  ANTHROPIC_API_KEY: T.String(),
  UBIQUITY_OS_APP_NAME: T.String({ default: "UbiquityOS" }),
  KERNEL_PUBLIC_KEY: T.Optional(T.String()),
  LOG_LEVEL: T.Optional(T.String()),
});

export type Env = StaticDecode<typeof envSchema>;
