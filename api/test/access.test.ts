import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AccessVerifier } from "../src/access.js";

const issuer = "https://local-access.example";
const audience = "platform-test";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const key = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "local" }] });
const verifier = new AccessVerifier(issuer, audience, key);
const sign = (claims: Record<string, unknown> = {}) =>
  new SignJWT({ email: "Employee@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "local" })
    .setIssuer(issuer)
    .setSubject("stable-user")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

test("verified subject identifies a user; email is metadata", async () => {
  assert.deepEqual(await verifier.verify(await sign()), {
    issuer,
    subject: "stable-user",
    email: "employee@example.com",
  });
});
test("rejects absent or malformed tokens and invalid email", async () => {
  for (const value of [undefined, "", "not-a-jwt", ["one", "two"], await sign({ email: "" })])
    await assert.rejects(verifier.verify(value));
});
test("rejects a different issuer, audience, expired token and unsigned payload", async () => {
  for (const claims of [{ iss: "https://other.example" }, { aud: "another-app" }, { exp: 1 }]) {
    const token = await new SignJWT({
      email: "a@example.com",
      sub: "user",
      iss: issuer,
      aud: audience,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "local" })
      .sign(privateKey);
    await assert.rejects(verifier.verify(token));
  }
  const token = await sign();
  const parts = token.split(".");
  parts[1] = Buffer.from(JSON.stringify({ email: "admin@example.com" })).toString("base64url");
  await assert.rejects(verifier.verify(parts.join(".")));
});
