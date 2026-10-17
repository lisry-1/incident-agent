FROM node:24.22.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY worker.mjs model-state.mjs ./
USER 65532:65532
CMD ["node", "/app/worker.mjs"]
