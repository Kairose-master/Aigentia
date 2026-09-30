"""x402-xrpl: XRPL x402 protocol compatibility service (facilitator + unsigned payer builder).

This service isolates the official ``x402-xrpl`` and ``xrpl-py`` SDKs behind a narrow
internal HTTP API. It never holds wallet seeds and knows nothing about the economy on
top of it.
"""

__version__ = "0.1.0"
