PHASE-R9-RELAY-02 — Resource, PKI, DNS/ACME & Deployment Configuration Preparation
0. Authority
Implementation owner:
DSH

Architecture authority:
R9-TRANSPORT-ADR-v3.md

Human authorization:
R9-RELAY-02 configuration preparation AUTHORIZED

Docker:
AUTHORIZED for this R9 phase
This authorization does not include public exposure.
Do not start R9-RELAY-03.
1. Frozen accepted baseline
R7:
ACCEPTED / FROZEN

R8:
ACCEPTED / FROZEN

R9-RELAY-00:
ACCEPTED

R9-RELAY-01:
COMPLETE / ACCEPTED

R9-RELAY-01-FRP-01:
CLOSED
Frozen services:
Operator DSH:
127.0.0.1:3080

Supervised DSH:
127.0.0.1:3081

Gateway:
127.0.0.1:9445

R9 bridge:
127.0.0.1:9446
Never expose or directly relay:
3080
3081
9445
Only the R9 bridge may eventually mediate remote traffic.
2. Scope
R9-RELAY-02 prepares the production deployment without opening it.
Allowed work:
resource inventory
provider/domain requirements
production configuration files
PKI hierarchy
key/certificate custody
DNS-01 design
CAA design
ACME account design
bridge production configuration
frpc configuration
frps configuration
NewProxy admission configuration
Docker-based isolated validation
file permissions / ACL design
release artifact pinning
rollback bundle
operator runbooks
Still forbidden:
public 443 listener
public 7000 listener
router exposure
firewall allow rule for Internet traffic
real remote Android session
production Gateway traffic over relay
R9-RELAY-03
3. Docker authorization
Docker Desktop may be started and used.
Permitted:
pull pinned images
run local validation containers
run PKI/config lint fixtures
run frps/frpc synthetic fixtures
run admission plugin fixture
Requirements:
0 published public ports
no --network host
no privileged container unless separately justified and approved
no mounting DSH credentials
no mounting .credentials.yaml
no Phone Bearer inside images
no long-lived production secret baked into images
Use immutable image references/digests where practical.
Record every image:
repository
tag
digest
purpose
Docker is a tooling/runtime aid, not automatically part of the final production architecture.
4. Human-controlled external-resource boundary
DSH must distinguish clearly between:
PREPARE
and:
APPLY
Human/account-owner actions include, unless separately authorized later:
buying a VPS
buying a domain
accepting provider billing
changing registrar account security
changing DNS delegation
creating externally visible DNS records
opening VPS firewall ports
starting public frps listeners
DSH may prepare exact instructions and configuration for these.
It must not silently perform them.
If required resource/account information is absent:
record NEEDS_OPERATOR_INPUT
and continue all provider-independent preparation possible.
Do not invent domains, VPS IPs or account IDs.
5. Required resource inventory
Produce:
docs/remote-mobile/r9-relay/resource-inventory.md
Track separately:
VPS
domain
DNS provider
registrar
public CA
Android target device
PC storage path
backup location
Each item gets one status:
AVAILABLE
SELECTED_NOT_ACQUIRED
NOT_SELECTED
NOT_REQUIRED_YET
Never mark a resource available without evidence.
6. VPS requirements
Define minimum VPS requirements.
At minimum:
public IPv4
Linux x86_64 unless a different platform is explicitly selected
ability to run pinned frps
provider console or management channel
firewall/security-group control
persistent storage for frps config/key only
automatic reboot/start capability for future phase
time synchronization
NO-SSH remains frozen.
Therefore future VPS management must have an approved non-SSH method, such as:
provider web console
provider serial/VNC console
provider management agent
Do not introduce SSH for convenience.
7. Domain requirements
Define one production FQDN placeholder variable:
R9_PUBLIC_HOST
Do not hard-code a fabricated domain.
Required future capabilities:
DNS control
CAA support
DNS-01 automation or API
least-privilege challenge credential
ability to prevent wildcard issuance
MFA on registrar/DNS account
If no domain is yet owned:
prepare templates only.
8. Four identity domains
Preserve v3's four distinct identities:
1. Public HTTPS server identity
2. Android client identity
3. frpc tunnel-client identity
4. frps tunnel-server identity
No leaf key may serve two roles.
No private CA may silently become a generic trust root for unrelated roles.
The separation and custody model are a core v3 requirement. R9-TRANSPORT-ADR-v3.mdMD
9. Production key hierarchy
Prepare a documented hierarchy.
Recommended structure:
R9 Android Client Issuer
  └── Android device leaf(s)

R9 frpc Client Issuer
  └── PC frpc leaf

