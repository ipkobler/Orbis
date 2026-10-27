FROM node:22-alpine
WORKDIR /app
COPY package.json server.js gateway.js liveness.js heartbeat.js alerts.js ./
COPY tools ./tools
COPY public ./public
# /state keeps the orb's device key (its approval in OpenClaw) and the shared conversation list
RUN mkdir -p /state && chown node:node /state
ENV NODE_ENV=production PORT=8080 STATE_DIR=/state
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
