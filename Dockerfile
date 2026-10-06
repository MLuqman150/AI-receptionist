FROM node:20-slim

# Prisma's engine binary is picked based on the detected OpenSSL version at
# generate-time. node:20-slim doesn't have openssl installed at all, so Prisma
# can't detect it and silently guesses wrong (openssl-1.1.x) — install it
# first so detection (and the downloaded engine) is correct.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npx prisma generate
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]
