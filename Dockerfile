# Build the application in a full Node image, then ship only what runs.
#
# The runtime stage is distroless: no shell, no package manager, no busybox.
# There is nothing in the image to pivot to if the process is compromised, and
# the attack surface is the Node runtime and this application rather than a
# general purpose Linux userland.

# Built on Debian 12, the release the distroless runtime is based on. Alpine
# uses musl rather than glibc, and a native dependency compiled against one
# fails to load against the other. Nothing here is native today, which is why
# the mismatch worked, and why it would have broken the day something was.
#
# Each base image is pinned by digest, so the bytes the build runs on are the
# bytes that were reviewed, and a tag that moves under a release cannot change
# what ships. The tag stays beside the digest for the reader. Dependabot
# refreshes the digests weekly, as a pull request that CI builds and scans
# before anyone merges it.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies only, resolved separately so the dev toolchain never
# reaches the final image.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs24-debian12:latest@sha256:61f4f4341db81820c24ce771b83d202eb6452076f58628cd536cc7d94a10978b AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Declares the compiled output as ES modules. Without it Node has to detect the
# module type from syntax on every load rather than being told.
COPY package.json ./

# Distroless provides this unprivileged user. Running as root in a container
# that needs no privileges is a habit worth not having.
USER nonroot
EXPOSE 8080

# The distroless entrypoint is already node, so this is the script to run.
CMD ["dist/http/main.js"]
