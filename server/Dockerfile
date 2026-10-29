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
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
# 必须在源码复制之后生成：本机可能残留旧的 src/generated。
# generate 不连接数据库；只为配置解析提供占位 URL，运行时使用部署环境值。
RUN DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused npx prisma generate

ENV NODE_ENV=production
EXPOSE 8080

# 建表（幂等）+ 播种（幂等）+ 起服务
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/seed.ts && npx tsx src/index.ts"]