R9 frps Server Issuer
  └── VPS frps leaf

Public CA
  └── HTTPS server leaf for R9_PUBLIC_HOST
The three private issuers must be separate.
Do not use the public HTTPS private key as a CA key.
10. Private CA custody
Private issuer signing keys:
MUST NOT reside on VPS
MUST NOT reside inside Docker images
MUST NOT be copied into Android
MUST NOT be placed in the application repository
Create a proposed operator-controlled storage location.
If actual CA generation is performed in this phase:
generate offline/local only
encrypt backup if retained
restrict filesystem ACL
record fingerprint/public cert
never print private key
Do not put private key material in evidence JSON or Markdown.
11. Public HTTPS server key
The eventual browser-facing private key belongs on the PC bridge host.
Prepare its path and ACL design.
Expected property:
bridge service identity:
READ

ordinary users:
NO READ unless explicitly required

VPS:
NO COPY

Docker image:
NO COPY
If no real domain exists yet:
prefer generating a CSR/template workflow rather than obtaining the live public certificate.
Do not fabricate issuance success.
12. Android client identity
Prepare production enrollment model.
Requirements:
unique key per Android device
unique serial
clientAuth EKU
device-specific active enrollment record
fingerprint binding
short-lived leaf target
v3 currently proposes a maximum 30-day private leaf validity; treat this as a design parameter unless a later operational test demonstrates it is impractical. R9-TRANSPORT-ADR-v3.mdMD
Do not install the production certificate on the phone yet unless separately authorized for the Android integration phase.
13. frpc identity
Prepare a dedicated frpc client certificate.
Purpose only:
PC frpc → frps transport authentication
Do not reuse:
Phone certificate
Phone Bearer
HTTPS server certificate
Generate/store according to the dedicated tunnel-client trust domain.
14. frps identity
Prepare a dedicated frps server certificate.
The PC/frpc must eventually validate:
issuer
serverAuth EKU
expected name
validity
Never set:
skip verification
insecure verification
15. Dedicated frp application auth
frp's application/auth material is an additional secret.
Generate a dedicated value if production-prep credentials are authorized by the current local phase.
Requirements:
not Phone Bearer
not TLS private key
not CA secret
not reused elsewhere
Store separately.
No secret value in reports.
Evidence may record only:
exists=true
length/category
fingerprint/hash where safe
16. frp v0.71.0 production pin
Current accepted candidate:
frp v0.71.0
Reuse the already validated release unless new evidence requires otherwise.
Pin:
Windows amd64 artifact
Linux amd64 artifact
official checksum manifest
Record full SHA-256 values already verified.
Do not automatically move to a newer frp release during R9-RELAY-02.
A version change requires explicit compatibility review because admission behavior was proven against 0.71.0.
17. Linux frps production configuration
Prepare:
config/r9/frps.production.toml
or repository-conventional equivalent.
It must not be launched publicly.
Design for:
bind/control port: 7000
HTTPS vhost: 443
no HTTP vhost
no dashboard
no SSH tunnel gateway
no KCP
no QUIC
no UDP proxy
no subdomain wildcard
no unnecessary features
Do not add 0.0.0.0 merely for fixture validation.
The production template may express the eventual VPS bind semantics, but it remains an unapplied template.
18. NewProxy admission service
Carry forward the proven R9-RELAY-01C policy.
Default:
DENY
Permit only the approved production shape:
exact proxy name
proxy_type = https
exact R9_PUBLIC_HOST
no extra domain
no subdomain
no group/groupKey
no alternate proxy
Continue using:
[[httpPlugins]]
ops = ["NewProxy"]
for the pinned frp version.
Do not revert to the disproven serverPlugin assumption.
19. Admission plugin production ownership
Decide whether the production admission plugin runs:
inside the same VPS service boundary
or
as a separately supervised local-only service on the VPS
Either way:
plugin listener must not be public
plugin failure must fail closed
plugin logs contain no secret body
restart policy must not temporarily bypass NewProxy authorization
Document the exact lifecycle dependency:
plugin ready
→ frps may start accepting registrations
or a stronger fail-closed equivalent.
20. frpc production configuration
Prepare:
config/r9/frpc.production.toml
or equivalent.
Requirements:
outbound to R9_VPS_HOST:7000
transport TLS/mTLS
exact frps server validation
dedicated frp auth
one proxy only
proxy type https
local target 127.0.0.1:9446
customDomains = [R9_PUBLIC_HOST]
Never target:
9445
3081
3080
21. PC bridge production configuration
Prepare production config for:
127.0.0.1:9446
Include explicit paths/placeholders for:
HTTPS server cert
HTTPS private key
Android-client issuer
enrollment policy
denylist
static UI artifact
fixed upstream 127.0.0.1:9445
external FQDN
No client-controlled upstream.
22. Static UI artifact preparation
Produce a deterministic production UI artifact from the accepted R8 source.
Do not use:
npm run ui:dev
8099
ADB reverse
Create or document:
artifact path
manifest
file hashes
version identifier
build/copy command
No UI redesign.
Preserve same-origin:
https://R9_PUBLIC_HOST/
https://R9_PUBLIC_HOST/api/...
wss://R9_PUBLIC_HOST/api/v1/events
Preserve:
connect-src 'self'
unless a concrete incompatibility is discovered.
23. DNS-01 design
Prepare a provider-independent ACME DNS-01 flow.
Required separation:
PC:
ACME client / account

