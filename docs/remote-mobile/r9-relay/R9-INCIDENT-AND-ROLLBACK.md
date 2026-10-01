# R9 — Incident Response and Rollback

**Phase:** R9-RELAY-02 (procedures prepared, none exercised)
**Principle:** every runbook here restores a **known-safe local state**. Local R7/R8 must remain
functional throughout, because losing remote access is never a reason to lose local access.

## 1. Rollback bundle

Restores the state where R9 is inert and R7/R8 are untouched.

| Step | Action | Verify |
| --- | --- | --- |
| 1 | stop frpc | no frpc process |
| 2 | stop the bridge | `127.0.0.1:9446` free |
| 3 | stop frps on the VPS (if ever started) | no public relay listener |
| 4 | confirm Gateway remains loopback-only | `127.0.0.1:9445` listening, not publicly reachable |
| 5 | confirm DSH remains loopback-only | `127.0.0.1:3080` and `:3081` listening locally |
| 6 | confirm the R8 local/USB workflow is intact | local UI path works without the relay |

**Do not use "delete DNS" as immediate revocation.** Removing a DNS record is slow, cache-dependent
and does not stop an already-authenticated session. Revocation is enforced at the PC bridge.

## 2. Lost-phone runbook

```text
1. remove the Android enrollment record from the PC active allowlist
2. advance the denylist generation (issuer / serial / fingerprint binding)
3. close all connections owned by that identity (bridge does this on policy activation)
4. rotate/revoke the R6 bearer using the EXISTING supported procedure
5. issue a fresh phone identity only after explicit operator approval
```

**Do not modify R6 semantics.** The bearer rotation uses the procedure that already exists; R9 does
not invent a new cancellation side effect.

A lost phone may hold **both** the client certificate and the Phone Bearer. Treat both as compromised.

## 3. Tunnel-key compromise runbook (frpc key)

Kept separate from the phone case because the credential roles are independent.

```text
1. revoke/replace frpc trust (replace the tunnel-client issuer trust anchor or leaf authorization)
2. terminate the old control/work connection at frps
3. rotate the dedicated frp auth secret
4. leave the Android identity untouched
```

frpc compromise attacks tunnel **registration**; it does not by itself decrypt application TLS or
compromise the Android identity. Credential roles stay independent.

## 4. VPS-compromise runbook

```text
1. stop trusting the VPS tunnel server (remove/replace the frps issuer trust on the PC)
2. rotate the frps identity
3. rotate the dedicated frp auth secret
4. review DNS records, CAA, and Certificate Transparency logs
5. VERIFY the HTTPS server key was never on the VPS
6. VERIFY the ACME account key and DNS credential were never on the VPS
7. rebuild the VPS from a clean image
8. do NOT restore compromised keys
```

Step 5 and 6 are the reason the DNS-01 design exists: **by design the VPS never held those
credentials**, so VPS compromise does not yield the ability to issue for `R9_PUBLIC_HOST`.

## 5. DNS / registrar compromise runbook

**Distinct from VPS compromise** and documented separately, because the attacker capability differs.

```text
1. account recovery with the registrar/DNS provider
2. MFA reset and rotation
3. full DNS audit (records, delegation, nameservers, unknown changes)
4. restore the intended CAA records
5. certificate issuance audit — check CT logs for unexpected certificates
6. review Certificate Transparency for the name
7. rotate the server certificate if any unexpected issuance occurred
8. if a malicious UI may have captured the Phone Bearer, run bearer incident response
```

A DNS/registrar compromise can redirect traffic and obtain certificates; it does **not** by itself
yield the HTTPS private key, the Android identity, or the tunnel credential.

## 6. Filesystem ACL plan (Windows)

Intended principals and rights. **Not yet applied** — no production key exists yet.

| Material | Principal | Right |
| --- | --- | --- |
| HTTPS server private key | bridge service identity | READ |
| HTTPS server private key | Administrators / SYSTEM | FULL |
| HTTPS server private key | ordinary users | **NO ACCESS** |
| Android issuer trust material | bridge service identity | READ |
| Android enrollment + denylist | bridge service identity | MODIFY (durable state) |
| frpc private key | frpc service identity | READ |
| frps trust anchor | frpc service identity | READ |
| frp auth secret | frpc service identity | READ |
| ACME account key | ACME client identity | READ/WRITE |
| DNS credential | ACME client identity | READ |
| All of the above | VPS | **NO COPY** |
| All of the above | Docker images | **NO COPY** |

**Do not inherit permissive ACLs blindly.** Each path must have inheritance reviewed and explicit
entries set, because a directory created under a permissive parent inherits that parent's grants.

## 7. Certificate expiry behaviour

Fail-closed, with no exceptions:

| Forbidden | |
| --- | --- |
| expired-certificate fallback | **no** |
| self-signed browser fallback | **no** |
| HTTP fallback | **no** |
| skip verification | **no** |

Expired credentials mean **remote access stops**. **Local R7/R8 remains functional.**

## 8. Observability — sanitized event codes

| Event code | Meaning |
| --- | --- |
| `bridge_started` / `bridge_stopped` | bridge lifecycle |
| `frpc_connected` / `frpc_disconnected` | tunnel client state |
| `registration_allowed` / `registration_denied` | frps NewProxy decision |
| `identity_accepted` / `identity_revoked` | client identity decision |
| `cert_expiring` | certificate nearing expiry |
| `policy_generation_loaded` | durable policy generation |
| `acme_renewal_success` / `acme_renewal_failure` | certificate renewal |

### Never logged

`Authorization` header, Phone Bearer, WS ticket, any private key, DNS token, ACME account key,
request bodies, upload contents. (R9-RELAY-01C proved the admission plugin logs no request body; the
bridge makes the same guarantee.)

## 9. Outstanding operator inputs

| Input | Blocks |
| --- | --- |
| Encrypted offline backup location | private issuer generation |
| Incident contact details | CAA `iodef` |
| Approved non-SSH VPS management channel | VPS operations |
