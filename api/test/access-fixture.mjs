import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

if (process.env.NODE_ENV !== "development")
  throw new Error("The Access fixture is only allowed in local development");
const issuer = "http://access-fixture:3001";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "local-test", alg: "RS256" };
createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && request.url === "/cdn-cgi/access/certs") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  } else if (request.method === "POST" && request.url === "/test-token") {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const overrides = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        issuer,
        iss: issuer,
        aud: "platform-local-test",
        iat: now,
        exp: now + 300,
        ...overrides,
      })
        .setProtectedHeader({ alg: "RS256", kid: "local-test" })
        .sign(privateKey);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ token }));
    } catch {
      response.writeHead(400).end("Invalid local fixture request");
    }
  } else {
    response.writeHead(404).end();
  }
}).listen(3001, "0.0.0.0");
