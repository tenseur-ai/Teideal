// CONNECTOR_CREDENTIAL_ENCRYPTION_KEY encrypts API-key connector secrets on connectors.credential_*.
// Stripe Connect OAuth access/refresh tokens stay on stripe_connections under STRIPE_TOKEN_ENCRYPTION_KEY.
// TEID-65 must read Stripe tokens from stripe_connections and must not copy them into connectors.credential_*.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export class ConnectorCredentialConfigError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "ConnectorCredentialConfigError";
  }
}

function validateKey(key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new ConnectorCredentialConfigError(
      "CONNECTOR_CREDENTIAL_ENCRYPTION_KEY must be base64 that decodes to 32 bytes",
    );
  }
  return key;
}

export function decodeConnectorCredentialEncryptionKey(raw: string): Buffer {
  return validateKey(Buffer.from(raw, "base64"));
}

export function loadConnectorCredentialEncryptionKey(): Buffer {
  const raw = process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new ConnectorCredentialConfigError("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY is required");
  return decodeConnectorCredentialEncryptionKey(raw);
}

function asKey(key: Buffer | string): Buffer {
  return typeof key === "string" ? decodeConnectorCredentialEncryptionKey(key) : validateKey(key);
}

export function encryptCredential(plaintext: string, key: Buffer | string): EncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", asKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptCredential(encrypted: EncryptedCredential, key: Buffer | string): string {
  const decipher = createDecipheriv("aes-256-gcm", asKey(key), Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
