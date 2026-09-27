const FAKE_GOOGLE_URL = process.env.FAKE_GOOGLE_URL ?? "http://127.0.0.1:8090";

export async function mintGoogleIdToken(email: string, subject: string): Promise<string> {
  const res = await fetch(`${FAKE_GOOGLE_URL}/mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, subject }),
  });
  const body = await res.json();
  return body.id_token;
}

export async function setFakeGoogleLatency(ms: number): Promise<void> {
  await fetch(`${FAKE_GOOGLE_URL}/latency`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ms }),
  });
}
