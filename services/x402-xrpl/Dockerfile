# services/x402-xrpl — XRPL x402 facilitator + payer builder (no seeds, no game logic)
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/x402-xrpl

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Never run as root inside the container.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin x402 \
    && chown -R x402:x402 /srv/x402-xrpl
USER x402

EXPOSE 8402
# X402_SERVICE_PORT may override the listen port (docker-compose sets it to 8402).
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${X402_SERVICE_PORT:-8402}"]
