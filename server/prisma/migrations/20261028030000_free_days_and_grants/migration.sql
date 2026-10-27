-- 免费天数 + 天数流水。
--
-- 模型变了：注册送的 30 天**不是会员**，是「免费天数」。
--   free_expire_at                 免费天数用到哪天（注册 + 邀请）
--   membership_expire_at           会员用到哪天（后台发的）
--   两者互不吞噬，权益取最大的那个。
-- 来源不再记在客户身上（一个值说不清混合来源），改由 membership_grants 记每一次加天数。

ALTER TABLE "customers" ADD COLUMN "free_expire_at" TIMESTAMP(3);

-- 老数据搬家。上一步回填出的 membership_source：
--   'trial' → 那段时间本来就是注册送的，从会员挪到免费（等级也清掉）
--   'admin' / null → 当会员保留
UPDATE "customers"
SET "free_expire_at"     = "membership_expire_at",
    "membership_expire_at" = NULL,
    "membership_level"     = 'none'
WHERE "membership_source" = 'trial';

CREATE TABLE "membership_grants" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "days" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "ref_id" INTEGER,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "membership_grants_customer_id_created_at_idx" ON "membership_grants"("customer_id", "created_at");

-- 给现有每个有到期时间的人补一条流水，别让后面「这 30 天是谁给的」从今天开始断档。
-- starts_at 用注册时间（那时还没有任何加天数记录），days 按实际跨度算。
INSERT INTO "membership_grants" ("customer_id", "days", "source", "note", "starts_at", "expires_at")
SELECT
    c."id",
    GREATEST(1, ROUND(EXTRACT(EPOCH FROM (
        COALESCE(c."free_expire_at", c."membership_expire_at") - c."created_at"
    )) / 86400)::int),
    CASE WHEN c."free_expire_at" IS NOT NULL THEN 'trial' ELSE 'admin' END,
    '历史回填',
    c."created_at",
    COALESCE(c."free_expire_at", c."membership_expire_at")
FROM "customers" c
WHERE COALESCE(c."free_expire_at", c."membership_expire_at") IS NOT NULL;

-- 来源列下线：它在流水里，客户身上留着只会有人当真
ALTER TABLE "customers" DROP COLUMN "membership_source";
