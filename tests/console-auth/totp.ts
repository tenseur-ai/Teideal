import { TOTP, Secret } from "otpauth";

export function codeFor(secretBase32: string, label: string): string {
  return new TOTP({
    issuer: "Teideal",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}
