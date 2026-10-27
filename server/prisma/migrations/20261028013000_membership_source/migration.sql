-- 会员来源：trial = 注册赠送的试用，admin = 后台手动发 / 续
ALTER TABLE "customers" ADD COLUMN "membership_source" TEXT;

-- 回填。手里只有「有没有过一次发会员日志」这一条线索：
--   有过 → 后台给的（多半是续费，试用已经结束）
--   其余有等级的 → 注册时送的
-- 回填不出来的（等级是 none）留 NULL，按「正式」算，不冒充试用。
UPDATE "customers" AS c
SET "membership_source" = 'admin'
WHERE EXISTS (
  SELECT 1 FROM "operation_logs" AS l
  WHERE l."action" = 'customer.membership'
    AND l."target_type" = 'customer'
    AND l."target_id" = c."id"
);

UPDATE "customers"
SET "membership_source" = 'trial'
WHERE "membership_source" IS NULL
  AND "membership_level" <> 'none';
