-- 免费额度：没有权益的人每天能发几条。
--
-- 只有「没有权益」的人才落行；会员 / 免费天数未到期的人不限量、不记账。
-- day 是服务器时区的 YYYY-MM-DD，换一天就是一条新行，不需要定时任务清零。

CREATE TABLE "client_message_usage" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "day" CHAR(10) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "refunds" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_message_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_message_usage_customer_id_day_key" ON "client_message_usage"("customer_id", "day");
