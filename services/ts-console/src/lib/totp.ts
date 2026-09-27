import { TOTP, Secret } from "otpauth";

export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: "Teideal",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function otpauthUri(secretBase32: string, accountLabel: string): string {
  return totpFor(secretBase32, accountLabel).toString();
}

// One period of drift each way tolerates ordinary clock skew between the
// authenticator app and the server without materially widening the guessing
// window (30s either side of a 6-digit code).
export function verifyCode(secretBase32: string, accountLabel: string, code: string): boolean {
  const delta = totpFor(secretBase32, accountLabel).validate({ token: code, window: 1 });
  return delta !== null;
}

export function generateCode(secretBase32: string, accountLabel: string): string {
  return totpFor(secretBase32, accountLabel).generate();
}