DNS provider:
least-privilege DNS challenge credential

VPS:
NO DNS credential
NO ACME account key
The VPS must not be capable of independently obtaining the browser-facing certificate simply because it controls public 443.
This is a central v3 security assumption. R9-TRANSPORT-ADR-v3.mdMD
24. CAA design
Prepare exact CAA templates.
Requirements:
restrict approved CA
restrict issuance method to dns-01 where chosen CA supports it
restrict ACME account where chosen CA supports account binding
deny wildcard issuance
Do not claim these controls are active until a real DNS zone is configured and queried.
Status now may remain:
PREPARED_NOT_APPLIED
25. ACME account custody
Prepare:
account creation procedure
account key storage path
backup/recovery procedure
rotation procedure
incident response
The ACME account key:
not on VPS
not in repository
not in Docker image
26. DNS credential custody
If a future DNS API token is used, require:
only the minimum record/zone permission necessary
no registrar account password
no broad account-admin token
Do not create a real token without the relevant provider/account and operator action.
Prepare the permission matrix only.
27. Public-certificate issuance workflow
Design:
PC generates key
→ PC creates ACME order
→ DNS-01 challenge
→ DNS provider receives temporary challenge record
→ CA validates
→ certificate stored on PC
→ challenge removed
→ bridge atomically reloads cert
No HTTP-01.
No TLS-ALPN-01.
No wildcard certificate.
28. Revocation material
Prepare production durable storage for:
active Android enrollment allowlist
issuer/key-id/serial denylist
fingerprint binding
monotonic generation
Do not populate with real phone certificate until appropriate.
Missing/corrupt state remains fail-closed.
29. Filesystem ACL preparation
On Windows, prepare ACL plan for at least:
public HTTPS private key
Android issuer trust material
Android enrollment/denylist
frpc private key
frps trust anchor
frp auth secret
ACME account key
DNS credential
Do not inherit permissive ACLs blindly.
Record intended principals and rights.
Never include secret content.
30. Secret separation audit
Create a machine-readable audit proving no credential reuse across:
Phone Bearer
HTTPS server key
Android client key
Android CA key
frpc key
frpc issuer key
frps key
frps issuer key
frp application auth
ACME account key
DNS API credential
Use fingerprints/identifiers only.
No raw secret.
31. VPS filesystem layout
Prepare a production layout such as:
/etc/r9-relay/frps.toml
/etc/r9-relay/plugin/...
/etc/r9-relay/tls/frps-server.*
/var/log/r9-relay/...
Exact paths may follow chosen distro convention.
VPS must contain only what it needs.
Explicitly absent:
Phone Bearer
Android issuer private key
Android client private key
HTTPS server private key
ACME account key
DNS API credential
DSH credentials
32. VPS firewall design
Prepare but DO NOT APPLY.
Future allowed public inbound surface:
TCP 443
TCP 7000
Nothing else for R9.
Do not open:
22
80
3080
3081
9445
9446
9100
dashboard ports
Management uses the separately approved provider management channel.
33. 7000 threat posture
Do not call 7000 “private”.
Record:
network reachable:
public, unless future source-IP restriction is separately proven

usable:
requires frp transport authentication + dedicated auth

NewProxy authority:
requires admission plugin policy
This distinction remains frozen from v3.
34. 443 threat posture
Record:
public TCP reachability:
yes, in future exposure phase

application TLS:
passes through VPS/frps

TLS termination:
PC bridge

