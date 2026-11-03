# GQuants Agent (Telegram bot). Node only. `tar` is not needed any more: repo
# snapshots are read in-process from GitHub's tarball.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY docs ./docs
COPY scripts ./scripts
COPY evals ./evals
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
