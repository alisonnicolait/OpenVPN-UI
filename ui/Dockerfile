FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates openssl net-tools easy-rsa \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev

COPY server.js /app/server.js
EXPOSE 9001
CMD ["node","/app/server.js"]
