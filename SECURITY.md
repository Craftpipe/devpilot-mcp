# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email us at **security@heijnesdigital.com**
3. Include a description of the vulnerability and steps to reproduce
4. We will acknowledge receipt within 48 hours
5. We will provide a fix or mitigation within 7 days

## Scope

This policy applies to the latest version of this project.

## Security Model

DevPilot MCP is designed with the following security principles:

- **No stored credentials** — API tokens are read from environment variables at call time. They are never written to disk, logged, or transmitted.
- **Values masked in environment_sync** — Only env var key names are compared across environments. Values are never returned or stored.
- **Local audit log** — The Pro audit trail is a local SQLite file. No data leaves your machine.
- **No telemetry** — DevPilot does not make any analytics or tracking requests.

We take all security reports seriously.