client certificate validation:
PC bridge
The VPS must not possess browser application plaintext by design.
35. No public listeners during R9-RELAY-02
This is absolute.
Even if a real VPS already exists:
do not start frps on public 443
do not start frps on public 7000
do not add firewall allow rules
Config files may be staged offline only after explicit account authorization.
If there is any ambiguity:
STOP BEFORE EXPOSURE
36. Local deployment rehearsal
Use Docker/isolated local environments to rehearse the production config.
Allowed:
synthetic FQDN
fixture certificates
loopback-only mappings
private container networks
Required checks:
config parses
frps starts locally
plugin starts locally
frpc authenticates
approved proxy registers
unauthorized proxy rejected
bridge config loads
no production Gateway contacted
No host-published public ports.
37. Production-secret dry-run separation
If actual production keys are generated during this phase:
do not mount them into general-purpose test containers unnecessarily.
For parser/config rehearsal, use test credentials.
Production secrets should be used only for:
ACL validation
fingerprint inventory
certificate metadata validation
where possible.
38. Startup ordering design
Prepare a deterministic future order.
PC side:
validate clock
validate certificates
load durable revocation policy
start bridge 127.0.0.1:9446
verify bridge ready
start frpc
VPS side:
validate plugin config
start admission plugin
verify plugin ready
start frps
Do not make R9 start R7.
R7 lifecycle remains independently authoritative.
39. Shutdown ordering design
PC emergency stop:
stop bridge admission
close owned R9 sessions
stop frpc
verify 9446 free
VPS later:
stop frps route/service
Do not kill operator DSH.
Do not stop supervised DSH merely to disable remote transport.
40. Rollback bundle
Create an R9 rollback runbook.
Must restore:
Gateway loopback-only
DSH loopback-only
no frpc running
no bridge running
no public relay
R8 local/USB workflow intact
Do not use “delete DNS” as immediate revocation.
41. Lost-phone runbook
Prepare:
remove Android enrollment
activate denylist generation
close identity-owned connections
rotate/revoke R6 bearer using existing supported procedure
issue fresh phone identity only after explicit approval
Do not modify R6 semantics.
42. Tunnel-key compromise runbook
Prepare separately:
revoke/replace frpc trust
terminate old control/work connection
rotate dedicated frp auth
keep Android identity untouched
Credential roles must remain independent.
43. VPS-compromise runbook
Document:
stop trusting VPS tunnel server
rotate frps identity
rotate dedicated frp auth
review DNS/CAA/CT
verify HTTPS server key was never on VPS
verify ACME/DNS credentials were never on VPS
rebuild VPS from clean image
Do not restore compromised keys.
44. DNS/registrar compromise runbook
Document separately because it is not the same as VPS compromise.
Include:
account recovery
MFA reset/rotation
DNS audit
CAA restore
certificate issuance audit
CT review
server certificate rotation if needed
Phone Bearer incident response if malicious UI may have captured it
45. Certificate expiry behavior
Prepare fail-closed behavior.
No:
expired certificate fallback
self-signed browser fallback
HTTP fallback
skip verification
Expired credentials mean remote access stops.
Local R7/R8 remains functional.
46. Time dependency
TLS and certificate validity depend on clock correctness.
Document:
Windows time source
VPS time source
clock-skew failure behavior
Do not invent relaxed validity windows.
47. Observability design
Prepare sanitized event codes for:
bridge started/stopped
frpc connected/disconnected
frps registration allowed/denied
client identity accepted/revoked
certificate nearing expiry
policy generation loaded
ACME renewal success/failure
Never log:
Authorization
Phone Bearer
WS ticket
private key
DNS token
ACME account key
request body
upload contents
48. Resource-limit production proposal
Promote the fixture-tested bridge limits into a proposed production table.
Do not silently freeze them yet.
Record:
fixture value
proposed production value
reason
future measurement needed
Performance remains unmeasured until later relay phases.
49. Android status
Do not perform real Android client-certificate integration yet.
Keep:
Android KeyChain:
NOT_RUN

real HTTPS/WSS browser test:
NOT_RUN
Those belong to R9-RELAY-04.
50. Tailscale status
Tailscale remains installed/enrolled but outside the serving path.
Do not enable:
Serve
Funnel
routes
exit node
Tailscale SSH
No need to uninstall it.
51. R7/R8 protection
Do not modify frozen contracts.
Before/after record:
operator DSH 3080
supervised DSH 3081
Gateway 9445
No public reachability.
Run full regression after all local rehearsal containers/processes are gone.
52. A1–A9 status discipline
Do not overclaim.
At R9-RELAY-02 completion, likely status is approximately:
A1 TLS:
fixture PASS / production NOT_RUN

A2 end-to-end boundary:
PARTIAL

A3 tunnel:
fixture PASS / public path NOT_RUN

A4 routing:
fixture PASS

A5 frozen auth:
PARTIAL

A6 revocation:
fixture PASS

