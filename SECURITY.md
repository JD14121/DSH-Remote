# Security and private deployment data

Do not put credentials, private keys, P12/PFX files, Android signing keystores, personal chat histories or runtime configurations in issues or pull requests. Report only redacted diagnostics and request IDs. Public issues are unsuitable for secret material or exploit details; use GitHub private vulnerability reporting if the repository owner has enabled it, otherwise contact the owner through a private channel before sharing details.

Keep DSH and Gateway listeners on loopback. The relay is a TLS passthrough transport; application HTTPS terminates on the PC and requires a separately issued Android client certificate. FRP transport PKI is a different trust domain. Phone Access Token is an application credential, not a cloud-provider API token.

Never bypass hostname or server-certificate validation to resolve connectivity failures. If exposed credentials are discovered, revoke/rotate them before any further deployment; removing a file from the latest commit does not remove it from Git history.

This is a development project. Dependency and upstream DSH API changes require fresh compatibility review; do not assume a newer upstream version is automatically supported.
