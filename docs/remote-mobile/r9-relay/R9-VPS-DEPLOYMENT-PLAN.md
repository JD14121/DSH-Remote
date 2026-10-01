# R9 — VPS Deployment Plan

**Phase:** R9-RELAY-02 — **template and design only. Nothing applied.**
**Absolute rule:** no public listener may be started in this phase. `frps.production.toml` is a staged
template and **must not be launched with public binds**.

## 1. Filesystem layout

```text
/etc/r9-relay/
  frps.toml                     frps production config (from the template)
  plugin/
    admission-plugin.py         NewProxy admission service
  tls/
    frps-server.crt             frps leaf certificate (public)
    frps-server.key             frps leaf private key  — VPS-local, service-readable only

/var/log/r9-relay/
  frps.log
  plugin.log
```

### Explicitly ABSENT from the VPS

| Must never exist on the VPS | Why |
| --- | --- |
| Phone Bearer | application credential; belongs to the PC/Android boundary |
| Android issuer private key | offline operator custody |
| Android client private key | device-held |
| **HTTPS server private key** | PC only; the VPS must not hold application TLS keys |
| **ACME account key** | PC only; required for the "VPS cannot self-issue" property |
| **DNS API credential** | PC only; same reason |
| DSH credentials | unrelated to R9 |
| frpc private key | PC-side tunnel client |
| any private CA signing key | offline operator custody |

## 2. Firewall design — PREPARED, NOT APPLIED

| Direction | Port | Purpose |
| --- | --- | --- |
| inbound | **TCP 443** | frps HTTPS vhost (future exposure phase) |
| inbound | **TCP 7000** | frps control/work transport (future exposure phase) |
| other inbound | **denied** | — |

### Explicitly NOT opened

`22` (SSH — frozen), `80`, `3080`, `3081`, `9445`, `9446`, `9100`, any dashboard port, any UDP port.

**No firewall rule was added anywhere in this phase.**

## 3. Threat posture

### Port 7000 is NOT "private"

| Property | Recorded truth |
| --- | --- |
| Network reachability | **public** unless a future source-IP restriction is separately **proven** with measured stable egress and positive/negative tests |
| Usable by an attacker? | requires frp transport authentication (mTLS) **plus** the dedicated frp auth secret |
| Authority to register a proxy? | requires the NewProxy admission policy to allow it |

Authenticated usability must never be relabelled as network privacy.

### Port 443 posture

| Property | Recorded truth |
| --- | --- |
| Public TCP reachability | yes, **in a future exposure phase** |
| Application TLS | **passes through** VPS/frps |
| TLS termination | **PC bridge** |
| Client certificate validation | **PC bridge** |
| Consequence | the VPS must not possess browser application plaintext by design |

## 4. NewProxy admission on the VPS

Two options are recorded; the choice is an operator decision to be made before R9-RELAY-03.

| Option | Description | Trade-off |
| --- | --- | --- |
| **A — same service boundary** | plugin runs as a supervised unit beside frps on the VPS, bound to `127.0.0.1` | fewer moving parts; plugin lifecycle is coupled to frps supervision |
| **B — separately supervised local-only service** | plugin runs as its own unit, `127.0.0.1` only | clearer failure isolation; one more unit to supervise |

Either way the following are non-negotiable:

* the plugin listener is **never public** (bind `127.0.0.1`),
* plugin failure **fails closed**,
* plugin logs contain **no secret body** (proven behaviour from R9-RELAY-01C),
* the restart policy must not temporarily bypass NewProxy authorization.

### Lifecycle dependency (fail-closed ordering)

```text
1. start admission plugin
2. verify plugin ready (readiness probe)
3. only then start frps

If the plugin is not ready → frps is NOT started.
If the plugin dies      → registration must fail closed (proven in R9-RELAY-01C).
```

The stronger fail-closed equivalent is required: frps must never be accepting registrations while the
admission service is absent.

## 5. Startup and shutdown ordering

**VPS startup**

```text
validate plugin config → start admission plugin → verify plugin ready → start frps
```

**VPS shutdown (later phase)**

```text
stop frps route/service
```

Do not kill the operator's DSH, and do not stop the supervised DSH merely to disable remote transport.

## 6. Rehearsal

The production-shaped configuration was rehearsed **locally in Docker** — synthetic values, loopback
only, **zero published ports**, no `--network host`, no privileged container. See the phase report and
`docs/remote-mobile/_evidence/r9-relay-02/` for the parsed-config and registration results.

## 7. Inputs required before this plan can be applied

| Input | Status |
| --- | --- |
| VPS provider, instance, public IPv4 `R9_VPS_HOST` | `NEEDS_OPERATOR_INPUT` |
| Approved non-SSH management channel | `NEEDS_OPERATOR_INPUT` |
| Firewall change authorization | not granted |
| Explicit authorization to start public listeners | not granted |
