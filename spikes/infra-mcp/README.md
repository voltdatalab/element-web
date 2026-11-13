# Local infrastructure MCP authorization laboratory

**Verdict: VALIDATED_LOCAL_SYNTHETIC — not deployed or production-ready.**

This isolated experiment proves a bounded path from a Matrix identity proof to a
separate MCP authorization. It does not grant access to live infrastructure.
The product API, Matrix identities, private conversations and existing services
are unchanged.

## What runs

`node run.ts` starts two temporary HTTP servers on `127.0.0.1` with OS-assigned
ports: a **synthetic Matrix whoami fixture** and the MCP experiment. It then:

1. Discovers protected-resource metadata and verifies the unauthenticated challenge.
2. Starts an authorization-code request with a preregistered public client and S256 PKCE.
3. Reads browser-cookie-bound consent details and submits approval using a synthetic
   Matrix session proof. The verifier resolves the exact permitted user through whoami.
4. Rejects an incorrect PKCE verifier, then exchanges the code for an MCP credential.
5. Rotates the refresh credential through the SDK's HTTP token endpoint.
6. Connects the real MCP TypeScript SDK client, lists tools and invokes `infra_status`.
7. Refuses another application's status without calling its data adapter.
8. Revokes the connection through the HTTP revocation endpoint, rejects the next
   request, and verifies that the independent synthetic Matrix session still works.

The runner asserts these results before printing `PASS_LOCAL_SYNTHETIC_MCP`. Its
status payload is deliberately invented fixture data, **not a measurement of a real
server or deployment**. The OAuth/browser steps are driven programmatically; this
is not evidence of a human login or of Claude Desktop/Code compatibility. Both
servers and the MCP client are closed before the command exits.

No LLM, remote inference, SSH, CapRover, Docker socket or production credentials are
used. Dependency installation requires the public package registry; the experiment
itself connects only to its loopback fixtures. The redirect callback is inspected,
not followed or served.

## Reproduce

Requirements: Node **22.19.0 or newer** with native TypeScript support, and Corepack.
The initial local validation used Node 22.23.2. Run from this directory:

```sh
corepack pnpm@12.11.2 --ignore-workspace install --frozen-lockfile --ignore-scripts
corepack pnpm@12.11.2 --ignore-workspace check
corepack pnpm@12.11.2 --ignore-workspace test
corepack pnpm@12.11.2 --ignore-workspace format:check
node run.ts
```

The compiler is the explicitly project-local official TypeScript 6.0.3 binary;
no global compiler fallback is used. The SDK, runtime dependencies, test runner
and formatter have exact versions and a standalone lockfile. Copy this whole
package, excluding `node_modules`, to replay outside the monorepo. No `.env`,
secrets or external configuration are needed. The CLI accepts no arguments and
prints no credentials.

## Boundaries implemented and tested

- `MatrixIdentityVerifier` uses a fixed, defensively copied homeserver URL and
  allowed-user set. HTTPS is required except for explicit literal-loopback HTTP
  opt-in. It refuses guests, redirects, malformed identities/proofs/responses,
  oversized data and slow responses. Failures do not expose upstream details.
- `LocalOAuthProvider` separates identity from user/client grants. Consent cannot
  elevate an existing grant; it requires the correct browser cookie and CSRF proof.
  Resource and redirect bindings are exact. Codes are single-use and short-lived.
- Access/refresh credentials are random and only their hashes are stored. Refresh
  rotation detects replay and revokes its family. A different client cannot revoke
  another client's family. The original Matrix proof is not stored by this provider.
- Access is checked against current grants, not only token issuance. The synchronous
  guard is used before data access and immediately after asynchronous status reads.
  Returned data must match the requested application/environment and its fixed schema.
- Host/Origin checks and generic parser failures protect the HTTP boundary. Each MCP
  request authenticates independently; a transport session ID is not authorization.
- Only `infra_status` exists. Its read-only annotation is descriptive; actual access
  control happens in code. No shell, deployment, file or DM tool is exposed.

## Deliberate limits

- State is ephemeral and single-process. Restarting loses grants and connections.
  Collections are bounded to 1,000 entries; live replay history is not evicted to
  make room. Expired entries are cleaned on access. This is not durable audit storage.
- Clients are preregistered. There is no dynamic registration, client-metadata URL
  fetching, real user-management UI or account provisioning. The callback must match
  literally, including its loopback port, before the SDK handles GET or POST errors.
  This intentionally restricted pilot does not implement native clients' ephemeral
  callback-port relaxation; real-client interoperability remains unverified.
- `/consent` currently supplies JSON details and a protected approval API, **not an
  Element login/consent screen**. The runner supplies a synthetic Matrix proof as a
  trusted frontend would. Wiring the existing Element session into a human consent
  screen remains separate work; never ask users to paste session tokens into Claude.
- `createInfraMcpApp` does not bind sockets. The runner binds only loopback. Do not
  publish this factory behind a proxy or adapt it to live backends as-is; production
  transport, identity lifecycle, persistent authorization/audit, rate/abuse controls
  and client-specific interoperability still need design, tests and review.
- This does not provision a real account or establish any real operator's permissions. Using the
  same Matrix identity later must not share another person's account, bot/admin token,
  private conversations or infrastructure credentials.
- Passing synthetic tests is not a general security certification. No live Synapse
  integration, real browser/Claude authorization, deployment, rollback, restoration,
  multi-process operation or new-server platform restoration is demonstrated here.

## Sources and next integration boundary

- [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- [Authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- The pinned SDK's `server/auth` router/middleware implement the HTTP OAuth/PKCE layer;
  this package supplies the policy, bounded in-memory state and trusted identity adapter.

The next integration boundary is the real Element consent screen plus persistence
and lifecycle of user/client grants, before connecting any real infrastructure
operation. Do not replace a restricted CapRover executor with general-purpose SSH.
