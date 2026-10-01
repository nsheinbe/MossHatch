import type { Pool } from "@mosshatch/db";

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

/** HMAC keys live in KMS in production; tests and local development use LocalKms. */
export interface KmsPort {
  hmac(keyId: "audit" | "pointer" | "rate" | "email-token", data: Uint8Array): Promise<Buffer>;
  readonly mode: "local" | "aws";
}

/** PII field encryption (contacts, registrar profile passwords, IPs): AES-256-GCM envelopes. */
export interface PiiPort {
  encrypt(plaintext: string, aad: string): Promise<Envelope>;
  decrypt(env: Envelope, aad: string): Promise<string>;
}
export interface Envelope { v: 1; alg: "A256GCM"; nonce: string; ct: string; tag: string; kek: string }

export interface EmailMessage {
  /** Idempotency: a second send with the same key is a no-op. */
  dedupeKey: string;
  kind: string;
  userId?: string;
  /** Resolved by the caller from notification_addresses at send time; never logged. */
  to: string[];
  subject: string;
  text: string;
  /** Mail class for rate limiting: A = triggered by an unauthenticated request, B = security notice about an existing account. */
  klass?: "A" | "B" | "C";
}
export interface EmailPort {
  send(msg: EmailMessage): Promise<{ id: string }>;
}

export type Mode = "local" | "preview" | "staging" | "production";

export interface Config {
  mode: Mode;
  origin: string;                 // e.g. https://mosshatch.com
  rpId: string;                   // e.g. mosshatch.com
  allowedOrigins: string[];
  cronSecret: string;
  livemode: boolean;
  stripeWebhookSecret?: string;
  /** Test key kind seen by the mode guard, never the key itself. */
  stripeKeyKind: "test" | "live" | "none";
  registrarMode: "mock" | "sandbox" | "live";
}

export interface AppContext {
  runtime: Pool;
  cron: Pool;
  clock: Clock;
  kms: KmsPort;
  pii: PiiPort;
  email: EmailPort;
  config: Config;
  /** Filled by later modules (orders, stripe, registrar); kept optional so the foundation compiles alone. */
  services: Record<string, unknown>;
}
