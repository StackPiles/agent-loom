# SMTP loopback fixture

These are public, synthetic test credentials, never production credentials.
`certificate.pem` is a self-signed certificate for `localhost` and `127.0.0.1`,
valid from 2020 to 2045. `test-only-key.pem` is its intentionally public private key.

The transport tests bind only to `127.0.0.1` on a random port. Test subprocesses
trust this certificate through `NODE_EXTRA_CA_CERTS`; production certificate
verification and TLS settings remain enabled and unchanged. The negative tests
omit this trust and verify that authentication does not occur.
