# 没有构建步骤 —— tsx 直接跑 TypeScript。
# 换来的好处：镜像里不会出现 dist/ 和源码对不上这种问题。

FROM node:22-slim

# Prisma 的查询引擎依赖 openssl
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

# 建表（幂等）+ 播种（幂等）+ 起服务
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/seed.ts && npx tsx src/index.ts"]
