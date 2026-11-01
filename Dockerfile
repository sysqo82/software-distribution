FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends smbclient python3 python3-winrm python3-requests-ntlm \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data && chown node:node /data
ENV DATA_DIR=/data
WORKDIR /app
# NTLM needs MD4, which OpenSSL 3 disables unless the legacy provider is on.
COPY remote/openssl-legacy.cnf /etc/ssl/openssl-legacy.cnf
ENV OPENSSL_CONF=/etc/ssl/openssl-legacy.cnf
COPY package.json server.js ./
COPY lib ./lib
COPY remote ./remote
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