A7 resources:
fixture PASS

A8 recovery:
NOT_RUN or preparation only

A9 custody/issuance:
DESIGN/PREPARED, not production PASS
Actual report must reflect evidence, not this expectation.
53. Required artifacts
Create or equivalent project-conventional paths:
docs/remote-mobile/r9-relay/R9-RESOURCE-INVENTORY.md
docs/remote-mobile/r9-relay/R9-PKI-AND-CUSTODY.md
docs/remote-mobile/r9-relay/R9-DNS-ACME-PLAN.md
docs/remote-mobile/r9-relay/R9-VPS-DEPLOYMENT-PLAN.md
docs/remote-mobile/r9-relay/R9-PC-DEPLOYMENT-PLAN.md
docs/remote-mobile/r9-relay/R9-INCIDENT-AND-ROLLBACK.md
Prepare config templates:
config/r9/frps.production.toml
config/r9/frpc.production.toml
config/r9/bridge.production.*
config/r9/newproxy-policy.*
Use placeholders for external values.
No real secrets in repository.
54. Evidence directory
Create:
docs/remote-mobile/_evidence/r9-relay-02/
Evidence should include sanitized records for:
resource status
frp artifact pinning
Docker image digests
PKI role/fingerprint separation
key ACL checks
secret-reuse audit
config parse validation
local rehearsal
listener inventory
VPS file-manifest design
DNS/CAA templates
ACME custody design
static UI manifest
rollback validation
regression
No private keys or secret values.
55. Required report
Create:
PHASE-R9-RELAY-02-REPORT.md
Answer explicitly:
Was Docker used?
For what?
Were any Docker ports published?

What VPS was selected?
Was it actually acquired?
If not, status?

What domain was selected?
Was it actually acquired?
If not, status?

What DNS provider is planned?

What public CA is planned?

Were four independent identity roles prepared?

Were any keys reused?

Where does each private key live?

Did any application/DNS/CA private secret reach the VPS?

Was a production HTTPS key generated?
Was a real public certificate issued?

Was DNS-01 actually configured or only prepared?

Was CAA actually applied or only prepared?

Can the VPS obtain a browser-trusted certificate by itself?

Expected design answer:
NO.

What exact frps production config was prepared?

What exact frpc production config was prepared?

Does frpc target only bridge9446?

Can the production admission policy authorize only the single expected proxy/domain?

Was the configuration rehearsed locally?

Were any public listeners created?

Expected:
NO.

Were any firewall rules changed?

Expected:
NO.

Was production Gateway contacted through frp?

Expected:
NO.

Were R7/R8 modified?

Expected:
NO.

Did full regression remain green?

Which A1–A9 gates remain PARTIAL/NOT_RUN?

What human inputs are still required before R9-RELAY-03?
56. PASS criteria
R9-RELAY-02 may pass only if:
resource requirements explicit
missing resources honestly recorded

four identity roles separated

secret custody model complete

no secret reuse

VPS cannot independently obtain application certificate by design

DNS-01/CAA/ACME plan concrete

production bridge/frpc/frps/plugin configs prepared

all configs locally validated where possible

static UI production artifact strategy prepared

incident/rollback procedures prepared

no public listener

no public firewall opening

no real production relay traffic

R7/R8 unchanged

regression green
A missing unpurchased VPS/domain does not justify inventing configuration values.
Whether it blocks final R9-RELAY-02 acceptance depends on whether the phase has reached only:
PREPARATION COMPLETE
or actual:
RESOURCE PREPARATION COMPLETE
State this precisely.
57. Success state — if resources are actually ready
R9-RELAY-02 COMPLETE

RESOURCE / PKI / DNS / DEPLOYMENT PREPARATION ACCEPTED

PUBLIC EXPOSURE REMAINS CLOSED

R7/R8 REMAIN FROZEN

R9-RELAY-03 REQUIRES EXPLICIT HUMAN AUTHORIZATION

STOPPING HERE.
58. Partial success — if VPS/domain/account inputs are absent
R9-RELAY-02 PREPARATION COMPLETE

EXTERNAL RESOURCE INPUTS REQUIRED

NO PUBLIC EXPOSURE CREATED

R9-RELAY-03 NOT AUTHORIZED

STOPPING HERE.
This is not a failure if all provider-independent preparation is complete.
It simply means the external resource gate remains open.
59. Failure state
R9-RELAY-02 BLOCKED

DOCUMENT THE SPECIFIC SECURITY OR CONFIGURATION GAP

DO NOT CREATE PUBLIC EXPOSURE

DO NOT START R9-RELAY-03

STOPPING HERE.