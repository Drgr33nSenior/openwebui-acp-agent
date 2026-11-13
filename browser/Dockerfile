FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /opt/openwebui-browser
ENV PLAYWRIGHT_BROWSERS_PATH=0
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit \
    && node node_modules/playwright/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm
COPY index.mjs worker.mjs server.mjs connection.mjs settings.mjs allowed-tools.json ./
RUN mkdir -p /workspace && chmod -R a-w /opt/openwebui-browser
USER node
WORKDIR /workspace
EXPOSE 8931
ENTRYPOINT ["node", "/opt/openwebui-browser/index.mjs", "--http"]
