import { UnauthorizedException } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessIdentity {
  issuer: string;
  subject: string;
  email: string;
}

export class AccessVerifier {
  private readonly key: JWTVerifyGetKey;

  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    key?: JWTVerifyGetKey
  ) {
    const url = new URL(issuer);
    if (url.protocol !== "https:" && process.env.NODE_ENV !== "development")
      throw new Error("Access issuer must use HTTPS outside local development");
    if (!audience) throw new Error("Access audience is required");
    this.key = key ?? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", url));
  }

  async verify(header: string | string[] | undefined): Promise<AccessIdentity> {
    if (typeof header !== "string" || !header)
      throw new UnauthorizedException("Cloudflare Access token required");
    try {
      const { payload } = await jwtVerify(header, this.key, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "email"],
      });
      if (
        !payload.sub ||
        typeof payload.email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
      )
        throw new Error("Access user identity is incomplete");
      return {
        issuer: this.issuer,
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
      };
    } catch (error) {
      throw new UnauthorizedException("Invalid Cloudflare Access token", {
        cause: error,
      });
    }
  }
}
