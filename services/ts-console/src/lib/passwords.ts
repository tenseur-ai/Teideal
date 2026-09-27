import bcrypt from "bcryptjs";

// Cost 10 keeps tests fast (bcrypt is deliberately slow) while still being a
// realistic production value; raise it later if hardware moves on.
const COST = 10;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, COST);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
