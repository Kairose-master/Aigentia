# services/x402-xrpl — small FastAPI service isolating the x402-xrpl / xrpl-py SDKs.
PYTHON ?= python3
VENV   ?= .venv
BIN    := $(VENV)/bin
PORT   ?= $(or $(X402_SERVICE_PORT),8402)

.PHONY: venv dev run test test-testnet lint format docker-build clean

$(BIN)/python:
	$(PYTHON) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip
	$(BIN)/pip install -r requirements-dev.txt

venv: $(BIN)/python  ## create .venv and install runtime + dev dependencies

dev: venv            ## run with auto-reload (reads repo-root .env if present)
	$(BIN)/uvicorn app.main:app --host 127.0.0.1 --port $(PORT) --reload

run: venv            ## run without reload
	$(BIN)/uvicorn app.main:app --host 0.0.0.0 --port $(PORT)

test: venv           ## unit tests (no network)
	$(BIN)/pytest -q

test-testnet: venv   ## opt-in real XRPL Testnet round trip (faucet + 1000 drops)
	X402_TESTNET_INTEGRATION=1 $(BIN)/pytest -q -s tests/test_testnet_integration.py

lint: venv           ## ruff + mypy
	$(BIN)/ruff check app tests
	$(BIN)/ruff format --check app tests
	$(BIN)/mypy app

format: venv
	$(BIN)/ruff format app tests
	$(BIN)/ruff check --fix app tests

docker-build:
	docker build -t aigentia/x402-xrpl:dev .

clean:
	rm -rf $(VENV) .pytest_cache .ruff_cache .mypy_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
