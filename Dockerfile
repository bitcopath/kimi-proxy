FROM python:3.12-slim

# Node for the HTTP proxy; curl for CLI install + healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
      nodejs npm curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Kimi Code CLI.
# The installer puts the binary under /root/.kimi-code/bin. We copy a real
# binary into /usr/local/bin so mounting /root/.kimi-code (auth/config) cannot
# accidentally hide the CLI.
ENV HOME=/root
ENV KIMI_INSTALL_DIR=/root/.kimi-code
ENV PATH="/usr/local/bin:/root/.kimi-code/bin:/usr/bin:/bin"
RUN curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash \
    && install -m 755 /root/.kimi-code/bin/kimi /usr/local/bin/kimi \
    && kimi --version

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh \
    && mkdir -p /app/data /app/logs

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
