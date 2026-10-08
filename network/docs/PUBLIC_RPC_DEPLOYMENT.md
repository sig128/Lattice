# Public RPC deployment template

The active development endpoints bind to `127.0.0.1` and are reachable only on
the machine running Lattice. They are not public developer infrastructure.

A hosted testnet deployment requires separate roles:

1. Persistent Agave validator/RPC node with the expected genesis and durable
   ledger volumes.
2. TLS reverse proxy on an explicitly configured domain for HTTP and WebSocket.
3. Method allowlist, request/body limits, per-IP quotas, connection limits, and
   WebSocket subscription limits.
4. Faucet isolated from production and restricted to a visibly labeled
   testnet. Validator admin, unsafe debug, and ledger reset methods remain
   private.
5. Independent monitor process with PostgreSQL persistence, external checks,
   backups, and alerts for wrong genesis, stalled finalization, disk growth, and
   stale observations.
6. Validator identity and voting keys outside the web application and reverse
   proxy. Bridge signing keys use a separate signer placement and policy.

Example proxy topology:

```text
developers
   │ HTTPS / WSS
   ▼
rate-limited TLS gateway
   │ private network
   ├── Agave JSON-RPC :8899
   └── Agave PubSub   :8900
```

No domain is populated until that infrastructure exists and passes genesis,
freshness, WebSocket, resource-limit, and recovery checks.
