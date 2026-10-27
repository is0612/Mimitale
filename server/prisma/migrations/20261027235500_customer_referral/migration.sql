-- 邀请体系：每个客户一张自己的邀请码 + 记住是谁邀请的。
--
-- 和 invite_cards（后台发的卡密）分开：卡密是一码一次、能给任何人；
-- 自己的邀请码是一人一个、能邀很多人。两者形状一样（MIMI-XXXX-XXXX），
-- 注册时先查卡密表，查不到再查这里的 referral_code。
--
-- 老数据不在这里回填 —— 随机码在 SQL 里拼太丑，改成服务端第一次取「个人信息」时补
-- （和 voucher 的懒生成同一套路）。referral_code 允许 null 就是为了这个。

ALTER TABLE "customers" ADD COLUMN "referral_code" TEXT,
ADD COLUMN "referred_by_id" INTEGER;

CREATE UNIQUE INDEX "customers_referral_code_key" ON "customers"("referral_code");

CREATE INDEX "customers_referred_by_id_idx" ON "customers"("referred_by_id");
