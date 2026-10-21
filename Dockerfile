ARG NODE_IMAGE=node:24.19.0-bookworm-slim
ARG PYTHON_IMAGE=python:3.10.12-slim-bookworm

FROM ${NODE_IMAGE} AS node-runtime

FROM ${NODE_IMAGE} AS javascript-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE} AS javascript-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${PYTHON_IMAGE} AS runtime
ARG APP_VERSION=0.1.0
ARG IMAGE_SOURCE=not-specified
ARG IMAGE_LICENSES=UNLICENSED
LABEL org.opencontainers.image.title="Spark Control Plane" \
    org.opencontainers.image.description="Spark control plane for Declarative Pipelines" \
    org.opencontainers.image.version="${APP_VERSION}" \
    org.opencontainers.image.source="${IMAGE_SOURCE}" \
    org.opencontainers.image.licenses="${IMAGE_LICENSES}"
ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHON_EXECUTABLE=/usr/local/bin/python \
    PYSPARK_PYTHON=/usr/local/bin/python \
    PYSPARK_DRIVER_PYTHON=/usr/local/bin/python \
    CONTROL_PLANE_PORT=8080

COPY requirements.txt /tmp/requirements.txt

RUN apt-get update \
    && apt-get install --no-install-recommends --yes openjdk-17-jre-headless tini \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir --disable-pip-version-check -r /tmp/requirements.txt

WORKDIR /app
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=javascript-dependencies /app/node_modules /app/node_modules
COPY --from=javascript-builder /app/dist /app/dist
COPY package.json ./
COPY docs/openapi.json ./docs/openapi.json
COPY docker/control-plane-healthcheck.mjs ./docker/control-plane-healthcheck.mjs
COPY src/server ./src/server
COPY src/shared ./src/shared

WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "docker/control-plane-healthcheck.mjs"]
ENTRYPOINT ["tini", "--"]
CMD ["node", "--experimental-strip-types", "src/server/runtime/standaloneServer.ts"]
