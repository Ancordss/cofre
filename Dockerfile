FROM oven/bun:1-alpine

RUN apk add --no-cache su-exec

WORKDIR /app
COPY server.js ./
COPY public ./public

RUN mkdir -p /data && chown -R bun:bun /app /data

ENV PORT=3000 \
    DB_PATH=/data/app.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1

# arranca como root solo para tomar posesión del volumen, y luego baja a bun
CMD ["sh", "-c", "chown -R bun:bun /data && exec su-exec bun:bun bun run /app/server.js"]
